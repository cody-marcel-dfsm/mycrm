import {execFile} from "node:child_process";
import {lstat, realpath} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {buildRelease} from "./build-release.mjs";
import {checkRelease} from "./check-release.mjs";
import {assertSafeRelativePath, readJson, repositoryRoot, sha256File} from "./release-utils.mjs";

const exec = promisify(execFile);
const MARKETPLACE = "my-crm-local";
const PLUGIN_ID = `my-crm@${MARKETPLACE}`;
const BOC_CLIENT_MANIFEST = path.join(repositoryRoot, "contracts/bos-operations-center/bos-client-dependency/v1/manifest.json");

function installedProduct(installed, name) {
  return installed.find((entry) => entry.name === name && entry.enabled && entry.installed) ?? null;
}

function compatibilitySnapshot(installed) {
  return ["bos", "education-center"].map((name) => {
    const entry = installedProduct(installed, name);
    return entry ? {name, pluginId: entry.pluginId, version: entry.version, enabled: entry.enabled, installed: entry.installed} : null;
  }).filter(Boolean);
}

async function defaultRun(args) {
  const {stdout} = await exec("codex", args, {cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024});
  return stdout;
}

async function jsonCommand(runCommand, args) {
  const output = await runCommand([...args, "--json"]);
  return JSON.parse(output);
}

export async function verifyBosExecutableContract({bosDirectory, manifest}) {
  manifest ??= await readJson(BOC_CLIENT_MANIFEST);
  if (!Array.isArray(manifest.executable_files) || manifest.executable_files.length === 0) throw new Error("The BOS client dependency manifest does not bind executable files");
  for (const executable of manifest.executable_files) {
    const relative = assertSafeRelativePath(executable.path, "BOS executable path");
    if (!/^[a-f0-9]{64}$/.test(executable.sha256 ?? "")) throw new Error(`The BOS executable digest is invalid: ${relative}`);
    const absolute = path.join(bosDirectory, relative);
    const metadata = await lstat(absolute).catch(() => null);
    if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`The installed BOS executable is missing or unsafe: ${relative}`);
    if (await sha256File(absolute) !== executable.sha256) throw new Error(`The installed BOS executable differs from the reviewed dependency contract: ${relative}`);
  }
  return {bundle_sha256: manifest.bundle_sha256, executable_count: manifest.executable_files.length};
}

async function verifyInstalledBosExecutables(bos, explicitDirectory) {
  const marketplace = bos.marketplaceName ?? bos.pluginId?.split("@")[1];
  if (!marketplace || !bos.version) throw new Error("The installed BOS package location cannot be resolved for dependency verification");
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const bosDirectory = explicitDirectory ?? path.join(codexHome, "plugins/cache", marketplace, bos.name, bos.version);
  return verifyBosExecutableContract({bosDirectory});
}

export async function verifyNativeRuntime({runCommand = defaultRun, expectedDirectory, expectedBosDirectory, verifyBosExecutables = verifyInstalledBosExecutables} = {}) {
  const listing = await jsonCommand(runCommand, ["plugin", "list"]);
  const installed = listing.installed ?? [];
  const myCrm = installed.find((entry) => entry.pluginId === PLUGIN_ID);
  if (!myCrm?.installed || !myCrm.enabled) throw new Error(`Native Codex plugin ${PLUGIN_ID} is not installed and enabled`);
  const bos = installedProduct(installed, "bos");
  if (!bos) throw new Error("The installed, enabled BOS dependency is required before My CRM can run");
  const bosDependency = await verifyBosExecutables(bos, expectedBosDirectory);
  if (myCrm.source?.source !== "local" || !myCrm.source.path) throw new Error("My CRM must be installed from the supported local release-candidate marketplace");
  if (await realpath(myCrm.source.path) !== await realpath(path.join(repositoryRoot, "dist/my-crm"))) throw new Error("Installed My CRM marketplace source differs from this release candidate");
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const installedPath = expectedDirectory ?? path.join(codexHome, "plugins/cache", MARKETPLACE, "my-crm", myCrm.version);
  const release = await checkRelease({directory: path.resolve(installedPath)});
  const educationCenter = installedProduct(installed, "education-center");
  return {pluginId: myCrm.pluginId, bosPluginId: bos.pluginId, educationCenterPluginId: educationCenter?.pluginId ?? null, bosDependency, release};
}

