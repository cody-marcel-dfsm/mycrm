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

async function boundedRead(filename, maximum = 2 * 1024 * 1024) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) throw new Error("Prepared publication proof must be a bounded regular file");
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
const attemptName = (directory, commit, tree) => path.join(directory, `${commit}-${tree}.attempt`);
// A newly issued receipt remains pending until both native terminal writes
// succeed. Historical receipts retain their original admission contract.
export async function terminalAdmissionComplete({owner, receipt, read = filename => boundedRead(filename, 16 * 1024 * 1024)}) {
  const admission = receipt.native_terminal_admission;
  if (!admission) return true;
  const uuid = /^[a-f0-9-]{36}$/;
  if (!uuid.test(admission.invocation_id ?? "") || admission.controller_id !== null && !uuid.test(admission.controller_id ?? "")) throw new Error("Native terminal admission identity is malformed");
  const load = async (kind, id) => {
    const directory = path.join(owner, "oracle", kind, id);
    try {
      for (const name of [path.dirname(directory), directory]) {const stat = await lstat(name); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Native terminal admission custody changed");}
      return JSON.parse(await read(path.join(directory, "outcome.json")));
    } catch (error) {if (error.code === "ENOENT") return null; throw error;}
  };
  const run = await load("runs", admission.invocation_id);
  if (!run || run.outcome !== "APPROVED") return false;
  if (run.kind !== "review" || run.receipt_sha256 !== receipt.receipt_sha256 || run.candidate_commit !== receipt.candidate_commit) throw new Error("Native run terminal admission differs from its receipt");
  if (admission.controller_id === null) return true;
  const controller = await load("controllers", admission.controller_id);
  if (!controller) return false;
  const {sha256, ...value} = controller;
  if (sha256 !== hash(canonical(value)) || controller.controller_id !== admission.controller_id) throw new Error("Native controller terminal admission changed");
  if (controller.outcome !== "APPROVED" || controller.error) return false;
  // One controller may retain several completed attempts while later source or
  // evidence arrives. Only its final selected receipt attains live admission.
  if (controller.result?.receipt_sha256 !== receipt.receipt_sha256 || controller.result?.candidate_commit !== receipt.candidate_commit) return false;
  return true;
}
function coverageIdentity(coverage) {
  if (coverage.plan) {
    const {receipt, effects, commit, tree, reviewedCommit} = coverage.plan;
    const observations = [...receipt.coverage ?? [], ...receipt.reused_coverage ?? []].map(item => ({path: item.path,
      dependencies: [...item.dependencies ?? []].sort(), criteria: [...item.criteria ?? []].sort()})).sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return canonical({commit, tree, reviewedCommit, inputs: receipt.input_binding, observations,
      api_version_assessment: receipt.api_version_assessment, authentication_impact: receipt.authentication_impact,
      effects: effects.map(item => ({key: item.receipt.receipt_sha256 === receipt.receipt_sha256 ? `current:${item.effect.id}` : item.key, effect: item.effect})),
      baseline: receipt.deployment_baseline_commit});
  }
  return canonical(coverage.admitted);
}
async function readDecision(current, sourceCommit, sourceTree, filename = decisionName(current.directory, sourceCommit, sourceTree), resolveAdmission = true) {
  const record = JSON.parse(await boundedRead(filename));
  if (record.schema !== "my-crm.publication-decision/v1" || record.purpose !== "product-publication" || record.record_sha256 !== digest(record)
      || record.repository_root !== current.root || record.source_commit !== sourceCommit || record.source_tree !== sourceTree
      || !["IN_PROGRESS", "APPROVED", "REJECTED", "INVALIDATED_CRITERIA", "INCOMPLETE", "ERROR"].includes(record.status)
      || typeof record.decision_id !== "string" || !record.decision_id
      || record.validation_plan_sha256 != null && !sha.test(record.validation_plan_sha256)
      || record.status === "APPROVED" && !sha.test(record.technical_receipt_sha256 ?? "")) throw new Error("Native publication decision is malformed or bound to another candidate");
  if (resolveAdmission && record.status === "APPROVED" && !await terminalAdmissionComplete({owner: current.owner, receipt: {native_terminal_admission: record.native_terminal_admission, receipt_sha256: record.technical_receipt_sha256, candidate_commit: sourceCommit}})) {
    if (record.previous_ready_sha256) {
      if (!sha.test(record.previous_ready_sha256)) throw new Error("Previous native publication readiness identity is malformed");
      const previous = await readDecision(current, sourceCommit, sourceTree, path.join(current.directory, `${record.previous_ready_sha256}.decision.json`), false);
      if (previous.status !== "APPROVED" || previous.record_sha256 !== record.previous_ready_sha256 || !await terminalAdmissionComplete({owner: current.owner, receipt: {native_terminal_admission: previous.native_terminal_admission, receipt_sha256: previous.technical_receipt_sha256, candidate_commit: sourceCommit}})) throw new Error("Previous native publication readiness lacks complete terminal admission");
      return previous;
    }
    return {...record, status: "IN_PROGRESS", admission_state: "PENDING_NATIVE_TERMINAL"};
  }
  return record;
}

// The native review writer advances one bounded candidate-specific decision.
// Unrelated source commits and proposal attempts never change this identity.
export async function recordPublicationDecision({root = process.cwd(), sourceCommit, sourceTree, status, receipt = null, decisionId = randomUUID(), ifAbsent = false, expectedDecisionId = null, expectedReadinessSha = null, validationPlan = null, admitted = null, invalidationReason = null} = {}) {
  if (!oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "") || !["IN_PROGRESS", "APPROVED", "REJECTED", "INVALIDATED_CRITERIA", "INCOMPLETE", "ERROR"].includes(status)
      || status === "APPROVED" && !sha.test(receipt ?? "")) throw new Error("Native publication decision requires an exact candidate and outcome");
  const current = await layout(root, true);
  let previousReady;
  if (status === "APPROVED") try {const prior = await readDecision(current, sourceCommit, sourceTree); if (prior.status === "APPROVED") previousReady = prior.record_sha256;} catch (error) {if (error.code !== "ENOENT") throw error;}
  let validationPlanHash = null;
  if (validationPlan || admitted) {
    const coverage = {schema: "my-crm.publication-validation-coverage/v1", source_commit: sourceCommit, source_tree: sourceTree, technical_receipt_sha256: receipt, plan: validationPlan, admitted};
    if (status !== "APPROVED" || validationPlan && (validationPlan.commit !== sourceCommit || validationPlan.tree !== sourceTree || validationPlan.receipt?.receipt_sha256 !== receipt)
        || admitted && (admitted.source_commit !== sourceCommit || admitted.target_tree !== sourceTree || admitted.technical_receipt_sha256 !== receipt)) throw new Error("Sealed validation coverage differs from its exact candidate decision");
    validationPlanHash = hash(canonical(coverage));
    const coverageFile = path.join(current.directory, `${validationPlanHash}.coverage.json`), coverageBytes = `${JSON.stringify(coverage)}\n`;
    try {await writeFile(coverageFile, coverageBytes, {flag: "wx", mode: 0o600});} catch (error) {if (error.code !== "EEXIST" || !(await boundedRead(coverageFile)).equals(Buffer.from(coverageBytes))) throw error;}
  }
  const record = {schema: "my-crm.publication-decision/v1", purpose: "product-publication", repository_root: current.root, source_commit: sourceCommit, source_tree: sourceTree,
    status, technical_receipt_sha256: receipt, decision_id: decisionId, validation_plan_sha256: validationPlanHash,
    ...(invalidationReason === null ? {} : {invalidation_reason: invalidationReason}),
    ...(validationPlan?.receipt.native_terminal_admission ? {native_terminal_admission: validationPlan.receipt.native_terminal_admission, ...(previousReady ? {previous_ready_sha256: previousReady} : {})} : {})};
  record.record_sha256 = digest(record);
  const filename = path.join(current.directory, `${record.record_sha256}.decision.json`), bytes = `${JSON.stringify(record, null, 2)}\n`;
  try { await writeFile(filename, bytes, {flag: "wx", mode: 0o600}); }
  catch (error) { if (error.code !== "EEXIST" || !(await boundedRead(filename)).equals(Buffer.from(bytes))) throw error; }
  const pointer = decisionName(current.directory, sourceCommit, sourceTree);
  const attempt = attemptName(current.directory, sourceCommit, sourceTree);
  if (expectedReadinessSha && (await readDecision(current, sourceCommit, sourceTree)).record_sha256 !== expectedReadinessSha) return record;
  if (ifAbsent) {
    try { await writeFile(pointer, bytes, {flag: "wx", mode: 0o600}); }
    catch (error) { if (error.code !== "EEXIST") throw error; return readDecision(current, sourceCommit, sourceTree); }
  } else if (expectedDecisionId) {
    const active = await readDecision(current, sourceCommit, sourceTree, attempt, false);
    if (active.decision_id !== expectedDecisionId) return record;
  }
  await replacePointer(attempt, bytes);
  if (status === "APPROVED") {
    let prior; try {prior = await readDecision(current, sourceCommit, sourceTree);} catch (error) {if (error.code !== "ENOENT") throw error;}
    if (prior?.status === "APPROVED" && prior.validation_plan_sha256 && validationPlanHash) {
      const previous = JSON.parse(await boundedRead(path.join(current.directory, `${prior.validation_plan_sha256}.coverage.json`)));
      const next = JSON.parse(await boundedRead(path.join(current.directory, `${validationPlanHash}.coverage.json`)));
      if (hash(canonical(previous)) !== prior.validation_plan_sha256) throw new Error("Original validated coverage seal changed");
      if (coverageIdentity(previous) === coverageIdentity(next)) return prior;
    } else if (prior?.status === "APPROVED" && !validationPlanHash && prior.technical_receipt_sha256 === receipt) return prior;
  }
  if (["IN_PROGRESS", "INCOMPLETE", "ERROR"].includes(status)) {
    let prior; try { prior = await readDecision(current, sourceCommit, sourceTree); } catch (error) { if (error.code !== "ENOENT") throw error; }
    // Raw attempts retain their own immutable outcome. Explicit candidate
    // defects/criteria invalidation remain separate from still-applicable
    // complete coverage, so a process failure supplies no replacement verdict.
    if (prior && ["APPROVED", "REJECTED", "INVALIDATED_CRITERIA"].includes(prior.status)) return record;
  }
  if (!ifAbsent) await replacePointer(pointer, bytes);
  return record;
}

