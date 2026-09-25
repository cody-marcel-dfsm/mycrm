import {access, readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {releaseDirectory} from "./build-release.mjs";
import {checkPrivacy} from "./check-privacy.mjs";
import {readJson, repositoryRoot, sha256, sha256File, walkFiles} from "./release-utils.mjs";

const COPY_ROOTS = ["examples", "src"];
const COPY_FILES = ["LICENSE", "NOTICE", "README.md"];

async function canonicalInventory() {
  const entries = [];
  for (const relative of await walkFiles(path.join(repositoryRoot, "plugins/my-crm"))) {
    entries.push({source: path.join(repositoryRoot, "plugins/my-crm", relative), path: relative});
  }
  for (const root of COPY_ROOTS) {
    for (const relative of await walkFiles(path.join(repositoryRoot, root))) {
      entries.push({source: path.join(repositoryRoot, root, relative), path: `${root}/${relative}`});
    }
  }
  for (const relative of COPY_FILES) entries.push({source: path.join(repositoryRoot, relative), path: relative});
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function checkRelease({directory = releaseDirectory} = {}) {
  await checkPrivacy({root: directory, includeDist: true});
  const release = await readJson(path.join(directory, "release-manifest.json"));
  const packageJson = await readJson(path.join(repositoryRoot, "package.json"));
  const plugin = await readJson(path.join(directory, ".codex-plugin/plugin.json"));
  const product = await readJson(path.join(directory, ".bos-product.json"));
  if (release.schema !== "my-crm.release/v1" || release.name !== "my-crm" || release.version !== packageJson.version) throw new Error("Release manifest identity is invalid");
  if (plugin.version !== release.version || product.version !== release.version) throw new Error("Release package versions do not match");
  if (plugin.mcpServers !== undefined || plugin.apps !== undefined) throw new Error("My CRM release must not declare an MCP or app binding");
  if (product.connection_owner !== "bos" || product.authentication !== "bos_dependency" || JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"])) {
    throw new Error("My CRM release must delegate through the one BOS-owned connection");
  }
  for (const forbidden of [".mcp.json", ".app.json", "Vault", ".env", "credentials.json"]) {
    try { await access(path.join(directory, forbidden)); throw new Error(`Forbidden release entry is present: ${forbidden}`); } catch (error) {
      if (error.message.startsWith("Forbidden")) throw error;
    }
  }
  const canonical = await canonicalInventory();
  const canonicalByPath = new Map(canonical.map((entry) => [entry.path, entry]));
  const actualFiles = (await walkFiles(directory)).filter((relative) => relative !== "release-manifest.json");
  if (actualFiles.some((relative) => [".mcp.json", ".app.json", ".env", "credentials.json"].includes(path.posix.basename(relative)) || relative.startsWith("Vault/"))) {
    throw new Error("Release contains a forbidden connection, credential, or private-knowledge file");
  }
  if (actualFiles.length !== canonical.length || actualFiles.some((relative) => !canonicalByPath.has(relative))) throw new Error("Release file inventory differs from canonical sources");
  const inventory = [];
  for (const relative of actualFiles) {
    const entry = canonicalByPath.get(relative);
    const sourceDigest = await sha256File(entry.source);
    const releaseDigest = await sha256File(path.join(directory, entry.path));
    if (sourceDigest !== releaseDigest) throw new Error(`Release file differs from canonical source: ${entry.path}`);
    inventory.push({path: entry.path, sha256: releaseDigest});
  }
  if (JSON.stringify(release.files) !== JSON.stringify(inventory)) throw new Error("Release manifest file inventory is invalid");
  const contentSha256 = sha256(inventory.map(({path: relative, sha256: digest}) => `${relative}\0${digest}\n`).join(""));
  if (release.content_sha256 !== contentSha256) throw new Error("Release content digest is invalid");
  for (const forbiddenKey of ["bos_contract_bundle_sha256", "bos_service_consumer_archive_sha256", "boc_client_dependency_bundle_sha256"]) {
    if (release[forbiddenKey] !== undefined) throw new Error(`Release manifest must not pin external BOS artifacts: ${forbiddenKey}`);
  }
  if (actualFiles.some((relative) => relative.startsWith("contracts/bos/") || relative.startsWith("contracts/bos-operations-center/"))) {
    throw new Error("Release must not package BOS Service or BOS Operations Center contracts");
  }
  JSON.parse(await readFile(path.join(directory, "release-manifest.json"), "utf8"));
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const release = await checkRelease();
    console.log(`MYCRM_RELEASE_CHECK=APPROVED version=${release.version} sha256=${release.content_sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
