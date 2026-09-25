import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {buildRelease, releaseDirectory} from "../scripts/build-release.mjs";
import {checkRelease} from "../scripts/check-release.mjs";
import {checkPrivacy} from "../scripts/check-privacy.mjs";
import {installLocal, verifyBosExecutableContract, verifyNativeRuntime} from "../scripts/codex-local-install.mjs";
import {importBocDependencyContract} from "../scripts/import-boc-dependency-contract.mjs";
import {importBocClientDependency} from "../scripts/import-boc-client-dependency.mjs";
import {importBosContract} from "../scripts/import-bos-contract.mjs";
import {importBosServiceConsumerContract} from "../scripts/import-bos-service-consumer-contract.mjs";
import {repositoryRoot, sha256File, stableJson} from "../scripts/release-utils.mjs";
import {buildLiveAcceptancePrompt, execFileWithClosedStdin, runLiveAcceptance} from "../scripts/verify-live-contract.mjs";

const run = promisify(execFile);
const packageVersion = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")).version;

test("privacy gate accepts reserved synthetic values and rejects identity-bearing values", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-privacy-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const fixture = path.join(temporary, "fixture.json");
  await writeFile(fixture, stableJson({email: "fixture.person@example.invalid", label: "Synthetic Fixture"}));
  await checkPrivacy({root: temporary, denylistValues: ["synthetic-forbidden-customer"]});
  await writeFile(fixture, stableJson({email: ["person", "customer.invalid.example"].join("@"), label: "synthetic-forbidden-customer"}));
  await assert.rejects(checkPrivacy({root: temporary, denylistValues: ["synthetic-forbidden-customer"]}), /non-synthetic email address|externally denied customer identifier/);
});

test("release build is deterministic, canonical, and contains no second connection", async () => {
  const first = await buildRelease();
  const checked = await checkRelease();
  const second = await buildRelease();
  assert.equal(first.content_sha256, checked.content_sha256);
  assert.equal(first.content_sha256, second.content_sha256);
  await assert.rejects(readFile(path.join(releaseDirectory, ".mcp.json")));
  await assert.rejects(readFile(path.join(releaseDirectory, ".app.json")));
  assert.equal((await readFile(path.join(releaseDirectory, ".bos-product.json"), "utf8")).includes('"connection_owner": "bos"'), true);
  const submissionManifest = JSON.parse(await readFile(path.join(releaseDirectory, ".codex-plugin/plugin.json"), "utf8"));
  const promptContracts = JSON.parse(await readFile(path.join(releaseDirectory, "contracts/my-crm/v1/marketplace-prompt-contracts.json"), "utf8"));
  assert.deepEqual(submissionManifest.interface.defaultPrompt, promptContracts.prompts.map(({text}) => text));
});

