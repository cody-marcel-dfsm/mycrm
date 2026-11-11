import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {access, cp, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";

import {buildRelease, releaseDirectory} from "../scripts/build-release.mjs";
import {checkRelease, RUNTIME_VERIFICATION_TOOLS} from "../scripts/check-release.mjs";
import {installLocal, verifyNativeRuntime} from "../scripts/codex-local-install.mjs";
import {installReviewed} from "../scripts/codex-maintainer-install.mjs";
import {repositoryRoot, stableJson} from "../scripts/release-utils.mjs";
import {archiveTechnicalReceipt, deploymentHistoryForReview, admitDeployment} from "../scripts/oracle-deployment.mjs";
import {receiptSha256, stampCommitMessage, sha256} from "../scripts/oracle-review.mjs";

const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
let releaseTestQueue = Promise.resolve();

function serializedReleaseTest(name, body) {
  test(name, async (context) => {
    const previous = releaseTestQueue;
    let release;
    releaseTestQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await body(context);
    } finally {
      release();
    }
  });
}

serializedReleaseTest("release contains only My CRM-owned files and no frozen BOS artifact", async () => {
  const release = await buildRelease();
  await checkRelease();
  const product = JSON.parse(await readFile(path.join(releaseDirectory, ".bos-product.json"), "utf8"));
  assert.deepEqual(product.runtime_verification_tools, RUNTIME_VERIFICATION_TOOLS);
  assert.equal(product.runtime_verification_tools.some((name) => name.startsWith("education_center_")), false);
  assert.equal(Object.keys(release).some((key) => /bos.*(bundle|archive).*sha/i.test(key)), false);
  assert.equal(release.files.some(({path: relative}) => relative.startsWith("contracts/") || /provenance|\.tgz$|\.tar\.gz$/.test(relative)), false);
});

serializedReleaseTest("release rejects Education Center runtime-verification ownership names", async (context) => {
  await buildRelease();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-ownership-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  await cp(releaseDirectory, temporary, {recursive: true});
  const productPath = path.join(temporary, ".bos-product.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  product.runtime_verification_tools[2] = "education_center_search_leads";
  await writeFile(productPath, stableJson(product));
  await assert.rejects(checkRelease({directory: temporary}), /must not claim Education Center runtime-verification ownership names/);
});

function nativeHarness({root = repositoryRoot, directory = releaseDirectory} = {}) {
  let marketplaceAdded = false;
  let pluginAdded = false;
  const calls = [];
  const runCommand = async (args) => {
    calls.push(args);
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: marketplaceAdded ? [{name: "my-crm-local", root, marketplaceSource: {sourceType: "local", source: root}}] : []});
    if (key === `plugin marketplace add ${root}`) { marketplaceAdded = true; return stableJson({name: "my-crm-local"}); }
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@synthetic", name: "bos", version: "1.0.0", installed: true, enabled: true},
      {pluginId: "education-center@synthetic", name: "education-center", version: "1.0.0", installed: true, enabled: true},
      ...(pluginAdded ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: directory}}] : [])
    ]});
    if (key === "plugin add my-crm@my-crm-local") { pluginAdded = true; return stableJson({pluginId: "my-crm@my-crm-local", installedPath: directory}); }
    throw new Error(`Unexpected native command: ${key}`);
  };
  return {calls, runCommand};
}

serializedReleaseTest("native install verifies BOS presence without pinning BOS package bytes", async () => {
  const harness = nativeHarness();
  const result = await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory});
  assert.equal(result.bosPluginId, "bos@synthetic");
  assert.equal(result.educationCenterPluginId, "education-center@synthetic");
  assert.deepEqual(result.runtimeVerificationTools, RUNTIME_VERIFICATION_TOOLS);
  assert.equal(result.release.version, packageVersion);
  await verifyNativeRuntime({runCommand: harness.runCommand, expectedDirectory: releaseDirectory});
});

