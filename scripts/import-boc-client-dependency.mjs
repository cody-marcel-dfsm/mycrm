import {execFile} from "node:child_process";
import {lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {checkPrivacy} from "./check-privacy.mjs";
import {assertSafeRelativePath, readJson, repositoryRoot, sha256, sha256File, stableJson} from "./release-utils.mjs";

const run = promisify(execFile);
const TARGET = path.join(repositoryRoot, "contracts/bos-operations-center/bos-client-dependency/v1");
const PROVENANCE = path.join(repositoryRoot, "contracts/bos-operations-center/bos-client-dependency/import-provenance.json");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const EXPECTED_FILES = [
  "README.md",
  "discovered-operation.request.example.json",
  "discovered-operation.request.schema.json",
  "discovered-operation.response.example.json",
  "discovered-operation.response.schema.json",
  "shared-cache.request.example.json",
  "shared-cache.request.schema.json",
  "shared-cache.results.example.json",
  "shared-cache.results.schema.json"
];
const EXPECTED_EXECUTABLES = [
  ["external_dependency_adapter", "skills/bos-external-dependency-adapter/scripts/external-dependency-adapter.mjs"],
  ["external_dependency_schema_runtime", "skills/bos-external-dependency-adapter/scripts/vendor/ajv2020.bundle.mjs"],
  ["external_dependency_discovered_operation_schema", "skills/bos-external-dependency-adapter/scripts/discovered-operation-request.schema.mjs"],
  ["shared_cache_consumer", "skills/bos-mcp-client/scripts/shared-cache-consumer.mjs"]
];

function parseArguments(argv) {
  const values = {check: false};
  const names = new Map([
    ["--archive", "archive"],
    ["--archive-sha256", "archiveSha256"],
    ["--bundle-sha256", "bundleSha256"],
    ["--manifest-sha256", "manifestSha256"],
    ["--source-revision", "sourceRevision"],
    ["--boc-version", "bocVersion"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") values.check = true;
    else if (names.has(value)) values[names.get(value)] = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return values;
}

async function inspectArchive(archive) {
  const [{stdout: namesOutput}, {stdout: detailOutput}] = await Promise.all([
    run("tar", ["-tzf", archive], {maxBuffer: 1024 * 1024}),
    run("tar", ["-tvzf", archive], {maxBuffer: 1024 * 1024})
  ]);
  const names = namesOutput.split("\n").filter(Boolean);
  const details = detailOutput.split("\n").filter(Boolean);
  if (names.length !== details.length) throw new Error("BOC client dependency archive listing is inconsistent");
  let extractedBytes = 0;
  for (const detail of details) {
    if (!["-", "d"].includes(detail[0])) throw new Error("BOC client dependency archive may contain only regular files and directories");
    const size = detail.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/)?.[1];
    if (size === undefined) throw new Error("BOC client dependency archive size metadata is invalid");
    extractedBytes += Number(size);
  }
  if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("BOC client dependency archive exceeds the extraction limit");
  const normalized = names.map((name) => assertSafeRelativePath(name.replace(/\/$/, ""), "archive entry"));
  const files = normalized.filter((name, index) => details[index][0] === "-");
  const archiveRoot = files.every((name) => name.startsWith("contracts/bos-client-dependency.v1/"))
    ? "contracts/bos-client-dependency.v1"
    : files.every((name) => name.startsWith("bos-client-dependency.v1/")) ? "bos-client-dependency.v1" : null;
  if (!archiveRoot) throw new Error("BOC client dependency archive root is invalid");
  const directories = normalized.filter((name, index) => details[index][0] === "d");
  const allowedDirectories = new Set(archiveRoot.startsWith("contracts/") ? ["contracts", archiveRoot] : [archiveRoot]);
  if (directories.some((name) => !allowedDirectories.has(name))) throw new Error("BOC client dependency archive contains an unexpected directory");
  const relativeFiles = files.map((name) => name.slice(`${archiveRoot}/`.length)).sort();
  if (JSON.stringify(relativeFiles) !== JSON.stringify([...EXPECTED_FILES, "manifest.json"].sort())) throw new Error("BOC client dependency archive inventory is invalid");
  return archiveRoot;
}

async function validateCandidate(directory, expectedBundleSha256, expectedManifestSha256) {
  const manifestPath = path.join(directory, "manifest.json");
  if (await sha256File(manifestPath) !== expectedManifestSha256) throw new Error("BOC client dependency manifest digest does not match the authorized review digest");
  const manifest = await readJson(manifestPath);
  if (manifest.contract !== "bos-client-dependency-release/v1" || manifest.contract_id !== "bos-client-dependency" || manifest.contract_version !== "bos-client-dependency/v1" || manifest.owner !== "bos-operations-center") throw new Error("BOC client dependency identity is invalid");
  if (manifest.authentication_impact !== "preserves-single-bos-connection" || manifest.compatibility !== "package-versioned-public-seam") throw new Error("BOC client dependency compatibility declaration is invalid");
  if (manifest.bundle_sha256 !== expectedBundleSha256) throw new Error("BOC client dependency bundle digest does not match the authorized review digest");
  const paths = manifest.files?.map(({path: relative}) => assertSafeRelativePath(relative, "manifest path"));
  if (JSON.stringify([...paths].sort()) !== JSON.stringify([...EXPECTED_FILES].sort())) throw new Error("BOC client dependency manifest inventory is invalid");
  await assertExactDirectoryInventory(directory, "BOC client dependency extracted inventory");
  for (const file of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || await sha256File(path.join(directory, file.path)) !== file.sha256) throw new Error(`BOC client dependency digest mismatch: ${file.path}`);
    if (file.path.endsWith(".json")) JSON.parse(await readFile(path.join(directory, file.path), "utf8"));
  }
  const executables = manifest.executable_files;
  if (!Array.isArray(executables) || JSON.stringify(executables.map(({id, path: relative}) => [id, assertSafeRelativePath(relative, "executable path")])) !== JSON.stringify(EXPECTED_EXECUTABLES)) throw new Error("BOC client dependency executable inventory is invalid");
  if (executables.some(({sha256: digest}) => !/^[a-f0-9]{64}$/.test(digest))) throw new Error("BOC client dependency executable digest is invalid");
  const rows = [
    ...manifest.files.map(({path: relative, sha256: digest}) => `contract\0${relative}\0${digest}`),
    ...executables.map(({path: relative, sha256: digest}) => `executable\0${relative}\0${digest}`)
  ];
  if (sha256(rows.join("\n")) !== manifest.bundle_sha256) throw new Error("BOC client dependency bundle row digest is invalid");
  return manifest;
}

async function assertExactDirectoryInventory(directory, label) {
  const expected = [...EXPECTED_FILES, "manifest.json"].sort();
  const entries = await readdir(directory, {withFileTypes: true});
  if (JSON.stringify(entries.map(({name}) => name).sort()) !== JSON.stringify(expected)) throw new Error(`${label} is invalid`);
  for (const entry of entries) {
    const metadata = await lstat(path.join(directory, entry.name));
    if (!entry.isFile() || entry.isSymbolicLink() || !metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} must contain only regular non-link files`);
  }
}

async function exactDirectoryMatch(left, right) {
  await assertExactDirectoryInventory(left, "Authorized BOC client dependency inventory");
  await assertExactDirectoryInventory(right, "Imported BOC client dependency inventory");
  for (const name of [...EXPECTED_FILES, "manifest.json"]) if (await sha256File(path.join(left, name)) !== await sha256File(path.join(right, name))) return false;
  return true;
}

export async function importBocClientDependency({archive, archiveSha256, bundleSha256, manifestSha256, sourceRevision, bocVersion, check = false, destination = TARGET, provenanceFile = PROVENANCE}) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256 ?? "") || !/^[a-f0-9]{64}$/.test(bundleSha256 ?? "") || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("BOC client dependency import requires exact lowercase SHA-256 digests");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("BOC client dependency import requires a full source revision");
  if (!/^\d+\.\d+\.\d+$/.test(bocVersion ?? "")) throw new Error("BOC client dependency import requires a semantic BOC version");
  const resolved = path.resolve(archive);
  const archiveMetadata = await lstat(resolved);
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) throw new Error("BOC client dependency archive must be a regular non-link file");
  if (archiveMetadata.size > MAX_ARCHIVE_BYTES) throw new Error("BOC client dependency archive exceeds the size limit");
  if (await sha256File(resolved) !== archiveSha256) throw new Error("BOC client dependency archive digest mismatch");
  const archiveRoot = await inspectArchive(resolved);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "mycrm-boc-client-import-"));
  const extracted = path.join(temporaryRoot, archiveRoot);
  try {
    await run("tar", ["-xzf", resolved, "-C", temporaryRoot, "--no-same-owner", "--no-same-permissions"], {maxBuffer: 1024 * 1024});
    await checkPrivacy({root: extracted, includeDist: true});
    const manifest = await validateCandidate(extracted, bundleSha256, manifestSha256);
    const provenance = {
      schema: "my-crm.boc-client-dependency-import/v1",
      status: "candidate_review",
      source_revision: sourceRevision,
      boc_version: bocVersion,
      archive_sha256: archiveSha256,
      manifest_sha256: await sha256File(path.join(extracted, "manifest.json")),
      bundle_sha256: manifest.bundle_sha256
    };
    if (check) {
      if (!await exactDirectoryMatch(extracted, destination)) throw new Error("Imported BOC client dependency differs from the authorized archive");
      if (stableJson(await readJson(provenanceFile)) !== stableJson(provenance)) throw new Error("BOC client dependency provenance differs from the authorized archive");
      return provenance;
    }
    const staging = path.join(temporaryRoot, "staging");
    const backup = path.join(temporaryRoot, "backup");
    const priorProvenance = await readFile(provenanceFile).catch(() => null);
    await rename(extracted, staging);
    await mkdir(path.dirname(destination), {recursive: true});
    await rename(destination, backup).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    try {
      await rename(staging, destination);
      await writeFile(provenanceFile, stableJson(provenance));
      await rm(backup, {recursive: true, force: true});
    } catch (error) {
      await rm(destination, {recursive: true, force: true});
      await rename(backup, destination).catch((restoreError) => {
        if (restoreError.code !== "ENOENT") throw restoreError;
      });
      if (priorProvenance === null) await rm(provenanceFile, {force: true});
      else await writeFile(provenanceFile, priorProvenance);
      throw error;
    }
    return provenance;
  } finally {
    await rm(temporaryRoot, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  importBocClientDependency(parseArguments(process.argv.slice(2))).then((result) => {
    console.log(`BOC_CLIENT_DEPENDENCY_IMPORT=APPROVED bundle=${result.bundle_sha256} source=${result.source_revision}`);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
