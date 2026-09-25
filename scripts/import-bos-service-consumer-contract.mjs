import {execFile} from "node:child_process";
import {cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

import {checkPrivacy} from "./check-privacy.mjs";
import {assertSafeRelativePath, readJson, repositoryRoot, sha256File, stableJson} from "./release-utils.mjs";

const run = promisify(execFile);
const LEAD_TARGET = path.join(repositoryRoot, "contracts/bos/lead-director/v1");
const LEAD_PROVENANCE = path.join(repositoryRoot, "contracts/bos/lead-director/import-provenance.json");
const JOURNEY_TARGET = path.join(repositoryRoot, "contracts/bos/service-journey/v1");
const JOURNEY_PROVENANCE = path.join(repositoryRoot, "contracts/bos/service-journey/import-provenance.json");
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 10 * 1024 * 1024;
const LEAD_FILES = [
  "api.contract.request.example.json", "api.contract.request.schema.json",
  "api.contract.response.example.json", "api.contract.response.schema.json",
  "app.describe.example.json", "app.describe.schema.json",
  "describe.request.example.json", "describe.response.example.json",
  "describe.response.schema.json", "operation.examples.json"
];
const JOURNEY_FILES = [
  "JOURNEY-CLIENT-CONTRACT.md", "PROVENANCE.json",
  "journey.client-action-required.example.json", "journey.client-action-required.schema.json"
];
const JOURNEY_PUBLIC_FILES = JOURNEY_FILES.filter((name) => name !== "PROVENANCE.json");
const FULL_CONTRACT_FILES = [...LEAD_FILES, ...JOURNEY_PUBLIC_FILES].sort();
const CONTRACT_PREFIX = "v1";
const EXPECTED_RELATIVE_FILES = [
  "PROVENANCE.json",
  ...FULL_CONTRACT_FILES.map((name) => `${CONTRACT_PREFIX}/${name}`),
  `${CONTRACT_PREFIX}/manifest.json`
].sort();

function parseArguments(argv) {
  const result = {check: false};
  const names = new Map([
    ["--archive", "archive"], ["--archive-sha256", "archiveSha256"],
    ["--bundle-sha256", "bundleSha256"], ["--source-revision", "sourceRevision"],
    ["--artifact-status", "artifactStatus"], ["--deployed-revision", "deployedRevision"],
    ["--image-digest", "imageDigest"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--check") result.check = true;
    else if (names.has(value)) result[names.get(value)] = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return result;
}

async function inspectArchive(archive) {
  const [{stdout: namesOutput}, {stdout: detailOutput}] = await Promise.all([
    run("tar", ["-tzf", archive], {maxBuffer: 1024 * 1024}),
    run("tar", ["-tvzf", archive], {maxBuffer: 1024 * 1024})
  ]);
  const names = namesOutput.split("\n").filter(Boolean);
  const details = detailOutput.split("\n").filter(Boolean);
  if (names.length !== details.length) throw new Error("BOS Service public archive listing is inconsistent");
  let extractedBytes = 0;
  for (const detail of details) {
    if (!["-", "d"].includes(detail[0])) throw new Error("BOS Service public archive may contain only regular files and directories");
    const size = detail.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s/)?.[1];
    if (size === undefined) throw new Error("BOS Service public archive size metadata is invalid");
    extractedBytes += Number(size);
  }
  if (extractedBytes > MAX_EXTRACTED_BYTES) throw new Error("BOS Service public archive exceeds the extraction limit");
  const normalized = names.map((name) => assertSafeRelativePath(name.replace(/\/$/, ""), "archive entry"));
  const files = normalized.filter((name, index) => details[index][0] === "-");
  const roots = new Set(files.map((name) => name.split("/")[0]));
  if (roots.size !== 1) throw new Error("BOS Service public archive must have one root");
  const root = [...roots][0];
  const relativeFiles = files.map((name) => name.slice(root.length + 1)).sort();
  if (JSON.stringify(relativeFiles) !== JSON.stringify(EXPECTED_RELATIVE_FILES)) throw new Error("BOS Service public archive inventory is invalid");
  const allowedDirectories = new Set([root, `${root}/${CONTRACT_PREFIX}`]);
  for (const [index, name] of normalized.entries()) if (details[index][0] === "d" && !allowedDirectories.has(name)) throw new Error("BOS Service public archive contains an unexpected directory");
  return root;
}

async function exactDirectory(directory, expectedFiles) {
  const entries = await readdir(directory, {withFileTypes: true});
  if (JSON.stringify(entries.map(({name}) => name).sort()) !== JSON.stringify([...expectedFiles].sort())) return false;
  for (const entry of entries) {
    const metadata = await lstat(path.join(directory, entry.name));
    if (!entry.isFile() || entry.isSymbolicLink() || !metadata.isFile() || metadata.isSymbolicLink()) return false;
  }
  return true;
}

async function validateCandidate(root, expected) {
  const sourceProvenance = await readJson(path.join(root, "PROVENANCE.json"));
  if (sourceProvenance.artifact_status !== expected.artifactStatus || sourceProvenance.source_revision !== expected.sourceRevision || sourceProvenance.deployed_revision !== (expected.deployedRevision ?? null) || sourceProvenance.deployed_image_digest !== (expected.imageDigest ?? null) || sourceProvenance.embedded_bundle_sha256 !== expected.bundleSha256) {
    throw new Error("BOS Service public provenance does not match the authorized deployment");
  }
  const lead = path.join(root, CONTRACT_PREFIX);
  const manifestPath = path.join(lead, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (manifest.contract !== "bos-public-contract-release/v1" || manifest.contract_id !== "lead-director-describe" || manifest.contract_version !== "lead-director-describe/v1" || manifest.owner !== "bos" || manifest.bundle_sha256 !== expected.bundleSha256) throw new Error("Embedded Lead Director public contract identity is invalid");
  if (manifest.auth_impact !== "owner-approved-auth-adjacent-context-selection" || manifest.preserved_auth_contract !== "oauth-login-token-grant-callback-session-unchanged") throw new Error("Embedded Lead Director authentication classification is invalid");
  if (JSON.stringify(manifest.files?.map(({path: name}) => assertSafeRelativePath(name, "manifest path")).sort()) !== JSON.stringify(FULL_CONTRACT_FILES)) throw new Error("Embedded Lead Director manifest inventory is invalid");
  if (!await exactDirectory(lead, [...FULL_CONTRACT_FILES, "manifest.json"])) throw new Error("Embedded Lead Director directory is not exact");
  for (const entry of manifest.files) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || await sha256File(path.join(lead, entry.path)) !== entry.sha256) throw new Error(`Embedded Lead Director digest mismatch: ${entry.path}`);
    if (entry.path.endsWith(".json")) JSON.parse(await readFile(path.join(lead, entry.path), "utf8"));
  }
  JSON.parse(await readFile(path.join(lead, "journey.client-action-required.schema.json"), "utf8"));
  JSON.parse(await readFile(path.join(lead, "journey.client-action-required.example.json"), "utf8"));
  return {sourceProvenance, manifest, manifestSha256: await sha256File(manifestPath)};
}

async function directoriesMatch(left, right, files) {
  if (!await exactDirectory(left, files) || !await exactDirectory(right, files)) return false;
  for (const name of files) if (await sha256File(path.join(left, name)) !== await sha256File(path.join(right, name))) return false;
  return true;
}

export async function importBosServiceConsumerContract({
  archive, archiveSha256, bundleSha256, sourceRevision, artifactStatus, deployedRevision, imageDigest, check = false,
  leadTarget = LEAD_TARGET, leadProvenanceFile = LEAD_PROVENANCE,
  journeyTarget = JOURNEY_TARGET, journeyProvenanceFile = JOURNEY_PROVENANCE
}) {
  if (!/^[a-f0-9]{64}$/.test(archiveSha256 ?? "") || !/^[a-f0-9]{64}$/.test(bundleSha256 ?? "")) throw new Error("BOS Service archive and bundle SHA-256 values are required");
  if (!/^[a-f0-9]{40}$/.test(sourceRevision ?? "")) throw new Error("BOS Service source revision is invalid");
  if (!new Set(["candidate_un_deployed", "deployed_staging"]).has(artifactStatus)) throw new Error("BOS Service artifact status is invalid");
  if (artifactStatus === "candidate_un_deployed") {
    if (deployedRevision !== undefined || imageDigest !== undefined) throw new Error("An undeployed BOS Service candidate cannot declare deployment provenance");
  } else {
    if (!/^lead-director-backend-[a-z0-9-]+$/.test(deployedRevision ?? "")) throw new Error("BOS Service deployed revision is invalid");
    if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? "")) throw new Error("BOS Service image digest is invalid");
  }
  const resolved = path.resolve(archive);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("BOS Service public archive must be a regular non-link file");
  if (metadata.size > MAX_ARCHIVE_BYTES) throw new Error("BOS Service public archive exceeds the size limit");
  if (await sha256File(resolved) !== archiveSha256) throw new Error("BOS Service public archive digest is invalid");
  const rootName = await inspectArchive(resolved);
  const temporary = await mkdtemp(path.join(path.dirname(leadTarget), ".bos-service-import-"));
  try {
    await run("tar", ["-xzf", resolved, "-C", temporary, "--no-same-owner", "--no-same-permissions"], {maxBuffer: 1024 * 1024});
    const sourceRoot = path.join(temporary, rootName);
    await checkPrivacy({root: sourceRoot, includeDist: true});
    const {manifest, manifestSha256} = await validateCandidate(sourceRoot, {bundleSha256, sourceRevision, artifactStatus, deployedRevision, imageDigest});
    const candidateLead = path.join(temporary, "candidate-lead");
    const candidateJourney = path.join(temporary, "candidate-journey");
    await cp(path.join(sourceRoot, CONTRACT_PREFIX), candidateLead, {recursive: true});
    await mkdir(candidateJourney);
    await cp(path.join(sourceRoot, "PROVENANCE.json"), path.join(candidateJourney, "PROVENANCE.json"));
    for (const name of JOURNEY_PUBLIC_FILES) await cp(path.join(sourceRoot, CONTRACT_PREFIX, name), path.join(candidateJourney, name));
    const deployment = artifactStatus === "deployed_staging" ? {deployed_revision: deployedRevision, image_digest: imageDigest} : {deployed_revision: null, image_digest: null};
    const leadProvenance = {schema: "my-crm.bos-contract-import/v1", artifact_status: artifactStatus, source_revision: sourceRevision, ...deployment, archive_sha256: archiveSha256, manifest_sha256: manifestSha256, bundle_sha256: manifest.bundle_sha256};
    const journeyProvenance = {schema: "my-crm.bos-service-consumer-import/v1", artifact_status: artifactStatus, source_revision: sourceRevision, ...deployment, archive_sha256: archiveSha256, bundle_sha256: bundleSha256};
    if (check) {
      if (!await directoriesMatch(candidateLead, leadTarget, [...FULL_CONTRACT_FILES, "manifest.json"]) || !await directoriesMatch(candidateJourney, journeyTarget, JOURNEY_FILES)) throw new Error("Committed BOS Service public contract differs from the authorized archive");
      if (stableJson(await readJson(leadProvenanceFile)) !== stableJson(leadProvenance) || stableJson(await readJson(journeyProvenanceFile)) !== stableJson(journeyProvenance)) throw new Error("Committed BOS Service provenance differs from the authorized archive");
      return journeyProvenance;
    }
    const leadBackup = path.join(temporary, "lead-backup");
    const journeyBackup = path.join(temporary, "journey-backup");
    const hadJourney = await lstat(journeyTarget).then(() => true, () => false);
    const priorLeadProvenance = await readFile(leadProvenanceFile);
    const priorJourneyProvenance = await readFile(journeyProvenanceFile).catch(() => null);
    await mkdir(path.dirname(journeyTarget), {recursive: true});
    const leadProvenanceTemporary = `${leadProvenanceFile}.import-${process.pid}`;
    const journeyProvenanceTemporary = `${journeyProvenanceFile}.import-${process.pid}`;
    await writeFile(leadProvenanceTemporary, stableJson(leadProvenance), {flag: "wx"});
    await writeFile(journeyProvenanceTemporary, stableJson(journeyProvenance), {flag: "wx"});
    await rename(leadTarget, leadBackup);
    if (hadJourney) await rename(journeyTarget, journeyBackup);
    try {
      await rename(candidateLead, leadTarget);
      await rename(candidateJourney, journeyTarget);
      await rename(leadProvenanceTemporary, leadProvenanceFile);
      await rename(journeyProvenanceTemporary, journeyProvenanceFile);
      await rm(leadBackup, {recursive: true, force: true});
      await rm(journeyBackup, {recursive: true, force: true});
    } catch (error) {
      await rm(leadProvenanceTemporary, {force: true});
      await rm(journeyProvenanceTemporary, {force: true});
      await rm(leadTarget, {recursive: true, force: true});
      await rm(journeyTarget, {recursive: true, force: true});
      await rename(leadBackup, leadTarget);
      if (hadJourney) await rename(journeyBackup, journeyTarget);
      await writeFile(leadProvenanceFile, priorLeadProvenance);
      if (priorJourneyProvenance === null) await rm(journeyProvenanceFile, {force: true});
      else await writeFile(journeyProvenanceFile, priorJourneyProvenance);
      throw error;
    }
    return journeyProvenance;
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const values = parseArguments(process.argv.slice(2));
    const result = await importBosServiceConsumerContract(values);
    console.log(`BOS_SERVICE_CONSUMER_IMPORT=APPROVED bundle=${result.bundle_sha256} source=${result.source_revision} deployed=${result.deployed_revision}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