serializedReleaseTest("same-version changed My CRM bytes fail closed", async (context) => {
  await buildRelease();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-synthetic-install-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  await cp(releaseDirectory, temporary, {recursive: true});
  await writeFile(path.join(temporary, "README.md"), "tampered\n");
  const runCommand = async (args) => {
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: [{name: "my-crm-local", root: repositoryRoot, marketplaceSource: {sourceType: "local", source: repositoryRoot}}]});
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@synthetic", name: "bos", version: "1.0.0", installed: true, enabled: true},
      {pluginId: "education-center@synthetic", name: "education-center", version: "1.0.0", installed: true, enabled: true},
      {pluginId: "my-crm@my-crm-local", name: "my-crm", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}
    ]});
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand, installedDirectoryFor: () => temporary}), /bump the package version/);
});

serializedReleaseTest("protected installation admission precedes every native mutation", async () => {
  const harness = nativeHarness();
  await assert.rejects(installReviewed({plan: async () => ({action: "DELIVER"}), runCommand: harness.runCommand, admit: async () => { throw new Error("Synthetic exact deployment authority missing"); }}), /exact deployment authority missing/);
  assert.deepEqual(harness.calls, []);
});

serializedReleaseTest("fresh public checkout installs without private maintainer review metadata", async (context) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-public-checkout-")));
  context.after(() => rm(root, {recursive: true, force: true}));
  for (const name of ["package.json", "package-lock.json", "node_modules", "plugins", "clients", "scripts", "src", "examples", "config", "README.md", "LICENSE", "NOTICE"]) await cp(path.join(repositoryRoot, name), path.join(root, name), {recursive: true});
  await assert.rejects(access(path.join(root, ".git/oracle")), {code: "ENOENT"});
  const publicHelper = await import(pathToFileURL(path.join(root, "scripts/codex-local-install.mjs")).href);
  const directory = path.join(root, "dist/my-crm"), harness = nativeHarness({root, directory});
  const result = await publicHelper.installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => directory});
  assert.equal(result.release.version, packageVersion);
  assert.ok(harness.calls.some((args) => args.slice(0, 2).join(" ") === "plugin add"));
  await assert.rejects(access(path.join(root, ".git/oracle")), {code: "ENOENT"});
});

async function reviewedCheckout(context) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-reviewed-checkout-")));
  context.after(() => rm(root, {recursive: true, force: true}));
  for (const name of ["package.json", "package-lock.json", "node_modules", "plugins", "clients", "scripts", "src", "examples", "config", "README.md", "LICENSE", "NOTICE"]) await cp(path.join(repositoryRoot, name), path.join(root, name), {recursive: true});
  await writeFile(path.join(root, ".gitignore"), "dist/\nVault/\nnode_modules/\n");
  const execute = promisify(execFile), git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid");
  await git("add", "."); await git("commit", "-qm", "Synthetic published package"); await git("update-ref", "refs/remotes/origin/main", await git("rev-parse", "HEAD"));
  await writeFile(path.join(root, "README.md"), `${await readFile(path.join(root, "README.md"), "utf8")}\nSynthetic reviewed package correction.\n`); await git("add", ".");
  const history = await deploymentHistoryForReview(root);
  const reviewer = {role: "independent-project-oracle", role_instruction_sha256: "1".repeat(64), model: "synthetic-model", ephemeral: true, ignore_user_config: true};
  const receipt = {schema: "my-crm.oracle-approval/v2", verdict: "APPROVED", review_status: "COMPLETE", repository: "my-crm", reviewed_tree: await git("write-tree"), base_commit: await git("rev-parse", "HEAD"), authentication_impact: false, owner_approval_status: "NOT_REQUIRED", protected_deployment_effects: [], deployment_effect_dispositions: [], deployment_baseline_commit: history.baseline, deployment_history_sha256: history.sha256, deployment_history_status: history.status, recovered_deployment_commits: [], input_binding: {validation: []}, reviewer, reviewer_metadata_sha256: sha256(stableJson(reviewer))};
  receipt.receipt_sha256 = receiptSha256(receipt); await archiveTechnicalReceipt(receipt, path.join(root, ".git/oracle"), path.join(root, ".git"));
  const message = path.join(root, ".git/reviewed-package-message"); await writeFile(message, stampCommitMessage("Synthetic reviewed package", receipt)); await git("commit", "-q", "-F", message);
  const maintainer = await import(pathToFileURL(path.join(root, "scripts/codex-maintainer-install.mjs")).href);
  return {root, install: maintainer.installReviewed, directory: path.join(root, "dist/my-crm")};
}

