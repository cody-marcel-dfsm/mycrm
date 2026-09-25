import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {buildRelease, releaseDirectory} from "../scripts/build-release.mjs";
import {checkRelease} from "../scripts/check-release.mjs";
import {installLocal, verifyNativeRuntime} from "../scripts/codex-local-install.mjs";
import {repositoryRoot, stableJson} from "../scripts/release-utils.mjs";

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
  assert.equal(Object.keys(release).some((key) => /bos.*(bundle|archive).*sha/i.test(key)), false);
  assert.equal(release.files.some(({path: relative}) => relative.startsWith("contracts/") || /provenance|\.tgz$|\.tar\.gz$/.test(relative)), false);
});

function nativeHarness() {
  let marketplaceAdded = false;
  let pluginAdded = false;
  const calls = [];
  const runCommand = async (args) => {
    calls.push(args);
    const key = args.filter((value) => value !== "--json").join(" ");
    if (key === "plugin marketplace list") return stableJson({marketplaces: marketplaceAdded ? [{name: "my-crm-local", root: repositoryRoot, marketplaceSource: {sourceType: "local", source: repositoryRoot}}] : []});
    if (key === `plugin marketplace add ${repositoryRoot}`) { marketplaceAdded = true; return stableJson({name: "my-crm-local"}); }
    if (key === "plugin list") return stableJson({installed: [
      {pluginId: "bos@synthetic", name: "bos", version: "1.0.0", installed: true, enabled: true},
      ...(pluginAdded ? [{pluginId: "my-crm@my-crm-local", name: "my-crm", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}] : [])
    ]});
    if (key === "plugin add my-crm@my-crm-local") { pluginAdded = true; return stableJson({pluginId: "my-crm@my-crm-local", installedPath: releaseDirectory}); }
    throw new Error(`Unexpected native command: ${key}`);
  };
  return {calls, runCommand};
}

serializedReleaseTest("native install verifies BOS presence without pinning BOS package bytes", async () => {
  const harness = nativeHarness();
  const result = await installLocal({runCommand: harness.runCommand, installedDirectoryFor: () => releaseDirectory});
  assert.equal(result.bosPluginId, "bos@synthetic");
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
      {pluginId: "my-crm@my-crm-local", name: "my-crm", version: packageVersion, installed: true, enabled: true, source: {source: "local", path: releaseDirectory}}
    ]});
    throw new Error(`Unexpected native command: ${key}`);
  };
  await assert.rejects(installLocal({runCommand, installedDirectoryFor: () => temporary}), /bump the package version/);
});
