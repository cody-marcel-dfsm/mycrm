import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {buildRelease, releaseDirectory} from "../scripts/build-release.mjs";
import {checkRelease} from "../scripts/check-release.mjs";
import {installLocal, verifyNativeRuntime} from "../scripts/codex-local-install.mjs";
import {importBosContract} from "../scripts/import-bos-contract.mjs";
import {repositoryRoot, sha256File, stableJson} from "../scripts/release-utils.mjs";
import {LIVE_ACCEPTANCE_PROMPT, runLiveAcceptance} from "../scripts/verify-live-contract.mjs";

const run = promisify(execFile);

test("release build is deterministic, canonical, and contains no second connection", async () => {
  const first = await buildRelease();
  const checked = await checkRelease();
  const second = await buildRelease();
  assert.equal(first.content_sha256, checked.content_sha256);
  assert.equal(first.content_sha256, second.content_sha256);
  await assert.rejects(readFile(path.join(releaseDirectory, ".mcp.json")));
  await assert.rejects(readFile(path.join(releaseDirectory, ".app.json")));
  assert.equal((await readFile(path.join(releaseDirectory, ".bos-product.json"), "utf8")).includes('"connection_owner": "bos"'), true);
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
      ...(pluginAdded ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: "0.2.1", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}] : [])
    ]});
    if (key === "plugin add my-crm@my-crm-local") { pluginAdded = true; return stableJson({pluginId: "my-crm@my-crm-local", installedPath: releaseDirectory}); }
    throw new Error(`Unexpected native command: ${key}`);
  };
  return {calls, runCommand};
}

test("native install uses the supported Codex marketplace and verifies BOS delegation", async () => {
  const harness = nativeCommandHarness();
  const result = await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory});
  assert.equal(result.pluginId, "my-crm@my-crm-local");
  assert.equal(result.bosPluginId, "bos@bos-release");
  assert.ok(harness.calls.some((args) => args.includes("marketplace") && args.includes("add")));
  assert.ok(harness.calls.some((args) => args.includes("my-crm@my-crm-local")));
  await verifyNativeRuntime({runCommand: harness.runCommand, expectedDirectory: releaseDirectory});
  const addCount = harness.calls.filter((args) => args.includes("add") && args.includes("my-crm@my-crm-local")).length;
  await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory});
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
    if (key === "plugin list") return stableJson({installed: installed ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: "0.2.0", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}] : []});
    if (key.includes("remove")) installed = false;
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand}), /simulated native install failure/);
  assert.equal(installed, true);
  assert.equal(calls.some((args) => args.includes("remove")), false);
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
      {pluginId: "my-crm@my-crm-local", name: "my-crm", marketplaceName: "my-crm-local", version: "0.2.1", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}
    ]});
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand, installedDirectoryFor: () => temporary}), /bump the package version/);
  assert.equal(calls.some((args) => args.includes("add") && args.includes("my-crm@my-crm-local")), false);
  assert.equal(calls.some((args) => args.includes("remove")), false);
});

test("native runtime verification rejects a missing BOS dependency", async () => {
  await buildRelease();
  const runCommand = async () => stableJson({installed: [{pluginId: "my-crm@my-crm-local", name: "my-crm", installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}]});
  await assert.rejects(verifyNativeRuntime({runCommand, expectedDirectory: releaseDirectory}), /BOS dependency/);
});

test("live acceptance delegates read-only discovery to installed BOS", async () => {
  assert.match(LIVE_ACCEPTANCE_PROMPT, /single authenticated connection/);
  assert.match(LIVE_ACCEPTANCE_PROMPT, /Perform only read-only/);
  assert.match(LIVE_ACCEPTANCE_PROMPT, /Do not create, update, delete/);
  assert.doesNotMatch(LIVE_ACCEPTANCE_PROMPT, /site_code|access_token|installation_id/);
  const runCommand = async (args) => {
    const outputIndex = args.indexOf("--output-last-message");
    assert.notEqual(outputIndex, -1);
    await writeFile(args[outputIndex + 1], stableJson({
      status: "APPROVED",
      bos_connection_reused: true,
      application_discovered: true,
      search_described: true,
      mutation_performed: false,
      authority_exposed: false,
      message: "Installed BOS discovery and task-scoped Describe succeeded."
    }));
    return "";
  };
  const evidence = await runLiveAcceptance({
    authorized: true,
    runCommand,
    verifyRuntime: async () => ({pluginId: "my-crm@my-crm-local", bosPluginId: "bos@bos-release", release: {content_sha256: "b".repeat(64)}})
  });
  assert.equal(evidence.result.status, "APPROVED");
  await assert.rejects(runLiveAcceptance({authorized: false}), /MYCRM_LIVE_ACCEPTANCE/);
});

test("live acceptance evidence rejects authority or internal identity text", async () => {
  const runCommand = async (args) => {
    const outputIndex = args.indexOf("--output-last-message");
    await writeFile(args[outputIndex + 1], stableJson({
      status: "APPROVED",
      bos_connection_reused: true,
      application_discovered: true,
      search_described: true,
      mutation_performed: false,
      authority_exposed: false,
      message: "organization_id was leaked"
    }));
    return "";
  };
  await assert.rejects(runLiveAcceptance({
    authorized: true,
    runCommand,
    verifyRuntime: async () => ({pluginId: "my-crm@my-crm-local", bosPluginId: "bos@bos-release", release: {content_sha256: "b".repeat(64)}})
  }), /forbidden authority/);
});