test("immutable BOS contract import validates archive, source commit, and exact inventory", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-import-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const archiveRoot = path.join(temporary, "archive/lead-director-public-contract");
  const target = path.join(temporary, "consumer/v1");
  const provenance = path.join(temporary, "consumer/import-provenance.json");
  await mkdir(path.dirname(provenance), {recursive: true});
  await cp(path.join(repositoryRoot, "contracts/bos/lead-director/v1"), archiveRoot, {recursive: true});
  await cp(path.join(repositoryRoot, "contracts/bos/lead-director/v1"), target, {recursive: true});
  const archiveManifestFile = path.join(archiveRoot, "manifest.json");
  const archiveManifest = JSON.parse(await readFile(archiveManifestFile, "utf8"));
  archiveManifest.auth_impact = "owner-approved-auth-adjacent-context-selection";
  archiveManifest.preserved_auth_contract = "oauth-login-token-grant-callback-session-unchanged";
  await writeFile(archiveManifestFile, stableJson(archiveManifest));
  await writeFile(provenance, "{}\n");
  const archive = path.join(temporary, "bundle.tgz");
  await run("tar", ["-czf", archive, "-C", path.join(temporary, "archive"), "lead-director-public-contract"]);
  const archiveSha256 = await sha256File(archive);
  const sourceRevision = "a".repeat(40);
  const imported = await importBosContract({archive, archiveSha256, sourceRevision, targetDirectory: target, provenanceFile: provenance});
  assert.equal(imported.source_revision, sourceRevision);
  assert.equal(JSON.parse(await readFile(provenance, "utf8")).archive_sha256, archiveSha256);
  await importBosContract({archive, archiveSha256, sourceRevision, check: true, targetDirectory: target, provenanceFile: provenance});
  await assert.rejects(importBosContract({archive, archiveSha256: "0".repeat(64), sourceRevision, targetDirectory: target, provenanceFile: provenance}), /does not match/);
  await assert.rejects(importBosContract({archive, archiveSha256, sourceRevision: "short", targetDirectory: target, provenanceFile: provenance}), /source revision/);

  const wrongAuthRoot = path.join(temporary, "wrong-auth/lead-director-public-contract");
  await cp(archiveRoot, wrongAuthRoot, {recursive: true});
  const wrongAuthManifestFile = path.join(wrongAuthRoot, "manifest.json");
  const wrongAuthManifest = JSON.parse(await readFile(wrongAuthManifestFile, "utf8"));
  wrongAuthManifest.auth_impact = "none";
  await writeFile(wrongAuthManifestFile, stableJson(wrongAuthManifest));
  const wrongImpactArchive = path.join(temporary, "wrong-impact.tgz");
  await run("tar", ["-czf", wrongImpactArchive, "-C", path.join(temporary, "wrong-auth"), "lead-director-public-contract"]);
  await assert.rejects(importBosContract({archive: wrongImpactArchive, archiveSha256: await sha256File(wrongImpactArchive), sourceRevision, targetDirectory: target, provenanceFile: provenance}), /exact owner-approved auth-adjacent classification/);

  wrongAuthManifest.auth_impact = "owner-approved-auth-adjacent-context-selection";
  wrongAuthManifest.preserved_auth_contract = "changed";
  await writeFile(wrongAuthManifestFile, stableJson(wrongAuthManifest));
  const wrongAuthArchive = path.join(temporary, "wrong-auth.tgz");
  await run("tar", ["-czf", wrongAuthArchive, "-C", path.join(temporary, "wrong-auth"), "lead-director-public-contract"]);
  await assert.rejects(importBosContract({archive: wrongAuthArchive, archiveSha256: await sha256File(wrongAuthArchive), sourceRevision, targetDirectory: target, provenanceFile: provenance}), /exact owner-approved auth-adjacent classification/);

  await mkdir(path.join(archiveRoot, "unexpected"));
  const extraDirectoryArchive = path.join(temporary, "extra-directory.tgz");
  await run("tar", ["-czf", extraDirectoryArchive, "-C", path.join(temporary, "archive"), "lead-director-public-contract"]);
  await assert.rejects(importBosContract({archive: extraDirectoryArchive, archiveSha256: await sha256File(extraDirectoryArchive), sourceRevision, targetDirectory: target, provenanceFile: provenance}), /unexpected directory/);

  const unsafeRoot = path.join(temporary, "unsafe");
  await mkdir(unsafeRoot);
  await symlink("/tmp", path.join(unsafeRoot, "manifest.json"));
  const unsafeArchive = path.join(temporary, "unsafe.tgz");
  await run("tar", ["-czf", unsafeArchive, "-C", unsafeRoot, "manifest.json"]);
  await assert.rejects(importBosContract({archive: unsafeArchive, archiveSha256: await sha256File(unsafeArchive), sourceRevision, targetDirectory: target, provenanceFile: provenance}), /regular files/);
});

test("immutable BOC dependency-v2 import validates public artifacts and provenance", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-boc-import-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const published = path.join(repositoryRoot, "contracts/bos-operations-center/external-product-dependency/v2");
  const schema = path.join(temporary, "dependency.schema.json");
  const contract = path.join(temporary, "dependency.md");
  const destination = path.join(temporary, "consumer/v2");
  await cp(path.join(published, "external-product-dependency.v2.schema.json"), schema);
  await cp(path.join(published, "external-product-dependency.v2.md"), contract);
  const args = {
    schema,
    schemaSha256: await sha256File(schema),
    contract,
    contractSha256: await sha256File(contract),
    sourceRevision: "b".repeat(40),
    adapterSha256: "c".repeat(64),
    bocVersion: "0.4.106",
    destination
  };
  const imported = await importBocDependencyContract(args);
  assert.equal(imported.sourceRevision, args.sourceRevision);
  assert.equal(JSON.parse(await readFile(path.join(destination, "import-provenance.json"), "utf8")).adapter_source_sha256, args.adapterSha256);
  await assert.rejects(importBocDependencyContract({...args, schemaSha256: "0".repeat(64)}), /digest mismatch/);
  await assert.rejects(importBocDependencyContract({...args, sourceRevision: "short"}), /source revision/);
  const linked = path.join(temporary, "linked-schema.json");
  await symlink(schema, linked);
  await assert.rejects(importBocDependencyContract({...args, schema: linked}), /regular non-link file/);
});

