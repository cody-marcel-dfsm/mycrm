// Publication deliberately loads only Node builtins. Full source, validation,
// receipt and effect admission occurs in preparePublication, before Git push.
import {createHash, randomUUID} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {constants} from "node:fs";
import {lstat, mkdir, open, realpath, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execute = promisify(execFile);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = ({record_sha256: _ignored, ...record}) => hash(canonical(record));
const oid = /^[a-f0-9]{40}$/, sha = /^[a-f0-9]{64}$/, zeros = "0".repeat(40);
const git = async (root, args) => (await execute("git", args, {cwd: root, maxBuffer: 4 * 1024 * 1024})).stdout.trim();
export const publicationRef = ref => ref === "refs/heads/main" || /^refs\/(?:tags\/v|heads\/codex\/release-v)\d+\.\d+\.\d+$/.test(ref);
const tuple = record => ({source_commit: record.source_commit, remote_name: record.remote_name, remote_url_sha256: record.remote_url_sha256, target_ref: record.target_ref, remote_before: record.remote_before});
const tupleHash = record => hash(canonical(tuple(record)));

async function layout(root, create = false) {
  root = await realpath(root);
  const owner = await git(root, ["rev-parse", "--absolute-git-dir"]), directory = path.join(owner, "oracle", "publication-prepared");
  for (const name of [owner, path.join(owner, "oracle"), directory]) {
    if (create) await mkdir(name, {recursive: true, mode: 0o700});
    const metadata = await lstat(name);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Prepared publication requires canonical private metadata directories");
  }
  return {root, owner, directory};
}

async function boundedRead(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) throw new Error("Prepared publication proof must be a bounded regular file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function replacePointer(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, {flag: "wx", mode: 0o600});
    try { if (!(await lstat(filename)).isFile()) throw new Error("Publication decision pointer must be a regular file"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, filename);
  } finally { await rm(temporary, {force: true}); }
}

const decisionName = (directory, commit, tree) => path.join(directory, `${commit}-${tree}.decision`);
async function readDecision(current, sourceCommit, sourceTree) {
  const record = JSON.parse(await boundedRead(decisionName(current.directory, sourceCommit, sourceTree)));
  if (record.schema !== "my-crm.publication-decision/v1" || record.purpose !== "product-publication" || record.record_sha256 !== digest(record)
      || record.repository_root !== current.root || record.source_commit !== sourceCommit || record.source_tree !== sourceTree
      || !["IN_PROGRESS", "APPROVED", "REJECTED", "INVALIDATED_CRITERIA", "INCOMPLETE", "ERROR"].includes(record.status)
      || typeof record.decision_id !== "string" || !record.decision_id
      || record.status === "APPROVED" && !sha.test(record.technical_receipt_sha256 ?? "")) throw new Error("Native publication decision is malformed or bound to another candidate");
  return record;
}

// The native review writer advances one bounded candidate-specific decision.
// Unrelated source commits and proposal attempts never change this identity.
export async function recordPublicationDecision({root = process.cwd(), sourceCommit, sourceTree, status, receipt = null, decisionId = randomUUID(), ifAbsent = false, expectedDecisionId = null} = {}) {
  if (!oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "") || !["IN_PROGRESS", "APPROVED", "REJECTED", "INVALIDATED_CRITERIA", "INCOMPLETE", "ERROR"].includes(status)
      || status === "APPROVED" && !sha.test(receipt ?? "")) throw new Error("Native publication decision requires an exact candidate and outcome");
  const current = await layout(root, true);
  const record = {schema: "my-crm.publication-decision/v1", purpose: "product-publication", repository_root: current.root, source_commit: sourceCommit, source_tree: sourceTree,
    status, technical_receipt_sha256: receipt, decision_id: decisionId};
  record.record_sha256 = digest(record);
  const filename = path.join(current.directory, `${record.record_sha256}.decision.json`), bytes = `${JSON.stringify(record, null, 2)}\n`;
  try { await writeFile(filename, bytes, {flag: "wx", mode: 0o600}); }
  catch (error) { if (error.code !== "EEXIST" || !(await boundedRead(filename)).equals(Buffer.from(bytes))) throw error; }
  const pointer = decisionName(current.directory, sourceCommit, sourceTree);
  if (["IN_PROGRESS", "INCOMPLETE", "ERROR"].includes(status)) {
    let prior; try {prior = await readDecision(current, sourceCommit, sourceTree);} catch (error) {if (error.code !== "ENOENT") throw error;}
    // Preserve the new immutable attempt above. An unfinished or failed
    // process grants no decision and cannot revoke an earlier complete one.
    if (prior && ["APPROVED", "REJECTED", "INVALIDATED_CRITERIA"].includes(prior.status)) return prior;
  }
  if (ifAbsent) {
    try { await writeFile(pointer, bytes, {flag: "wx", mode: 0o600}); }
    catch (error) { if (error.code !== "EEXIST") throw error; return readDecision(current, sourceCommit, sourceTree); }
  } else {
    // A superseded attempt retains its immutable literal outcome without
    // replacing the later whole-assessment decision for this same candidate.
    if (expectedDecisionId && (await readDecision(current, sourceCommit, sourceTree)).decision_id !== expectedDecisionId) return record;
    await replacePointer(pointer, bytes);
  }
  return record;
}