export async function sealPublicationValidation({root = process.cwd(), sourceCommit, sourceTree, receipt, decisionId, expectedDecisionId, expectedReadinessSha, plan, ifAbsent = false} = {}) {
  const validationPlan = plan ?? await (await import("./oracle-deployment.mjs")).deploymentPlan({root, reference: sourceCommit});
  return recordPublicationDecision({root, sourceCommit, sourceTree, receipt, decisionId, expectedDecisionId, expectedReadinessSha, ifAbsent, status: "APPROVED", validationPlan});
}

async function validationTransport(current, {repository, sourceCommit, sourceTree, remote, admission, attest}) {
  const transport = await import("./validation-transport.mjs");
  const binding = {repository: repository.toLowerCase(), source_commit: sourceCommit, source_tree: sourceTree,
    technical_receipt_sha256: admission.technical_receipt_sha256, contract_sha256: transport.validationContractHash};
  const filename = path.join(current.directory, `${hash(canonical(binding))}.transport.json`);
  try {
    const prior = JSON.parse(await boundedRead(filename));
    if (prior.record_sha256 !== digest(prior) || canonical(prior.binding) !== canonical(binding) || prior.schema !== "my-crm.prepared-validation-transport/v1") throw new Error("Prepared validation transport seal changed");
    return prior.result;
  } catch (error) {if (error.code !== "ENOENT") throw error;}
  const result = await (attest ?? transport.exportNativeValidation)({root: current.root, repository, sourceCommit, sourceTree, remote, admission});
  const record = {schema: "my-crm.prepared-validation-transport/v1", binding, result}; record.record_sha256 = digest(record);
  const bytes = `${JSON.stringify(record)}\n`;
  try {await writeFile(filename, bytes, {flag: "wx", mode: 0o600});}
  catch (error) {if (error.code !== "EEXIST" || !(await boundedRead(filename)).equals(Buffer.from(bytes))) throw error;}
  return result;
}

