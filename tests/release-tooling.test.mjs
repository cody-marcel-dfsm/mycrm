import assert from "node:assert/strict";
import {cp, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {buildRelease, releaseDirectory} from "../scripts/build-release.mjs";
import {checkRelease, RUNTIME_VERIFICATION_TOOLS} from "../scripts/check-release.mjs";
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
      {pluginId: "education-center@synthetic", name: "education-center", version: "1.0.0", installed: true, enabled: true},
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