test("immutable BOC client dependency import validates exact bundle and candidate provenance", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-boc-client-import-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const bundleRoot = path.join(temporary, "archive/bos-client-dependency.v1");
  const published = path.join(repositoryRoot, "contracts/bos-operations-center/bos-client-dependency/v1");
  await mkdir(path.dirname(bundleRoot), {recursive: true});
  await cp(published, bundleRoot, {recursive: true});
  const archive = path.join(temporary, "bundle.tar.gz");
  await run("tar", ["-czf", archive, "-C", path.join(temporary, "archive"), "bos-client-dependency.v1"]);
  const args = {
    archive,
    archiveSha256: await sha256File(archive),
    bundleSha256: JSON.parse(await readFile(path.join(published, "manifest.json"), "utf8")).bundle_sha256,
    manifestSha256: await sha256File(path.join(published, "manifest.json")),
    sourceRevision: "d".repeat(40),
    bocVersion: "0.4.117",
    destination: path.join(temporary, "consumer/v1"),
    provenanceFile: path.join(temporary, "consumer/import-provenance.json")
  };
  const imported = await importBocClientDependency(args);
  assert.equal(imported.status, "candidate_review");
  await importBocClientDependency({...args, check: true});
  await writeFile(path.join(args.destination, "unexpected.json"), "{}\n");
  await assert.rejects(importBocClientDependency({...args, check: true}), /inventory/);
  await rm(path.join(args.destination, "unexpected.json"));
  await mkdir(path.join(args.destination, "unexpected"));
  await assert.rejects(importBocClientDependency({...args, check: true}), /inventory/);
  await rm(path.join(args.destination, "unexpected"), {recursive: true});
  await symlink(path.join(args.destination, "README.md"), path.join(args.destination, "unexpected-link"));
  await assert.rejects(importBocClientDependency({...args, check: true}), /inventory/);
  await rm(path.join(args.destination, "unexpected-link"));
  await assert.rejects(importBocClientDependency({...args, bundleSha256: "0".repeat(64)}), /bundle digest/);
  await assert.rejects(importBocClientDependency({...args, manifestSha256: "0".repeat(64)}), /manifest digest/);
  await assert.rejects(importBocClientDependency({...args, archiveSha256: "0".repeat(64)}), /archive digest/);
  const linked = path.join(temporary, "linked.tar.gz");
  await symlink(archive, linked);
  await assert.rejects(importBocClientDependency({...args, archive: linked}), /regular non-link file/);
});