serializedReleaseTest("maintainer mutations bind the built artifact and current admitted source", async (context) => {
  for (const change of ["after-admission", "after-build", "artifact", "clean"]) {
    const f = await reviewedCheckout(context), harness = nativeHarness(f); let first = true;
    const source = path.join(f.root, "src/bos/action-client.mjs"), artifact = path.join(f.directory, "src/bos/action-client.mjs");
    const mutate = async (filename) => writeFile(filename, `${await readFile(filename, "utf8")}\n// Synthetic source movement.\n`);
    const admit = async (options) => { const result = await admitDeployment(options); if (first && change === "after-admission") { first = false; await mutate(source); } return result; };
    const runCommand = async (args) => {
      const result = await harness.runCommand(args);
      if (first && ["after-build", "artifact"].includes(change) && args.slice(0, 3).join(" ") === "plugin marketplace list") { first = false; await mutate(change === "artifact" ? artifact : source); }
      return result;
    };
    const pending = f.install({admit, runCommand, installedDirectoryFor: () => f.directory});
    if (change === "clean") { const result = await pending; assert.equal(result.release.version, packageVersion); assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED"); }
    else {
      await assert.rejects(pending, /clean canonical source|differs from canonical source|artifact changed|source\/effect/);
      assert.equal(harness.calls.some((args) => args[1] === "add" || args[1] === "marketplace" && args[2] === "add"), false, `${change}: native mutation preceded source/artifact check`);
    }
  }
});

// A synthetic checkout with the real contract modules, as CI sees a candidate.
async function sealedSpecRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crm-sealed-spec-")); t.after(() => rm(root, {recursive: true, force: true}));
  const run = async (...args) => (await promisify(execFile)("git", args, {cwd: root})).stdout.trim();
  await cp(new URL("../scripts/validation-catalog.json", import.meta.url), path.join(root, "scripts/validation-catalog.json"));
  for (const name of ["validation-contract.mjs", "release-validation.mjs", "oracle-spec.mjs"]) await cp(new URL(`../scripts/${name}`, import.meta.url), path.join(root, "scripts", name));
  await writeFile(path.join(root, "package.json"), JSON.stringify({type: "module"}));
  await writeFile(path.join(root, "README.md"), "# Synthetic\n"); await writeFile(path.join(root, "source.mjs"), "export default 1;\n");
  await run("init", "-q", "-b", "main"); await run("config", "user.name", "Synthetic"); await run("config", "user.email", "synthetic@example.invalid");
  const commit = async message => { await run("add", "-A"); await run("commit", "-qm", message); return run("rev-parse", "HEAD"); };
  await commit("Synthetic baseline");
  const modules = {contract: await import(pathToFileURL(path.join(root, "scripts/validation-contract.mjs"))), release: await import(pathToFileURL(path.join(root, "scripts/release-validation.mjs"))), spec: await import(pathToFileURL(path.join(root, "scripts/oracle-spec.mjs")))};
  const selection = {change_class: "bug_fix", scope_paths: ["source.mjs", "tests/*"], categories: [{name: "sanity", tests: [], fixtures: []}, {name: "focused", tests: ["tests/source.test.mjs"], fixtures: []}], reason: "Synthetic focused repair", revision_of: null};
  const spec = base => modules.spec.buildSpec({answer: {title: "Synthetic", runtime_paths: ["source.mjs"], acceptance: [{criterion: "The source exports the corrected value.", tests: ["tests/source.test.mjs"]}], tests: [{module: "tests/source.test.mjs", purpose: "Prove the export."}], findings: []}, selection, base, engine: "codex", model: "synthetic-model", oracle: "0".repeat(64), host: "synthetic-host", time: "2026-11-11T00:00:00Z", proposal: "Synthetic proposal"});
  return {root, run, commit, modules, selection, spec};
}