export async function publicationDecisionStatus({root = process.cwd(), sourceCommit, sourceTree} = {}) {
  try {return await readDecision(await layout(root), sourceCommit, sourceTree);} catch (error) {if (error.code === "ENOENT") return null; throw error;}
}

async function assertDecision(current, record) {
  const decision = await readDecision(current, record.source_commit, record.source_tree);
  if (decision.status !== "APPROVED" || decision.technical_receipt_sha256 !== record.admission.technical_receipt_sha256
      || decision.record_sha256 !== record.decision_sha256) throw new Error("Prepared publication was superseded by a later native candidate decision");
}

function verify(record, filename, directory) {
  if (record.schema !== "my-crm.publication-prepared/v1" || !sha.test(record.record_sha256 ?? "") || record.record_sha256 !== digest(record)
      || path.dirname(filename) !== directory || path.basename(filename) !== `${tupleHash(record)}-${record.record_sha256}.json`
      || !oid.test(record.source_commit ?? "") || record.source_commit === zeros || !oid.test(record.source_tree ?? "") || !oid.test(record.remote_before ?? "")
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(record.remote_name ?? "") || !sha.test(record.remote_url_sha256 ?? "") || !publicationRef(record.target_ref)
      || record.admission?.status !== "ADMITTED" || record.admission.source_commit !== record.source_commit || record.admission.target_tree !== record.source_tree
      || !sha.test(record.admission.technical_receipt_sha256 ?? "") || !sha.test(record.admission.plan_sha256 ?? "")
      || !sha.test(record.decision_sha256 ?? "")
      || !Array.isArray(record.command_tracking?.changelists) || record.command_tracking.changelists.some(item => !oid.test(item.commit_sha ?? "") || !oid.test(item.tree_sha ?? ""))) {
    throw new Error("Prepared publication proof is malformed, changed or bound to another candidate");
  }
  return record;
}

export async function readPreparedPublication(filename, {root = process.cwd()} = {}) {
  const current = await layout(root), absolute = path.resolve(filename);
  const bytes = await boundedRead(absolute), record = verify(JSON.parse(bytes), absolute, current.directory);
  if (record.repository_root !== current.root) throw new Error("Prepared publication proof belongs to another canonical repository");
  await assertDecision(current, record);
  return {record, filename: absolute, sha256: hash(bytes)};
}