export async function installLocal({runCommand = defaultRun, installedDirectoryFor, expectedBosDirectory, verifyBosExecutables = verifyInstalledBosExecutables} = {}) {
  await buildRelease();
  await checkRelease();
  const packageVersion = (await readJson(path.join(repositoryRoot, "package.json"))).version;
  const marketplaceListing = await jsonCommand(runCommand, ["plugin", "marketplace", "list"]);
  const marketplace = (marketplaceListing.marketplaces ?? []).find(({name}) => name === MARKETPLACE);
  if (!marketplace) await jsonCommand(runCommand, ["plugin", "marketplace", "add", repositoryRoot]);
  else {
    const configured = marketplace.marketplaceSource?.source ?? marketplace.root;
    if (await realpath(configured) !== await realpath(repositoryRoot)) throw new Error(`${MARKETPLACE} is already configured from a different root`);
  }
  const currentListing = await jsonCommand(runCommand, ["plugin", "list"]);
  const compatibilityBefore = compatibilitySnapshot(currentListing.installed ?? []);
  const bos = installedProduct(currentListing.installed ?? [], "bos");
  if (!bos) throw new Error("The installed, enabled BOS dependency is required before My CRM can be installed");
  await verifyBosExecutables(bos, expectedBosDirectory);
  const current = (currentListing.installed ?? []).find(({pluginId}) => pluginId === PLUGIN_ID);
  if (current?.version === packageVersion) {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    const installedPath = installedDirectoryFor?.(current) ?? path.join(codexHome, "plugins/cache", MARKETPLACE, "my-crm", current.version);
    try {
      const verified = await verifyNativeRuntime({runCommand, expectedDirectory: installedPath, expectedBosDirectory, verifyBosExecutables});
      const afterListing = await jsonCommand(runCommand, ["plugin", "list"]);
      if (JSON.stringify(compatibilitySnapshot(afterListing.installed ?? [])) !== JSON.stringify(compatibilityBefore)) throw new Error("My CRM verification changed the installed BOS product compatibility baseline");
      return verified;
    } catch (error) {
      throw new Error(`Installed My CRM ${packageVersion} differs from this candidate; bump the package version before installing changed bytes: ${error.message}`);
    }
  }
  const installation = await jsonCommand(runCommand, ["plugin", "add", PLUGIN_ID]);
  if (!installation.installedPath) throw new Error("Native Codex install did not return its installed release path");
  const verified = await verifyNativeRuntime({runCommand, expectedDirectory: installation.installedPath, expectedBosDirectory, verifyBosExecutables});
  const afterListing = await jsonCommand(runCommand, ["plugin", "list"]);
  if (JSON.stringify(compatibilitySnapshot(afterListing.installed ?? [])) !== JSON.stringify(compatibilityBefore)) throw new Error("My CRM installation changed the installed BOS product compatibility baseline");
  return verified;
}

async function main() {
  const command = process.argv[2];
  if (command === "install") {
    const result = await installLocal();
    console.log(`MYCRM_NATIVE_INSTALL=APPROVED plugin=${result.pluginId} release=${result.release.content_sha256}`);
  } else if (command === "verify") {
    const result = await verifyNativeRuntime();
    console.log(`MYCRM_NATIVE_RUNTIME=APPROVED plugin=${result.pluginId} bos=${result.bosPluginId} release=${result.release.content_sha256}`);
  } else throw new Error("Usage: node scripts/codex-local-install.mjs <install|verify>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
