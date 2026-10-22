import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, rm, writeFile, chmod, cp} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import {bindingHash, evidenceBinding, writeMetadataFile} from "../scripts/oracle-inputs.mjs";
import {archiveTechnicalReceipt, deploymentHistoryForReview, deploymentPlan, admitDeployment, admitPush, authorizationDigest, verifyDeploymentAuthorization} from "../scripts/oracle-deployment.mjs";
import {receiptSha256, stampCommitMessage, sha256} from "../scripts/oracle-review.mjs";

const execute = promisify(execFile);
const reviewer = {role: "independent-project-oracle", role_instruction_sha256: "1".repeat(64), model: "synthetic-model", ephemeral: true, ignore_user_config: true};
const reviewerMetadata = {reviewer, reviewer_metadata_sha256: sha256(`${JSON.stringify(reviewer, null, 2)}\n`)};
const effect = {id: "SYNTHETIC-PERMISSION", category: "PERMISSION_AUTHORITY", description: "Synthetic exact permission-authority behavior.", affected_paths: ["candidate.txt"], authority: null};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-deployment-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(root, ".gitignore"), "Vault/\n"); await writeFile(path.join(root, "candidate.txt"), "base\n");
  await git("add", "."); await git("commit", "-m", "Synthetic pre-policy published base");
  await git("update-ref", "refs/remotes/origin/main", await git("rev-parse", "HEAD"));
  const store = path.join(root, ".git/oracle");
  const commit = async (content, {effects = [], dispositions = [], owner = null, validation = []} = {}) => {
    await writeFile(path.join(root, "candidate.txt"), content);
    await git("add", "-A");
    const history = await deploymentHistoryForReview(root);
    const receipt = {schema: "my-crm.oracle-approval/v2", repository: "my-crm", verdict: "APPROVED", review_status: "COMPLETE", authentication_impact: Boolean(effects.length), owner_approval_status: effects.length ? "MISSING" : "NOT_REQUIRED", reviewed_tree: await git("write-tree"), base_commit: await git("rev-parse", "HEAD"), protected_deployment_effects: effects, deployment_effect_dispositions: dispositions, deployment_baseline_commit: history.baseline, deployment_history_sha256: history.sha256, deployment_history_status: history.status, recovered_deployment_commits: history.recovered_commits, input_binding: {owner, validation}, ...reviewerMetadata};
    receipt.receipt_sha256 = receiptSha256(receipt);
    await archiveTechnicalReceipt(receipt, store, path.join(root, ".git"));
    const message = path.join(root, ".git/synthetic-message"); await writeFile(message, stampCommitMessage("Synthetic reviewed source", receipt));
    await git("commit", "-F", message);
    return {receipt, commit: await git("rev-parse", "HEAD"), archive: path.join(store, "technical-receipts", `${receipt.receipt_sha256}.json`)};
  };
  return {root, git, store, commit};
}

test("ordinary repairs deploy without human approval and preserve exact technical custody", async (t) => {
  const f = await fixture(t); const release = await f.commit("ordinary correction\n");
  assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
  const receipt = JSON.parse(await readFile(release.archive)); receipt.summary = "changed archive";
  await writeFile(release.archive, JSON.stringify(receipt));
  await assert.rejects(admitDeployment({root: f.root}), /digest/);
});