export async function preparePublication({root = process.cwd(), reference = "HEAD", remote = "origin", target = "refs/heads/main", remoteBefore, admit, attest} = {}) {
  const current = await layout(root, true);
  if (!publicationRef(target) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(remote)) throw new Error("Publication preparation requires an exact product ref and configured remote name");
  const source_commit = await git(current.root, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]);
  const source_tree = await git(current.root, ["rev-parse", `${source_commit}^{tree}`]);
  const remoteUrl = await git(current.root, ["remote", "get-url", "--push", "--all", remote]);
  if (!remoteUrl || remoteUrl.includes("\n")) throw new Error("Prepared publication requires exactly one fixed push URL");
  const advertised = await git(current.root, ["ls-remote", "--refs", remote, target]);
  const actualRemote = advertised ? advertised.split(/\s+/)[0] : zeros;
  if (!oid.test(actualRemote) || remoteBefore !== undefined && remoteBefore !== actualRemote) throw new Error("Publication remote baseline changed; refresh preparation before publishing");
  if (actualRemote !== zeros) {
    if (target.startsWith("refs/tags/")) throw new Error("Existing release tags cannot be replaced by prepared publication");
    await git(current.root, ["merge-base", "--is-ancestor", actualRemote, source_commit]);
  }
  const admission = await (admit ?? (await import("./oracle-deployment.mjs")).admitDeployment)({root: current.root, reference: source_commit});
  if (admission.status !== "ADMITTED" || admission.source_commit !== source_commit || admission.target_tree !== source_tree) throw new Error("Publication preparation requires complete exact-source validation and effect admission");
  let decision;
  try { decision = await readDecision(current, source_commit, source_tree); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Adopt an existing exact native receipt once when upgrading older state.
    decision = await recordPublicationDecision({root: current.root, sourceCommit: source_commit, sourceTree: source_tree, status: "APPROVED", receipt: admission.technical_receipt_sha256, decisionId: `adopted:${admission.technical_receipt_sha256}`, ifAbsent: true});
  }
  if (decision.status !== "APPROVED" || decision.technical_receipt_sha256 !== admission.technical_receipt_sha256) throw new Error("Publication preparation requires the latest native candidate approval");
  const github = remoteUrl.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const validation_transport = github ? await (attest ?? (await import("./validation-transport.mjs")).exportNativeValidation)({root: current.root, repository: github[1], sourceCommit: source_commit, sourceTree: source_tree, remote, admission}) : null;
  const history = await git(current.root, ["log", "--reverse", "--format=%H %T", actualRemote === zeros ? source_commit : `${actualRemote}..${source_commit}`]);
  const changelists = history ? history.split("\n").map(line => {const [commit_sha, tree_sha] = line.split(" "); return {commit_sha, tree_sha, validated_in_candidate: source_commit};}) : [];
  const record = {schema: "my-crm.publication-prepared/v1", repository_root: current.root, source_commit, source_tree, remote_name: remote,
    remote_url_sha256: hash(remoteUrl), target_ref: target, remote_before: actualRemote, admission, validation_transport, decision_sha256: decision.record_sha256,
    command_tracking: {disposition: "VALIDATION_COMPLETE", changelists, technical_receipt_sha256: admission.technical_receipt_sha256}};
  record.record_sha256 = digest(record);
  const filename = path.join(current.directory, `${tupleHash(record)}-${record.record_sha256}.json`), bytes = `${JSON.stringify(record, null, 2)}\n`;
  verify(record, filename, current.directory);
  await assertDecision(current, record);
  try { await writeFile(filename, bytes, {flag: "wx", mode: 0o600}); }
  catch (error) { if (error.code !== "EEXIST" || !(await boundedRead(filename)).equals(Buffer.from(bytes))) throw error; }
  // The fixed tuple lookup names the latest immutable preparation. Publishing
  // reads one bounded proof, never a history/validation/evidence inventory.
  const lookup = path.join(current.directory, `${tupleHash(record)}.prepared`);
  let previous;
  try { previous = (await boundedRead(lookup)).toString(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous !== path.basename(filename)) await replacePointer(lookup, path.basename(filename));
  return {source_commit, source_tree, prepared_record: filename, prepared_record_sha256: hash(bytes), publish_argv: [process.execPath, fileURLToPath(import.meta.url), "publish", "--prepared", filename], command_tracking: record.command_tracking};
}

export async function admitPreparedPush(input, {root = process.cwd(), remote, remoteUrl} = {}) {
  let current;
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/), [localRef, source_commit, target_ref, remote_before] = fields;
    if (fields.length !== 4 || !localRef || !oid.test(source_commit ?? "") || !oid.test(remote_before ?? "")) throw new Error("Invalid prepared Git publication tuple");
    if (!publicationRef(target_ref)) continue;
    if (source_commit === zeros) throw new Error("Product reference deletion requires a separately prepared operation");
    current ??= await layout(root);
    const expected = {source_commit, target_ref, remote_before, remote_name: remote, remote_url_sha256: hash(remoteUrl ?? "")};
    const lookup = (await boundedRead(path.join(current.directory, `${tupleHash(expected)}.prepared`))).toString();
    if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(lookup)) throw new Error("Prepared publication lookup is malformed");
    const filename = path.join(current.directory, lookup), record = verify(JSON.parse(await boundedRead(filename)), filename, current.directory);
    if (record.repository_root !== current.root || canonical(tuple(record)) !== canonical(expected)) throw new Error("Git publication differs from its prepared source, remote, destination or baseline");
    await assertDecision(current, record);
  }
}

export async function publishPrepared(filename, {root = process.cwd(), run = (args, cwd) => new Promise((resolve, reject) => {
  const child = spawn("git", args, {cwd, stdio: "inherit"}); child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Prepared Git push failed: ${signal ?? code}`)));
})} = {}) {
  const {record} = await readPreparedPublication(filename, {root});
  await run(["push", record.remote_name, `${record.source_commit}:${record.target_ref}`], record.repository_root);
  return {status: "PUBLISHED", source_commit: record.source_commit, source_tree: record.source_tree, target_ref: record.target_ref};
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") {const [reference, remote, target, remoteBefore] = args; console.log(JSON.stringify(await preparePublication({reference, remote, target, remoteBefore})));}
  else if (command === "pre-push") {let input = ""; for await (const chunk of process.stdin) input += chunk; await admitPreparedPush(input, {remote: args[0], remoteUrl: args[1]});}
  else if (command === "publish" && args[0] === "--prepared" && args.length === 2) console.log(JSON.stringify(await publishPrepared(args[1])));
  else throw new Error("Usage: publication-checkpoint.mjs prepare [sourceSHA] [remote] [target-ref] [remote-before]|publish --prepared <record>|pre-push <remote> <url>");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`MYCRM_PUBLICATION=BLOCKED ${error.message}`); process.exitCode = 1;});