async function admittedCoverage(current, decision) {
  if (!decision.validation_plan_sha256) return null;
  const coverage = JSON.parse(await boundedRead(path.join(current.directory, `${decision.validation_plan_sha256}.coverage.json`)));
  if (hash(canonical(coverage)) !== decision.validation_plan_sha256 || coverage.schema !== "my-crm.publication-validation-coverage/v1" || coverage.source_commit !== decision.source_commit
      || coverage.source_tree !== decision.source_tree || coverage.technical_receipt_sha256 !== decision.technical_receipt_sha256) throw new Error("Native validated command coverage seal changed");
  if (coverage.plan) {
    // Current governing criteria are a bounded preparation admission. Original
    // source/output/history proofs stay sealed and are never replayed here.
    if (coverage.plan.receipt.input_binding?.authorities?.length) {
      try {await (await import("./shipment-state.mjs")).checkpointSelectionApplicable(current.root, {receipt: coverage.plan.receipt});}
      catch (error) {
        if (/Governing authority/.test(error.message)) await recordPublicationDecision({root: current.root, sourceCommit: decision.source_commit, sourceTree: decision.source_tree, status: "INVALIDATED_CRITERIA", invalidationReason: error.message});
        throw error;
      }
    }
    return (await import("./oracle-deployment.mjs")).admitDeploymentPlan({root: current.root, plan: coverage.plan});
  }
  if (coverage.admitted?.protected_effects?.length) throw new Error("Protected effect admission requires its sealed native effect plan");
  return coverage.admitted;
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
  let decision;
  try { decision = await readDecision(current, source_commit, source_tree); }
  catch (error) {if (error.code !== "ENOENT") throw error;}
  if (decision && decision.status !== "APPROVED") throw new Error("Publication preparation requires the latest native candidate approval");
  let admission = decision?.status === "APPROVED" ? await admittedCoverage(current, decision) : null;
  if (!admission) {
    // One explicit legacy import audit establishes an immutable coverage seal.
    // Repeated same-CL preparation consumes that seal without proof traversal.
    if (admit) {
      admission = await admit({root: current.root, reference: source_commit});
      decision = await recordPublicationDecision({root: current.root, sourceCommit: source_commit, sourceTree: source_tree, status: "APPROVED", receipt: admission.technical_receipt_sha256, admitted: admission, decisionId: decision?.decision_id ?? `imported:${admission.technical_receipt_sha256}`, ifAbsent: !decision, expectedReadinessSha: decision?.record_sha256});
    } else {
      const native = await import("./oracle-deployment.mjs"), plan = await native.deploymentPlan({root: current.root, reference: source_commit});
      admission = await native.admitDeploymentPlan({root: current.root, plan});
      decision = await sealPublicationValidation({root: current.root, sourceCommit: source_commit, sourceTree: source_tree, receipt: admission.technical_receipt_sha256, plan, decisionId: decision?.decision_id ?? `imported:${admission.technical_receipt_sha256}`, ifAbsent: !decision, expectedReadinessSha: decision?.record_sha256});
    }
  }
  if (admission.status !== "ADMITTED" || admission.source_commit !== source_commit || admission.target_tree !== source_tree) throw new Error("Publication preparation requires complete exact-source validation and effect admission");
  if (decision.status !== "APPROVED" || decision.technical_receipt_sha256 !== admission.technical_receipt_sha256) throw new Error("Publication preparation requires the latest native candidate approval");
  const github = remoteUrl.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  const validation_transport = github ? await validationTransport(current, {repository: github[1], sourceCommit: source_commit, sourceTree: source_tree, remote, admission, attest}) : null;
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