test("immutable BOS Service candidate import validates exact tenant-neutral public inventory and provenance", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-bos-service-import-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const root = path.join(temporary, "archive/bos-service-public-contract-fixture");
  const journey = path.join(repositoryRoot, "contracts/bos/service-journey/v1");
  const lead = path.join(repositoryRoot, "contracts/bos/lead-director/v1");
  await mkdir(root, {recursive: true});
  await cp(path.join(journey, "PROVENANCE.json"), path.join(root, "PROVENANCE.json"));
  await cp(lead, path.join(root, "v1"), {recursive: true});
  const archive = path.join(temporary, "bundle.tar.gz");
  await run("tar", ["-czf", archive, "-C", path.join(temporary, "archive"), "bos-service-public-contract-fixture"]);
  const source = JSON.parse(await readFile(path.join(journey, "PROVENANCE.json"), "utf8"));
  const args = {
    archive,
    archiveSha256: await sha256File(archive),
    bundleSha256: source.embedded_bundle_sha256,
    sourceRevision: source.source_revision,
    artifactStatus: source.artifact_status,
    ...(source.deployed_revision === null ? {} : {deployedRevision: source.deployed_revision}),
    ...(source.deployed_image_digest === null ? {} : {imageDigest: source.deployed_image_digest}),
    leadTarget: path.join(temporary, "consumer/lead/v1"),
    leadProvenanceFile: path.join(temporary, "consumer/lead/import-provenance.json"),
    journeyTarget: path.join(temporary, "consumer/journey/v1"),
    journeyProvenanceFile: path.join(temporary, "consumer/journey/import-provenance.json")
  };
  await mkdir(args.leadTarget, {recursive: true});
  await cp(lead, args.leadTarget, {recursive: true, force: true});
  await mkdir(path.dirname(args.leadProvenanceFile), {recursive: true});
  await writeFile(args.leadProvenanceFile, "{}\n");
  const imported = await importBosServiceConsumerContract(args);
  assert.equal(imported.artifact_status, source.artifact_status);
  await importBosServiceConsumerContract({...args, check: true});
  await writeFile(path.join(args.leadTarget, "unexpected.json"), "{}\n");
  await assert.rejects(importBosServiceConsumerContract({...args, check: true}), /differs/);
  await rm(path.join(args.leadTarget, "unexpected.json"));
  await mkdir(path.join(args.leadTarget, "unexpected"));
  await assert.rejects(importBosServiceConsumerContract({...args, check: true}), /differs/);
  await rm(path.join(args.leadTarget, "unexpected"), {recursive: true});
  await symlink(path.join(args.journeyTarget, "JOURNEY-CLIENT-CONTRACT.md"), path.join(args.journeyTarget, "unexpected-link"));
  await assert.rejects(importBosServiceConsumerContract({...args, check: true}), /differs/);
  await rm(path.join(args.journeyTarget, "unexpected-link"));
  await assert.rejects(importBosServiceConsumerContract({...args, archiveSha256: "0".repeat(64)}), /archive digest/);
  const contractDocument = path.join(root, "v1/JOURNEY-CLIENT-CONTRACT.md");
  const safeContract = await readFile(contractDocument, "utf8");
  const forbiddenAddress = ["person", "private.example"].join("@");
  await writeFile(contractDocument, `${safeContract}\nContact: ${forbiddenAddress}\n`);
  const identityArchive = path.join(temporary, "identity-bundle.tar.gz");
  await run("tar", ["-czf", identityArchive, "-C", path.join(temporary, "archive"), "bos-service-public-contract-fixture"]);
  await assert.rejects(importBosServiceConsumerContract({...args, archive: identityArchive, archiveSha256: await sha256File(identityArchive)}), /non-synthetic email/);
  await writeFile(contractDocument, safeContract);
  await writeFile(path.join(root, "private-runtime.py"), "raise SystemExit\n");
  const privateArchive = path.join(temporary, "private-bundle.tar.gz");
  await run("tar", ["-czf", privateArchive, "-C", path.join(temporary, "archive"), "bos-service-public-contract-fixture"]);
  await assert.rejects(importBosServiceConsumerContract({...args, archive: privateArchive, archiveSha256: await sha256File(privateArchive)}), /inventory/);
  const linked = path.join(temporary, "linked.tar.gz");
  await symlink(archive, linked);
  await assert.rejects(importBosServiceConsumerContract({...args, archive: linked}), /regular non-link file/);
});

function nativeCommandHarness() {
  let marketplaceAdded = false;
  let pluginAdded = false;
  const calls = [];
  const runCommand = async (args) => {
    calls.push(args);
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: marketplaceAdded ? [{name: "my-crm-local", root: repositoryRoot, marketplaceSource: {sourceType: "local", source: repositoryRoot}}] : []});
    if (key === `plugin marketplace add ${repositoryRoot}`) { marketplaceAdded = true; return stableJson({name: "my-crm-local"}); }
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@bos-release", name: "bos", installed: true, enabled: true},
      {pluginId: "education-center@bos-release", name: "education-center", version: "fixture-version", installed: true, enabled: true},
      ...(pluginAdded ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}] : [])
    ]});
    if (key === "plugin add my-crm@my-crm-local") { pluginAdded = true; return stableJson({pluginId: "my-crm@my-crm-local", installedPath: releaseDirectory}); }
    throw new Error(`Unexpected native command: ${key}`);
  };
  return {calls, runCommand};
}