test("history traversal reuses each verified commit and rejects changed cached dependency closure", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "Vault/docs"), {recursive: true});
  await mkdir(path.join(f.root, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(f.root, "AGENTS.md"), "Synthetic history fixture policy.\n");
  await writeFile(path.join(f.root, "Vault/docs/CONSTITUTION.md"), "Synthetic history fixture constitution.\n");
  await writeFile(path.join(f.root, ".agents/skills/oracle/SKILL.md"), "Synthetic isolated approver policy.\n");
  await cp(new URL("../scripts", import.meta.url), path.join(f.root, "scripts"), {recursive: true});
  await cp(new URL("../package.json", import.meta.url), path.join(f.root, "package.json"));
  await cp(new URL("../node_modules", import.meta.url), path.join(f.root, "node_modules"), {recursive: true, dereference: true});
  await writeFile(path.join(f.root, ".gitignore"), "Vault/\nnode_modules/\n");
  await writeFile(path.join(f.root, "candidate.txt"), "first reviewed source\n"); await f.git("add", ".");
  const capture = await execute(process.execPath, [fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url)), "validate", "--input", "candidate.txt", "--", process.execPath, "-e", "console.log('synthetic history proof')"], {cwd: f.root});
  const proofRef = capture.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1].trim(), proof = JSON.parse(await readFile(proofRef.slice(1)));
  const first = await f.commit("first reviewed source\n", {validation: [await evidenceBinding(f.root, proofRef)]});
  const unsealed = async label => {await writeFile(path.join(f.root, "candidate.txt"), label);await f.git("add", ".");await f.git("commit", "-m", label);return f.git("rev-parse", "HEAD");};
  const unknown = await unsealed("synthetic recovered source one"), second = await f.commit("second reviewed source\n");
  const laterUnknown = await unsealed("synthetic recovered source two"), third = await f.commit("third reviewed source\n");
  assert.deepEqual(second.receipt.recovered_deployment_commits.map(item => item.commit), [unknown]);
  assert.deepEqual(third.receipt.recovered_deployment_commits.map(item => item.commit), [unknown, laterUnknown]);
  const bin = path.join(f.store, "history-bin"), log = path.join(f.store, "history-git.log"), control = path.join(f.store, "history-damage.json"); await mkdir(bin);
  await writeFile(path.join(bin, "package.json"), '{"type":"commonjs"}\n');
  const actualGit = (await execute("which", ["git"])).stdout.trim();
  await writeFile(path.join(bin, "git"), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args.join(' ')===${JSON.stringify(`rev-parse --verify --end-of-options ${second.commit}^{commit}`)}&&fs.existsSync(${JSON.stringify(control)})){
 const value=JSON.parse(fs.readFileSync(${JSON.stringify(control)}));fs.unlinkSync(${JSON.stringify(control)});
 if(value.action==='missing')fs.unlinkSync(value.path);else if(value.action==='custody')fs.chmodSync(value.path,0o640);else if(value.action==='directory')fs.chmodSync(value.path,0o750);else {fs.mkdirSync(require('node:path').dirname(value.path),{recursive:true});fs.writeFileSync(value.path,value.bytes);}
}
try{process.stdout.write(cp.execFileSync(${JSON.stringify(actualGit)},args));}catch(error){if(error.stderr)process.stderr.write(error.stderr);process.exitCode=error.status??1;}
`); await chmod(path.join(bin, "git"), 0o700);
  const entry = new URL(`file://${path.join(f.root, "scripts/oracle-deployment.mjs")}`).href;
  const invoke = () => execute(process.execPath, ["--input-type=module", "-e", `import {deploymentHistoryForReview} from ${JSON.stringify(entry)};try{const value=await deploymentHistoryForReview(process.cwd());console.log(JSON.stringify({sha256:value.sha256,status:value.status,history:value.history.length,unverified:value.unverified_commits.length,recovered:value.recovered_commits}));}catch(error){console.error(error.code+': '+error.message);process.exitCode=1;}`], {cwd: f.root, env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`}});
  const valid = JSON.parse((await invoke()).stdout); assert.equal(valid.status, "READY"); assert.equal(valid.history, 3); assert.equal(valid.unverified, 0);
  const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  for (const commit of [first.commit, unknown, second.commit, laterUnknown, third.commit]) assert.equal(calls.filter(args => args.join(" ") === `rev-parse --verify --end-of-options ${commit}^{commit}`).length, 1, "Each immutable commit is verified once within the actual nested traversal");
  const module = path.join(f.root, "scripts/oracle-deployment.mjs"), policy = path.join(f.root, "scripts/oracle-policy.mjs"), absence = path.join(f.store, "committed-receipts", `${unknown}.json`);
  for (const [kind, filename, action] of [["receipt", first.archive, "content"], ["missing", first.archive, "missing"], ["custody", first.archive, "custody"], ["directory-custody", path.dirname(first.archive), "directory"], ["record", proofRef.slice(1), "content"], ["nested-output", proof.output_file, "content"], ["source", module, "content"], ["policy", policy, "content"], ["absence", absence, "content"]]) await t.test(kind, async () => {
    const directoryMode = kind === "directory-custody", existed = await readFile(filename).catch(error => {if (["ENOENT", "EISDIR"].includes(error.code)) return null;throw error;});
    const bytes = kind === "source" || kind === "policy" ? existed.toString()+"\n// synthetic arrived verifier source\n" : "changed synthetic immutable history dependency";
    await writeFile(control, JSON.stringify({path: filename, action, bytes}));
    await assert.rejects(invoke(), error => /ORACLE_EVIDENCE_INTEGRITY|ORACLE_INPUT_DRIFT|custody|regular file|symbolic link/.test(error.stderr));
    if (existed) {await writeFile(filename, existed);await chmod(filename, kind === "source" || kind === "policy" ? 0o644 : 0o600);} else if (directoryMode) await chmod(filename, 0o700); else await rm(filename);
  });
  assert.deepEqual(JSON.parse((await invoke()).stdout), valid, "A fresh intact invocation verifies and recovers the same exact frontier after restoration");
});

test("missing deployment authority leaves technical receipt immutable and blocks only mutation", async (t) => {
  const f = await fixture(t); const release = await f.commit("protected authority behavior\n", {effects: [effect]});
  const before = await readFile(release.archive);
  await assert.rejects(admitDeployment({root: f.root}), /exact human authority/);
  assert.deepEqual(await readFile(release.archive), before);
  const plan = await deploymentPlan({root: f.root});
  await mkdir(path.join(f.root, "Vault/tmp"), {recursive: true});
  const authorityFile = path.join(f.root, "Vault/tmp/synthetic-owner.txt"), quote = "I authorize the exact synthetic permission-authority effect.";
  await writeFile(authorityFile, quote);
  const owner = await evidenceBinding(f.root, `@${authorityFile}`);
  const record = {schema: "my-crm.deployment-authorization/v1", decision: "AUTHORIZED", target_tree: plan.tree, technical_receipt_sha256: plan.receipt.receipt_sha256, plan_sha256: plan.plan_sha256, approved_effect_keys: plan.effects.map(({key}) => key), authority: {evidence: authorityFile, quote}, owner_evidence: owner, ...reviewerMetadata};
  record.authorization_sha256 = authorizationDigest(record);
  const filename = path.join(f.store, "deployment-authorizations", `${plan.tree}-${plan.receipt.receipt_sha256}`, `${record.authorization_sha256}.json`);
  await writeMetadataFile(filename, JSON.stringify(record), {flag: "wx"}, {root: path.join(f.root, ".git")});
  assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
  assert.deepEqual(await readFile(release.archive), before);
  await writeFile(authorityFile, "Synthetic changed approval scope.");
  await assert.rejects(admitDeployment({root: f.root}), /human evidence changed/);
});

test("a later ordinary commit cannot mask an inherited protected effect", async (t) => {
  const f = await fixture(t); const first = await f.commit("protected\n", {effects: [effect]});
  const disposition = {receipt_sha256: first.receipt.receipt_sha256, effect_id: effect.id, disposition: "EFFECTIVE", evidence: "Current source retains the synthetic authority effect."};
  await f.commit("protected plus ordinary repair\n", {dispositions: [disposition]});
  await assert.rejects(admitDeployment({root: f.root}), /exact human authority/);
  assert.equal((await deploymentPlan({root: f.root})).effects.length, 1);
});

test("independently reviewed reversion removes an obsolete protected deployment decision", async (t) => {
  const f = await fixture(t); const first = await f.commit("protected\n", {effects: [effect]});
  await f.commit("restored ordinary behavior\n", {dispositions: [{receipt_sha256: first.receipt.receipt_sha256, effect_id: effect.id, disposition: "REVERTED", evidence: "Exact current candidate restores the original authority behavior."}]});
  assert.deepEqual((await admitDeployment({root: f.root})).protected_effects, []);
});

test("omitted inherited effects and missing archived receipts fail closed", async (t) => {
  const f = await fixture(t); const first = await f.commit("protected\n", {effects: [effect]});
  await f.commit("ordinary repair concealing protected behavior\n");
  await assert.rejects(admitDeployment({root: f.root}), /disposition every inherited/);
  await rm(first.archive);
  await assert.rejects(admitDeployment({root: f.root}), /ENOENT/);
});

test("source movement invalidates late authorization and immutable adoption history", async (t) => {
  const f = await fixture(t); const first = await f.commit("protected\n", {effects: [effect]});
  const oldPlan = await deploymentPlan({root: f.root});
  const stale = {schema: "my-crm.deployment-authorization/v1", decision: "AUTHORIZED", target_tree: oldPlan.tree, technical_receipt_sha256: first.receipt.receipt_sha256, plan_sha256: oldPlan.plan_sha256, approved_effect_keys: oldPlan.effects.map(({key}) => key), ...reviewerMetadata}; stale.authorization_sha256 = authorizationDigest(stale);
  await f.commit("protected plus repair\n", {dispositions: [{receipt_sha256: first.receipt.receipt_sha256, effect_id: effect.id, disposition: "EFFECTIVE", evidence: "Synthetic effect retained."}]});
  await assert.rejects(verifyDeploymentAuthorization(stale, await deploymentPlan({root: f.root}), f.root), /stale/);
  await writeFile(path.join(f.store, "deployment-baseline.json"), JSON.stringify({schema: "my-crm.deployment-baseline/v1", commit: await f.git("rev-parse", "HEAD")}));
  const unavailable = await deploymentHistoryForReview(f.root);
  assert.equal(unavailable.status, "UNAVAILABLE");
  assert.match(unavailable.limitation, /custody requires recovery/);
});

test("review refs remain pushable before human deployment permission", async () => {
  let calls = 0;
  const deny = async () => { calls++; throw new Error("Synthetic deployment authority missing"); };
  const sha = "1".repeat(40), previous = "2".repeat(40);
  await admitPush(`refs/heads/main ${sha} refs/heads/codex/review ${previous}\n`, {admit: deny});
  assert.equal(calls, 0);
  await assert.rejects(admitPush(`refs/heads/main ${sha} refs/heads/main ${previous}\n`, {admit: deny}), /authority missing/);
  assert.equal(calls, 1);
  await assert.rejects(admitPush(`refs/tags/v0.0.1 ${sha} refs/tags/v0.0.1 ${previous}\n`, {admit: deny}), /authority missing/);
  await assert.rejects(admitPush(`refs/heads/main ${"0".repeat(40)} refs/heads/main ${previous}\n`, {admit: deny}), /deletion/);
});

test("late authorization covers only pending effects and preserves every immutable attempt", async (t) => {
  const f = await fixture(t); await mkdir(path.join(f.root, "Vault/tmp"), {recursive: true});
  const existingFile = path.join(f.root, "Vault/tmp/existing-owner.txt"), existingQuote = "I authorize the existing synthetic credential-trust effect.";
  await writeFile(existingFile, existingQuote);
  const existing = {...effect, id: "SYNTHETIC-EXISTING", category: "CREDENTIAL_TRUST", authority: {evidence: existingFile, quote: existingQuote}};
  await f.commit("existing authorized effect plus pending authority\n", {effects: [existing, effect], owner: await evidenceBinding(f.root, `@${existingFile}`)});
  const plan = await deploymentPlan({root: f.root}), authorityFile = path.join(f.root, "Vault/tmp/new-owner.txt");
  await writeFile(authorityFile, "I authorize only the pending synthetic permission effect.");
  const make = async () => {
    const quote = await readFile(authorityFile, "utf8");
    const record = {schema: "my-crm.deployment-authorization/v1", decision: "AUTHORIZED", target_tree: plan.tree, technical_receipt_sha256: plan.receipt.receipt_sha256, plan_sha256: plan.plan_sha256, approved_effect_keys: plan.effects.filter(({effect: item}) => item.authority === null).map(({key}) => key), authority: {evidence: authorityFile, quote}, owner_evidence: await evidenceBinding(f.root, `@${authorityFile}`), ...reviewerMetadata};
    record.authorization_sha256 = authorizationDigest(record);
    const filename = path.join(f.store, "deployment-authorizations", `${plan.tree}-${plan.receipt.receipt_sha256}`, `${record.authorization_sha256}.json`);
    await writeMetadataFile(filename, JSON.stringify(record), {flag: "wx"}, {root: path.join(f.root, ".git")});
    return {filename, bytes: await readFile(filename)};
  };
  const first = await make(); assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
  await writeFile(authorityFile, "I authorize the same pending synthetic effect with this current exact decision.");
  await assert.rejects(admitDeployment({root: f.root}), /human evidence changed/);
  const second = await make(); assert.notEqual(second.filename, first.filename);
  assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
  assert.deepEqual(await readFile(first.filename), first.bytes);
});

test("published-base adoption reviews an unsealed earlier commit instead of blocking source assessment", async (t) => {
  const f = await fixture(t), base = await f.git("rev-parse", "HEAD");
  await f.git("update-ref", "refs/remotes/origin/main", base);
  await writeFile(path.join(f.root, "candidate.txt"), "earlier protected behavior without private historical receipt\n"); await f.git("add", "candidate.txt"); await f.git("commit", "-m", "Synthetic unsealed earlier implementation");
  const earlier = await f.git("rev-parse", "HEAD"), review = await deploymentHistoryForReview(f.root);
  assert.equal(review.status, "READY"); assert.equal(review.baseline, base);
  assert.deepEqual(review.unverified_commits.map(({commit}) => commit), [earlier]);
  assert.ok(review.integrated_paths.includes("candidate.txt"));
  const current = await f.commit("earlier protected behavior plus ordinary repair\n", {effects: [effect]});
  assert.equal(current.receipt.recovered_deployment_commits[0].commit, earlier);
  await assert.rejects(admitDeployment({root: f.root}), /exact human authority/);
  assert.equal((await deploymentPlan({root: f.root})).effects.length, 1);
});

test("fresh published policy needs no private archive to prepare a technical review", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "scripts")); await writeFile(path.join(f.root, "scripts/oracle-deployment.mjs"), "// Synthetic published policy marker.\n");
  await f.git("add", "."); await f.git("commit", "-m", "Synthetic published policy");
  const published = await f.git("rev-parse", "HEAD"); await f.git("update-ref", "refs/remotes/origin/main", published);
  const ready = await deploymentHistoryForReview(f.root); assert.equal(ready.status, "READY"); assert.equal(ready.baseline, published);
  await f.git("update-ref", "-d", "refs/remotes/origin/main");
  const unavailable = await deploymentHistoryForReview(f.root); assert.equal(unavailable.status, "UNAVAILABLE"); assert.equal(unavailable.baseline, null);
  assert.ok(unavailable.integrated_paths.includes("candidate.txt"));
});

test("first staged policy never adopts an unpublished HEAD without verified published source", async (t) => {
  const f = await fixture(t), published = await f.git("rev-parse", "HEAD");
  await f.git("update-ref", "-d", "refs/remotes/origin/main");
  await writeFile(path.join(f.root, "candidate.txt"), "earlier unsealed authority\n"); await f.git("add", "."); await f.git("commit", "-m", "Synthetic unpublished authority");
  const unpublished = await f.git("rev-parse", "HEAD");
  await mkdir(path.join(f.root, "scripts")); await writeFile(path.join(f.root, "scripts/oracle-deployment.mjs"), "// Synthetic first staged policy\n"); await f.git("add", ".");
  const unavailable = await deploymentHistoryForReview(f.root);
  assert.equal(unavailable.status, "UNAVAILABLE"); assert.equal(unavailable.baseline, null); assert.match(unavailable.limitation, /published origin\/main/);
  await f.git("update-ref", "refs/remotes/origin/main", published);
  const ready = await deploymentHistoryForReview(f.root); assert.equal(ready.status, "READY"); assert.equal(ready.baseline, published);
  assert.deepEqual(ready.unverified_commits.map(({commit}) => commit), [unpublished]); assert.ok(ready.integrated_paths.includes("candidate.txt"));
});

test("damaged established archive remains unavailable through fresh technical review until original recovery", async (t) => {
  const f = await fixture(t); await f.commit("first ordinary reviewed source\n");
  const second = await f.commit("second ordinary reviewed source\n"), original = await readFile(second.archive);
  const changed = JSON.parse(original); changed.summary = "Synthetic archive corruption"; await writeFile(second.archive, JSON.stringify(changed));
  const unavailable = await deploymentHistoryForReview(f.root); assert.equal(unavailable.status, "UNAVAILABLE"); assert.match(unavailable.limitation, /digest/);
  assert.equal(unavailable.recovered_commits.some(({commit}) => commit === second.commit), false);
  const technical = await f.commit("technical inspection remains available\n"); assert.equal(technical.receipt.verdict, "APPROVED"); assert.equal(technical.receipt.deployment_history_status, "UNAVAILABLE");
  await assert.rejects(admitDeployment({root: f.root}), /history binding/);
  await writeFile(second.archive, original);
  const restored = await deploymentHistoryForReview(f.root); assert.equal(restored.status, "READY");
  await f.commit("fresh whole-range readiness after original recovery\n"); assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
});

test("valid alternate same-tree receipt cannot replace current or inherited stamped custody", async (t) => {
  for (const inherited of [false, true]) {
    const f = await fixture(t); await f.commit("intact first adoption source\n");
    const protectedSource = await f.commit("protected stamped source\n", {effects: [effect]}), original = await readFile(protectedSource.archive);
    await assert.rejects(admitDeployment({root: f.root}), /exact human authority/);
    const alternate = {...protectedSource.receipt, protected_deployment_effects: [], authentication_impact: false, owner_approval_status: "NOT_REQUIRED"}; alternate.receipt_sha256 = receiptSha256(alternate);
    await archiveTechnicalReceipt(alternate, f.store, path.join(f.root, ".git"));
    assert.equal(alternate.reviewed_tree, protectedSource.receipt.reviewed_tree); assert.equal(alternate.base_commit, protectedSource.receipt.base_commit); assert.notEqual(alternate.receipt_sha256, protectedSource.receipt.receipt_sha256);
    const reverted = {receipt_sha256: protectedSource.receipt.receipt_sha256, effect_id: effect.id, disposition: "REVERTED", evidence: "Current synthetic candidate removes the earlier permission effect."};
    if (inherited) { await f.commit("ordinary verified reversion\n", {dispositions: [reverted]}); assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED"); }
    await writeFile(protectedSource.archive, await readFile(path.join(f.store, "technical-receipts", `${alternate.receipt_sha256}.json`)));
    const damaged = await deploymentHistoryForReview(f.root); assert.equal(damaged.status, "UNAVAILABLE"); assert.match(damaged.limitation, /identity.*commit stamp/);
    assert.equal(damaged.recovered_commits.some(({commit}) => commit === protectedSource.commit), false);
    await assert.rejects(admitDeployment({root: f.root}), /identity.*commit stamp/);
    const inspected = await f.commit("technical review despite damaged custody\n"); assert.equal(inspected.receipt.verdict, "APPROVED"); assert.equal(inspected.receipt.deployment_history_status, "UNAVAILABLE");
    await assert.rejects(admitDeployment({root: f.root}), /history binding/);
    await writeFile(protectedSource.archive, original);
    assert.equal((await deploymentHistoryForReview(f.root)).status, "READY");
    await f.commit("current ordinary source after verified original recovery\n", {dispositions: [reverted]});
    assert.equal((await admitDeployment({root: f.root})).status, "ADMITTED");
  }
});
