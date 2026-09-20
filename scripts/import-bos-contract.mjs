import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {assertSafeRelativePath, readJson, repositoryRoot, sha256, sha256File, stableJson} from "./release-utils.mjs";

const run = promisify(execFile);
const CONTRACT_DIRECTORY = path.join(repositoryRoot, "contracts/bos/lead-director/v1");
const PROVENANCE_FILE = path.join(repositoryRoot, "contracts/bos/lead-director/import-provenance.json");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const EXPECTED_AUTH_IMPACT = "owner-approved-auth-adjacent-context-selection";
const EXPECTED_PRESERVED_AUTH_CONTRACT = "oauth-login-token-grant-callback-session-unchanged";
const EXPECTED_FILES = [
  "api.contract.request.example.json",
  "api.contract.request.schema.json",
  "api.contract.response.example.json",
  "api.contract.response.schema.json",
  "app.describe.example.json",
  "app.describe.schema.json",
  "describe.request.example.json",
  "describe.response.example.json",
  "describe.response.schema.json",
  "operation.examples.json"
];

function parseArguments(argv) {
  const options = {check: false};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") options.check = true;
    else if (["--archive", "--sha256", "--source-revision"].includes(value)) options[value.slice(2).replace("-", "_")] = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.archive || !options.sha256 || !options.source_revision) {
    throw new Error("Usage: npm run contracts:import -- --archive <bundle.tgz> --sha256 <archive-sha256> --source-revision <40-hex-commit> [--check]");
  }
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error("--sha256 must be a lowercase 64-character SHA-256 digest");
  if (!/^[a-f0-9]{40}$/.test(options.source_revision)) throw new Error("--source-revision must be a full lowercase 40-character commit SHA");
  return options;
}

async function inspectArchive(archive) {
  const [{stdout: namesOutput}, {stdout: detailOutput}] = await Promise.all([
    run("tar", ["-tzf", archive], {maxBuffer: 1024 * 1024}),
    run("tar", ["-tvzf", archive], {maxBuffer: 1024 * 1024})
  ]);
  const names = namesOutput.split("\n").filter(Boolean);
  const details = detailOutput.split("\n").filter(Boolean);
  if (names.length !== details.length) throw new Error("Archive listing is inconsistent");
  let extractedBytes = 0;
  for (const detail of details) {
    const kind = detail[0];
    if (kind !== "-" && kind !== "d") throw new Error("Contract archives may contain only regular files and directories");
    const size = detail.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/)?.[1];
    if (size === undefined) throw new Error("Contract archive size metadata is invalid");
    extractedBytes += Number(size);
  }
  if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("Contract archive expands beyond the 10 MiB safety limit");
  const normalized = names.map((name, index) => {
    if ((name === "." || name === "./") && details[index][0] === "d") return null;
    return assertSafeRelativePath(name.replace(/\/$/, ""), "archive entry");
  });
  const fileNames = normalized.filter((name, index) => name && details[index][0] === "-");
  const prefixes = new Set(fileNames.map((name) => name.includes("/") ? name.split("/")[0] : ""));
  if (prefixes.size > 1) throw new Error("Contract archive must use one bundle root");
  const prefix = [...prefixes][0];
  const directories = normalized.filter((name, index) => name && details[index][0] === "d");
  if (directories.some((name) => name !== prefix)) throw new Error("Contract archive contains an unexpected directory");
  const relativeFiles = fileNames.map((name) => prefix ? name.slice(prefix.length + 1) : name);
  const expected = [...EXPECTED_FILES, "manifest.json"].sort();
  if (JSON.stringify([...relativeFiles].sort()) !== JSON.stringify(expected)) {
    throw new Error("Contract archive must contain the exact eleven-file Lead Director public bundle");
  }
  return prefix;
}