test("native install uses the supported Codex marketplace and verifies BOS delegation", async () => {
  const harness = nativeCommandHarness();
  const verifyBosExecutables = async () => ({bundle_sha256: "a".repeat(64), executable_count: 5});
  const result = await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory, verifyBosExecutables});
  assert.equal(result.pluginId, "my-crm@my-crm-local");
  assert.equal(result.bosPluginId, "bos@bos-release");
  assert.equal(result.educationCenterPluginId, "education-center@bos-release");
  assert.ok(harness.calls.some((args) => args.includes("marketplace") && args.includes("add")));
  assert.ok(harness.calls.some((args) => args.includes("my-crm@my-crm-local")));
  await verifyNativeRuntime({runCommand: harness.runCommand, expectedDirectory: releaseDirectory, verifyBosExecutables});
  const addCount = harness.calls.filter((args) => args.includes("add") && args.includes("my-crm@my-crm-local")).length;
  await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory, verifyBosExecutables});
  assert.equal(harness.calls.some((args) => args.includes("remove")), false);
  assert.equal(harness.calls.filter((args) => args.includes("add") && args.includes("my-crm@my-crm-local")).length, addCount);
});

test("failed native reinstall never removes the working candidate", async () => {
  let installed = true;
  const calls = [];
  const runCommand = async (args) => {
    calls.push(args);
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: [{name: "my-crm-local", root: repositoryRoot, marketplaceSource: {sourceType: "local", source: repositoryRoot}}]});
    if (key === "plugin add my-crm@my-crm-local") throw new Error("simulated native install failure");
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@bos-release", name: "bos", installed: true, enabled: true},
      ...(installed ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: "0.2.0", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}] : [])
    ]});
    if (key.includes("remove")) installed = false;
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand, verifyBosExecutables: async () => ({})}), /simulated native install failure/);
  assert.equal(installed, true);
  assert.equal(calls.some((args) => args.includes("remove")), false);
});

test("BOS executable mismatch prevents native My CRM installation", async () => {
  const harness = nativeCommandHarness();
  await assert.rejects(
    installLocal({runCommand: harness.runCommand, verifyBosExecutables: async () => { throw new Error("simulated BOS digest mismatch"); }}),
    /simulated BOS digest mismatch/
  );
  assert.equal(harness.calls.some((args) => args.includes("add") && args.includes("my-crm@my-crm-local")), false);
});

test("same-version changed bytes fail closed before native installation", async (context) => {
  await buildRelease();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-tampered-cache-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  await cp(releaseDirectory, temporary, {recursive: true});
  await writeFile(path.join(temporary, "README.md"), "tampered\n");
  const calls = [];
  const runCommand = async (args) => {
    calls.push(args);
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: [{name: "my-crm-local", root: repositoryRoot, marketplaceSource: {sourceType: "local", source: repositoryRoot}}]});
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@bos-release", name: "bos", installed: true, enabled: true},
      {pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}
    ]});
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand, installedDirectoryFor: () => temporary, verifyBosExecutables: async () => ({})}), /bump the package version/);
  assert.equal(calls.some((args) => args.includes("add") && args.includes("my-crm@my-crm-local")), false);
  assert.equal(calls.some((args) => args.includes("remove")), false);
});

test("native runtime verification rejects a missing BOS dependency", async () => {
  await buildRelease();
  const runCommand = async () => stableJson({installed: [{pluginId: "my-crm@my-crm-local", name: "my-crm", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}]});
  await assert.rejects(verifyNativeRuntime({runCommand, expectedDirectory: releaseDirectory}), /BOS dependency/);
});

test("native runtime verifies every BOS executable bound by the reviewed dependency manifest", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-bos-executable-test-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  const adapter = "skills/bos-external-dependency-adapter/scripts/external-dependency-adapter.mjs";
  const cache = "skills/bos-mcp-client/scripts/shared-cache-consumer.mjs";
  await mkdir(path.dirname(path.join(temporary, adapter)), {recursive: true});
  await mkdir(path.dirname(path.join(temporary, cache)), {recursive: true});
  await writeFile(path.join(temporary, adapter), "export const adapter = true;\n");
  await writeFile(path.join(temporary, cache), "export const cache = true;\n");
  const manifest = {
    bundle_sha256: "a".repeat(64),
    executable_files: [
      {id: "adapter", path: adapter, sha256: await sha256File(path.join(temporary, adapter))},
      {id: "cache", path: cache, sha256: await sha256File(path.join(temporary, cache))}
    ]
  };
  assert.deepEqual(await verifyBosExecutableContract({bosDirectory: temporary, manifest}), {bundle_sha256: manifest.bundle_sha256, executable_count: 2});
  await writeFile(path.join(temporary, cache), "tampered\n");
  await assert.rejects(verifyBosExecutableContract({bosDirectory: temporary, manifest}), /differs from the reviewed dependency contract/);
});