test("release:check fails immediately when a non-documentation change has no sealed spec", async t => {
  const f = await sealedSpecRepository(t);
  await writeFile(path.join(f.root, "README.md"), "# Synthetic documentation change\n"); await f.commit("Documentation only");
  assert.equal(f.modules.release.assertSealedSpec(f.root), null);
  for (const name of ["source.mjs", "AGENTS.md", "CLAUDE.md", ".agents/skills/x/SKILL.md", "plugins/x/README.md"]) assert.equal(f.modules.release.documentationPath(name), false, name);
  await writeFile(path.join(f.root, "source.mjs"), "export default 2;\n"); await f.commit("Executable change without a spec");
  assert.throws(() => f.modules.release.assertSealedSpec(f.root), /Sealed Oracle spec is missing for non-documentation changes: source\.mjs/);
  const executed = [];
  await assert.rejects(f.modules.release.validateRelease({nativeEvidence: false, priorCoverage: {covered: [], invalidated: []}, execute: async argv => executed.push(argv), sealed: () => f.modules.release.assertSealedSpec(f.root)}), /missing/);
  assert.deepEqual(executed, []);
  const cli = await promisify(execFile)(process.execPath, [path.join(f.root, "scripts/release-validation.mjs")], {cwd: f.root, env: {...process.env, GITHUB_ACTIONS: ""}}).then(() => null, error => error);
  assert.equal(cli?.code, 1); assert.match(cli.stderr, /^MYCRM_RELEASE_CHECK=FAILED Sealed Oracle spec is missing/m);
});

test("release:check refuses a contract whose spec is missing or does not recompute, and runs a sealed contract's tests", async t => {
  const f = await sealedSpecRepository(t), base = await f.run("rev-parse", "HEAD");
  const {spec: _missing, ...unsealed} = f.modules.contract.sealSelection(f.root, f.selection, "Synthetic proposal", {verdict: "APPROVED"}, {spec: f.spec(base)});
  const write = async value => writeFile(path.join(f.root, "scripts/validation-selection.json"), `${JSON.stringify(value, null, 2)}\n`);
  const reseal = value => { const {contract_sha256: _old, ...body} = value; return {...body, contract_sha256: f.modules.contract.hash(body)}; };
  await write(reseal(unsealed)); await f.commit("Contract without spec");
  assert.throws(() => f.modules.release.assertSealedSpec(f.root), /Sealed Oracle spec is missing from the validation contract/);
  const tampered = f.spec(base); tampered.acceptance = ["Changed after sealing."];
  await write(reseal({...unsealed, spec: tampered})); await f.commit("Contract with a mismatched seal");
  assert.throws(() => f.modules.release.assertSealedSpec(f.root), /Seal does not recompute/);
  await rm(path.join(f.root, "scripts/validation-selection.json"));
  await write(f.modules.contract.sealSelection(f.root, f.selection, "Synthetic proposal", {verdict: "APPROVED"}, {base, spec: f.spec(base)})); await f.commit("Sealed contract");
  const contract = f.modules.release.assertSealedSpec(f.root);
  assert.equal(contract.spec.seal, f.spec(base).seal);
  const executed = [];
  await f.modules.release.validateRelease({nativeEvidence: false, priorCoverage: {covered: [], invalidated: []}, execute: async argv => executed.push(argv), sealed: () => f.modules.release.assertSealedSpec(f.root)});
  assert.deepEqual(executed, [["node", "scripts/validation-contract.mjs", "run", "--category", "sanity"], ["node", "scripts/validation-contract.mjs", "run", "--category", "focused"]]);
});