async function validateCandidate(directory) {
  const manifestFile = path.join(directory, "manifest.json");
  const manifest = await readJson(manifestFile);
  if (manifest.contract !== "bos-public-contract-release/v1" || manifest.contract_id !== "lead-director-describe" || manifest.contract_version !== "lead-director-describe/v1") {
    throw new Error("Contract archive has the wrong BOS public contract identity");
  }
  if (manifest.owner !== "bos") throw new Error("Contract archive must be BOS-owned");
  if (manifest.auth_impact !== EXPECTED_AUTH_IMPACT || manifest.preserved_auth_contract !== EXPECTED_PRESERVED_AUTH_CONTRACT) {
    throw new Error("Contract archive must declare the exact owner-approved auth-adjacent classification and preserved authentication contract");
  }
  const paths = manifest.files?.map((entry) => assertSafeRelativePath(entry.path, "manifest file path"));
  if (JSON.stringify([...paths].sort()) !== JSON.stringify([...EXPECTED_FILES].sort())) throw new Error("Manifest file inventory is invalid");
  const directoryFiles = (await readdir(directory, {withFileTypes: true})).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  if (JSON.stringify(directoryFiles) !== JSON.stringify([...EXPECTED_FILES, "manifest.json"].sort())) throw new Error("Extracted contract directory is not exact");
  for (const entry of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || await sha256File(path.join(directory, entry.path)) !== entry.sha256) {
      throw new Error(`Contract file digest mismatch: ${entry.path}`);
    }
    JSON.parse(await readFile(path.join(directory, entry.path), "utf8"));
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.bundle_sha256)) throw new Error("Manifest bundle digest is invalid");
  return {manifest, manifestSha256: await sha256File(manifestFile)};
}

async function exactDirectoryMatch(left, right) {
  for (const name of [...EXPECTED_FILES, "manifest.json"]) {
    if (await sha256File(path.join(left, name)) !== await sha256File(path.join(right, name))) return false;
  }
  return true;
}

export async function importBosContract({archive, archiveSha256, sourceRevision, check = false, targetDirectory = CONTRACT_DIRECTORY, provenanceFile = PROVENANCE_FILE}) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256 ?? "")) throw new Error("Contract archive SHA-256 must be a lowercase 64-character digest");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("Contract source revision must be a full lowercase 40-character commit SHA");
  const resolvedArchive = path.resolve(archive);
  if ((await stat(resolvedArchive)).size > MAX_ARCHIVE_BYTES) throw new Error("Contract archive exceeds the 2 MiB safety limit");
  if (await sha256File(resolvedArchive) !== archiveSha256) throw new Error("Contract archive SHA-256 does not match --sha256");
  const prefix = await inspectArchive(resolvedArchive);
  const parent = path.dirname(targetDirectory);
  const temporary = await mkdtemp(path.join(parent, ".lead-director-import-"));
  const candidate = path.join(temporary, "candidate");
  try {
    await run("tar", ["-xzf", resolvedArchive, "-C", temporary, "--no-same-owner", "--no-same-permissions"], {maxBuffer: 1024 * 1024});
    if (prefix) await rename(path.join(temporary, prefix), candidate);
    else {
      await mkdir(candidate);
      for (const name of [...EXPECTED_FILES, "manifest.json"]) await rename(path.join(temporary, name), path.join(candidate, name));
    }
    const {manifest, manifestSha256} = await validateCandidate(candidate);
    const provenance = {
      schema: "my-crm.bos-contract-import/v1",
      source_revision: sourceRevision,
      archive_sha256: archiveSha256,
      manifest_sha256: manifestSha256,
      bundle_sha256: manifest.bundle_sha256
    };
    if (check) {
      if (!await exactDirectoryMatch(candidate, targetDirectory)) throw new Error("Committed BOS contract bundle differs from the supplied immutable archive");
      const currentProvenance = await readJson(provenanceFile);
      if (stableJson(currentProvenance) !== stableJson(provenance)) throw new Error("Committed BOS contract provenance differs from the supplied immutable archive");
      return provenance;
    }
    const backup = path.join(temporary, "backup");
    const provenanceTemporary = `${provenanceFile}.import-${process.pid}`;
    const priorProvenance = await readFile(provenanceFile);
    await writeFile(provenanceTemporary, stableJson(provenance), {flag: "wx"});
    await rename(targetDirectory, backup);
    try {
      await rename(candidate, targetDirectory);
      await rename(provenanceTemporary, provenanceFile);
      await rm(backup, {recursive: true, force: true});
    } catch (error) {
      await rm(provenanceTemporary, {force: true});
      await rm(targetDirectory, {recursive: true, force: true});
      await rename(backup, targetDirectory);
      await writeFile(provenanceFile, priorProvenance);
      throw error;
    }
    return provenance;
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const provenance = await importBosContract({
      archive: options.archive,
      archiveSha256: options.sha256,
      sourceRevision: options.source_revision,
      check: options.check
    });
    console.log(`BOS_CONTRACT_IMPORT=APPROVED bundle=${provenance.bundle_sha256} source=${provenance.source_revision}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