test("live acceptance delegates discovered read-only CRM search to installed BOS", async () => {
  const outputSchema = JSON.parse(await readFile(path.join(repositoryRoot, "contracts/my-crm/v1/live-acceptance-response.schema.json"), "utf8"));
  const syntheticQuery = "mycrm-acceptance-00000000000000000000000000000000@example.invalid";
  const prompt = buildLiveAcceptancePrompt(syntheticQuery);
  assert.equal(outputSchema.properties.status.type, "string");
  assert.equal(outputSchema.properties.mutation_performed.type, "boolean");
  assert.equal(outputSchema.properties.authority_exposed.type, "boolean");
  assert.match(prompt, /single authenticated connection/);
  assert.match(prompt, /server-advertised synthetic or ephemeral acceptance context/);
  assert.match(prompt, /do not select, name, infer, display, or target a real customer/);
  assert.match(prompt, /current-host read execution/);
  assert.match(prompt, /exact descriptor whose name ends in bos_get_context/);
  assert.match(prompt, /Do not use MCP resources\/list as a tool inventory/);
  assert.match(prompt, /live-discovered read operation or tool/);
  assert.match(prompt, /exact current input and output schema/);
  assert.match(prompt, /plugins\.list and service\.describe journey-description catalog is outside this ordinary read path and must not be required/);
  assert.match(prompt, /mycrm-acceptance-00000000000000000000000000000000@example\.invalid/);
  assert.match(prompt, /live-discovered output contract/);
  assert.match(prompt, /Do not create, update, delete/);
  assert.doesNotMatch(prompt, /site_code|access_token|installation_id/);
  assert.throws(() => buildLiveAcceptancePrompt("person@example.invalid"), /generated example\.invalid query/);
  const runCommand = async (args) => {
    assert.equal(args.includes("--approve-for-me"), true);
    assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    const outputIndex = args.indexOf("--output-last-message");
    assert.notEqual(outputIndex, -1);
    await writeFile(args[outputIndex + 1], stableJson({
      status: "APPROVED",
      bos_connection_reused: true,
      synthetic_context_verified: true,
      synthetic_query_used: true,
      real_customer_targeted: false,
      application_discovered: true,
      search_described: true,
      search_executed: true,
      result_validated: true,
      source_provenance_preserved: true,
      freshness_presented: true,
      conceptual_reconciliation_assessed: true,
      mutation_performed: false,
      authority_exposed: false,
      message: "Installed BOS discovery and task-scoped Describe succeeded."
    }));
    return "";
  };
  const evidence = await runLiveAcceptance({
    authorized: true,
    syntheticQuery,
    runCommand,
    verifyRuntime: async () => ({pluginId: "my-crm@my-crm-local", bosPluginId: "bos@bos-release", release: {content_sha256: "b".repeat(64)}})
  });
  assert.equal(evidence.result.status, "APPROVED");
  await assert.rejects(runLiveAcceptance({authorized: false}), /MYCRM_LIVE_ACCEPTANCE/);
});

test("native live runner closes piped stdin before waiting for Codex", async () => {
  const {stdout} = await execFileWithClosedStdin(process.execPath, [
    "--input-type=module",
    "-e",
    "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('stdin-closed'))"
  ], {timeout: 1000});
  assert.equal(stdout, "stdin-closed");
});

test("live acceptance evidence rejects authority or internal identity text", async () => {
  const runCommand = async (args) => {
    const outputIndex = args.indexOf("--output-last-message");
    await writeFile(args[outputIndex + 1], stableJson({
      status: "APPROVED",
      bos_connection_reused: true,
      synthetic_context_verified: true,
      synthetic_query_used: true,
      real_customer_targeted: false,
      application_discovered: true,
      search_described: true,
      search_executed: true,
      result_validated: true,
      source_provenance_preserved: true,
      freshness_presented: true,
      conceptual_reconciliation_assessed: true,
      mutation_performed: false,
      authority_exposed: false,
      message: "organization_id was leaked"
    }));
    return "";
  };
  await assert.rejects(runLiveAcceptance({
    authorized: true,
    syntheticQuery: "mycrm-acceptance-00000000000000000000000000000000@example.invalid",
    runCommand,
    verifyRuntime: async () => ({pluginId: "my-crm@my-crm-local", bosPluginId: "bos@bos-release", release: {content_sha256: "b".repeat(64)}})
  }), /forbidden authority/);
});
