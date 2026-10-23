import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execute = promisify(execFile), oid = /^[a-f0-9]{40}$/, digestPattern = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = value => createHash("sha256").update(value).digest("hex");
export const gitBlobHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export const requiredCommands = Object.freeze([["npm", "run", "build"], ["npm", "test"], ["npm", "run", "check:release"]]);
export const validationContext = "my-crm/native-validation";
const contract = {required_commands: requiredCommands, execution_contract: "accept-original-supported-native-execution", additional_platform_executions: []};
export const validationContractHash = hash(canonical(contract));
const commandKey = command => hash(canonical(command));
const git = async (root, args) => (await execute("git", args, {cwd: root, maxBuffer: 16 * 1024 * 1024})).stdout.trim();
const issuerHash = (repository, owner) => hash(canonical({repository: repository.toLowerCase(), repository_owner_id: owner.id}));

// gh owns existing credentials. Structured JSON travels on stdin, never shell
// text or command-line token arguments; no response logs are published.
export async function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", endpoint, "--method", method, "-H", "Accept: application/vnd.github+json", ...(body === undefined ? [] : ["--input", "-"])], {stdio: ["pipe", "pipe", "pipe"]});
    const output = [], errors = []; let size = 0;
    child.stdout.on("data", value => {size += value.length; if (size > 4 * 1024 * 1024) child.kill(); else output.push(value);});
    child.stderr.on("data", value => errors.push(value)); child.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => {
      if (code !== 0 || size > 4 * 1024 * 1024) {const status = Buffer.concat(errors).toString().match(/\b(?:4\d\d|5\d\d)\b/)?.[0]; const error = new Error(`GitHub validation transport request failed (${status ?? code})`); error.status = status ? Number(status) : null; reject(error);}
      else try {resolve(JSON.parse(Buffer.concat(output).toString()));} catch (error) {reject(error);}
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function verifyEnvelope(envelope, {repository, owner, sourceCommit, sourceTree}) {
  const keys = ["schema", "repository", "source_commit", "source_tree", "contract_sha256", "issuer_sha256", "checks"];
  if (!envelope || Object.keys(envelope).sort().join() !== keys.sort().join() || envelope.schema !== "my-crm.public-command-validation/v1"
      || envelope.repository.toLowerCase() !== repository.toLowerCase() || envelope.source_commit !== sourceCommit || envelope.source_tree !== sourceTree
      || envelope.contract_sha256 !== validationContractHash || envelope.issuer_sha256 !== issuerHash(repository, owner) || !Array.isArray(envelope.checks)) throw new Error("Native validation envelope source, repository, issuer or command contract changed");
  const seen = new Set();
  for (const check of envelope.checks) {
    if (Object.keys(check).sort().join() !== ["command", "coverage", "executions"].sort().join() || !requiredCommands.some(command => canonical(command) === canonical(check.command))
        || seen.has(commandKey(check.command)) || !["EXACT_INPUT_EXECUTION", "BASELINE_PLUS_FOCUSED_REPAIR"].includes(check.coverage) || !Array.isArray(check.executions) || !check.executions.length) throw new Error("Native validation check identity/coverage is invalid or duplicated");
    seen.add(commandKey(check.command));
    for (const record of check.executions) {
      const allowed = ["record_sha256", "command_sha256", "input_sha256", "executable_sha256", "environment_sha256", "output_sha256", "original_environment"];
      if (Object.keys(record).sort().join() !== [...allowed].sort().join() || allowed.slice(0, 6).some(key => !digestPattern.test(record[key] ?? ""))) throw new Error("Native validation original execution hashes are invalid");
      const environment = record.original_environment;
      if (environment !== null && (Object.keys(environment).sort().join() !== ["node", "platform", "architecture"].sort().join() || !/^v\d+\.\d+\.\d+$/.test(environment.node)
          || !["darwin", "linux", "win32"].includes(environment.platform) || !["arm64", "x64", "ia32", "arm", "ppc64", "s390x", "riscv64"].includes(environment.architecture))) throw new Error("Native validation environment metadata is not safe and truthful");
    }
    if (check.coverage === "EXACT_INPUT_EXECUTION" && (check.executions.length !== 1 || check.executions[0].command_sha256 !== commandKey(check.command))) throw new Error("Native validation execution does not establish its required command");
  }
  // This schema has no path/value/log/review fields. Content below is only
  // canonical command identity, opaque hashes and enumerated platform metadata.
  return envelope;
}

const publicExecution = record => ({record_sha256: record.record_sha256, command_sha256: commandKey(record.command), input_sha256: hash(canonical(record.before)),
  executable_sha256: hash(canonical(record.executable)), environment_sha256: record.before.context.environment, output_sha256: record.output_sha256,
  original_environment: record.recorder_environment ?? null});

export async function collectNativeChecks({root, sourceCommit, sourceTree, admission}) {
  const {readMetadataFile} = await import("./oracle-inputs.mjs");
  const {readValidationProofs} = await import("./oracle-validation.mjs");
  const owner = await git(root, ["rev-parse", "--absolute-git-dir"]), directory = path.join(owner, "oracle");
  const receipt = JSON.parse(await readMetadataFile(path.join(directory, "technical-receipts", `${admission.technical_receipt_sha256}.json`), "utf8", {root: owner}));
  if (receipt.verdict !== "APPROVED" || receipt.review_status !== "COMPLETE" || receipt.reviewed_tree !== sourceTree || receipt.receipt_sha256 !== admission.technical_receipt_sha256
      || (receipt.candidate_commit ?? sourceCommit) !== sourceCommit) throw new Error("CI export requires the exact complete independent native decision");
  const proofs = (await readValidationProofs({root, directory, validation: receipt.input_binding.validation, checkCurrentExecutable: false})).filter(proof => proof.eligible);
  const publicFiles = Object.fromEntries((await git(root, ["ls-tree", "-rz", sourceTree])).split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t")).split(" ")[2]]));
  const authorities = Object.fromEntries((receipt.input_binding.authorities ?? []).map(item => [item.path, item.sha256]));
  const exactInputs = record => {
    const current = {...publicFiles, ...authorities};
    if (Object.keys(publicFiles).some(name => record.before.files[name] !== current[name])) return false;
    return Object.entries(record.before.files).every(([name, value]) => Object.hasOwn(current, name) ? current[name] === value : value === null);
  };
  const checks = requiredCommands.flatMap(command => {
    const proof = proofs.find(proof => canonical(proof.record.command) === canonical(command) && exactInputs(proof.record));
    return proof ? [{command, coverage: "EXACT_INPUT_EXECUTION", executions: [publicExecution(proof.record)]}] : [];
  });
  // A focused repair never turns a failed aggregate into a passing execution.
  // A composed claim needs an exact candidate manifest explicitly assessed by
  // the independent reviewer, binding each original passing execution.
  for (const evidence of receipt.input_binding.validation) {
    if (evidence.kind !== "file") continue;
    const filename = path.resolve(root, evidence.value.replace(/^@/, ""));
    if (!filename.startsWith(`${path.resolve(root, "Vault/tmp")}${path.sep}`) || !filename.endsWith(".json")) continue;
    let manifest; try {manifest = JSON.parse(await readFile(filename));} catch {continue;}
    if (manifest.schema !== "my-crm.required-command-coverage/v1") continue;
    if (hash(await readFile(filename)) !== evidence.sha256 || !Array.isArray(manifest.checks)) throw new Error("Focused required-command manifest changed or is malformed");
    // Native continuation retains original evidence. Historical manifests are
    // immutable supporting facts, never current command-coverage authority.
    if (manifest.source_commit !== sourceCommit || manifest.source_tree !== sourceTree) continue;
    const assessed = [...receipt.coverage ?? [], ...receipt.reused_coverage ?? []].some(item => item.criteria?.includes("required-command-coverage") && item.evidence?.includes(evidence.value));
    if (!assessed) throw new Error("Focused command coverage lacks an explicit exact-candidate independent assessment");
    for (const check of manifest.checks) {
      if (checks.some(item => canonical(item.command) === canonical(check.command))) continue;
      if (!requiredCommands.some(command => canonical(command) === canonical(check.command)) || !Array.isArray(check.executions) || !check.executions.length) throw new Error("Focused command coverage is incomplete");
      const records = check.executions.map(id => proofs.find(proof => proof.record.record_sha256 === id)?.record);
      if (records.some(record => !record) || !records.some(record => canonical(record.command) === canonical(check.command))) throw new Error("Focused coverage requires the original passing required-command baseline and every passing repair proof");
      checks.push({command: check.command, coverage: "BASELINE_PLUS_FOCUSED_REPAIR", executions: records.map(publicExecution)});
    }
  }
  const missing = requiredCommands.filter(command => !checks.some(check => canonical(command) === canonical(check.command)));
  if (missing.length) throw new Error(`Required native validation coverage missing: ${missing.map(command => command.join(" ")).join("; ")}`);
  return checks;
}

export async function exportNativeValidation({root = process.cwd(), repository, sourceCommit, sourceTree, admission, remote = "origin", api = githubRequest, collect = collectNativeChecks, pushSource = async args => git(root, args)} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("Validation export requires exact GitHub repository/source identities");
  const metadata = await api("GET", `repos/${repository}`), actor = await api("GET", "user");
  if (actor.id !== metadata.owner.id) throw new Error("Only the authenticated repository owner can issue native validation attestations");
  const checks = await collect({root, sourceCommit, sourceTree, admission});
  const envelope = verifyEnvelope({schema: "my-crm.public-command-validation/v1", repository, source_commit: sourceCommit, source_tree: sourceTree,
    contract_sha256: validationContractHash, issuer_sha256: issuerHash(repository, metadata.owner), checks}, {repository, owner: metadata.owner, sourceCommit, sourceTree});
  let source;
  try {source = await api("GET", `repos/${repository}/git/commits/${sourceCommit}`);} catch (error) {
    if (error.status !== 404) throw error;
    await pushSource(["push", remote, `${sourceCommit}:refs/heads/codex/validation-source-${sourceCommit}`]);
    source = await api("GET", `repos/${repository}/git/commits/${sourceCommit}`);
  }
  if (source.sha !== sourceCommit || source.tree?.sha !== sourceTree) throw new Error("GitHub source object differs from the exact native candidate");
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`), blob = await api("POST", `repos/${repository}/git/blobs`, {content: bytes.toString("base64"), encoding: "base64"});
  if (blob.sha !== gitBlobHash(bytes)) throw new Error("GitHub stored a different native validation blob");
  // Keep the immutable blob reachable through an evidence-only ref. No product
  // branch, source, package or public runtime contract changes here.
  const tree = await api("POST", `repos/${repository}/git/trees`, {tree: [{path: "validation.json", mode: "100644", type: "blob", sha: blob.sha}]});
  const commit = await api("POST", `repos/${repository}/git/commits`, {message: `Native command coverage for ${sourceCommit}`, tree: tree.sha, parents: [sourceCommit]});
  const ref = `refs/heads/codex/validation-evidence-${sourceCommit}-${blob.sha}`;
  try {await api("POST", `repos/${repository}/git/refs`, {ref, sha: commit.sha});}
  catch (error) {const existing = await api("GET", `repos/${repository}/git/ref/${ref.slice(5)}`), retained = await api("GET", `repos/${repository}/git/commits/${existing.object?.sha}`);
    if (retained.tree?.sha !== tree.sha || !retained.parents?.some(parent => parent.sha === sourceCommit)) throw error;}
  const description = `sha256:${hash(bytes)}`, target_url = `https://api.github.com/repos/${repository}/git/blobs/${blob.sha}`;
  const status = await api("POST", `repos/${repository}/statuses/${sourceCommit}`, {state: "success", context: validationContext, description, target_url});
  if (status.creator?.id !== metadata.owner.id || status.state !== "success") throw new Error("GitHub status issuer differs from the validated owner");
  return {source_commit: sourceCommit, source_tree: sourceTree, envelope_sha256: hash(bytes), blob_sha: blob.sha, status_context: validationContext};
}

export async function importNativeValidation({repository, sourceCommit, sourceTree, api = githubRequest} = {}) {
  const result = {covered: [], invalidated: [], provenance: "ORIGINAL_NATIVE_EXECUTION"};
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("CI source identity is missing");
    const metadata = await api("GET", `repos/${repository}`);
    let status;
    for (let page = 1; page <= 10 && !status; page++) {
      const rows = await api("GET", `repos/${repository}/commits/${sourceCommit}/statuses?per_page=100&page=${page}`);
      status = rows.find(item => item.context === validationContext && item.creator?.id === metadata.owner.id);
      if (rows.length < 100) break;
    }
    if (!status || status.state !== "success") throw new Error("Passing repository-owner native validation status is absent");
    const prefix = `https://api.github.com/repos/${repository}/git/blobs/`, blobSha = status.target_url?.startsWith(prefix) ? status.target_url.slice(prefix.length) : "";
    if (!oid.test(blobSha) || !/^sha256:[a-f0-9]{64}$/.test(status.description ?? "")) throw new Error("Native status target or digest is invalid");
    const blob = await api("GET", `repos/${repository}/git/blobs/${blobSha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.content.length > 1024 * 1024) throw new Error("Native validation blob encoding/size is invalid");
    const bytes = Buffer.from(blob.content, "base64");
    if (gitBlobHash(bytes) !== blobSha || hash(bytes) !== status.description.slice(7)) throw new Error("Native validation blob/output digest changed");
    const envelope = verifyEnvelope(JSON.parse(bytes), {repository, owner: metadata.owner, sourceCommit, sourceTree});
    result.covered = envelope.checks.map(check => ({command: check.command, coverage: check.coverage, original_executions: check.executions}));
  } catch (error) {result.invalidated.push({reason: error.message});}
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "import") throw new Error("Transport export runs only during completed native validation preparation");
  const sourceCommit = await git(process.cwd(), ["rev-parse", "HEAD"]), sourceTree = await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]);
  console.log(JSON.stringify(await importNativeValidation({repository: process.env.GITHUB_REPOSITORY, sourceCommit, sourceTree})));
}
