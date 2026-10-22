import {execFile} from "node:child_process";
import {readFile, readdir, realpath} from "node:fs/promises";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";
import {bindingHash, contentHash, evidenceBinding, metadataDirectory, pathCustody, readMetadataFile, writeMetadataFile, assertPublishedInvocation} from "./oracle-inputs.mjs";
import {readValidationProofs} from "./oracle-validation.mjs";
import {policyModules} from "./oracle-policy.mjs";

const execute = promisify(execFile);
const hashPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const categories = new Set(["CREDENTIAL_TRUST", "PERMISSION_AUTHORITY", "TENANT_ISOLATION", "INCOMPATIBLE_PUBLIC_CONTRACT"]);
const text = (value) => typeof value === "string" && Boolean(value.trim());
const effectKey = (receipt, effect) => `${receipt}:${effect}`;
const localPath = (value) => text(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).some((part) => part === ".." || part === ".git");
const missingHistory = (message, cause) => Object.assign(new Error(message, {cause}), {code: "MYCRM_MISSING_HISTORICAL_RECEIPT"});

export function validateDeploymentAssessment(response, {required = false} = {}) {
  if (!required && response.protected_deployment_effects === undefined && response.deployment_effect_dispositions === undefined) return;
  if (!Array.isArray(response.protected_deployment_effects) || !Array.isArray(response.deployment_effect_dispositions)) throw new Error("Oracle must assess actual protected deployment effects separately from technical approval");
  const ids = new Set();
  for (const effect of response.protected_deployment_effects) {
    if (!effect || !text(effect.id) || ids.has(effect.id) || !categories.has(effect.category) || !text(effect.description) || !Array.isArray(effect.affected_paths) || !effect.affected_paths.length || !effect.affected_paths.every(localPath) || !(effect.authority === null || text(effect.authority?.quote) && path.isAbsolute(effect.authority?.evidence ?? ""))) throw new Error("Protected deployment effect is invalid or duplicated");
    ids.add(effect.id);
  }
  const dispositions = new Set();
  for (const value of response.deployment_effect_dispositions) {
    const key = effectKey(value?.receipt_sha256, value?.effect_id);
    if (!hashPattern.test(value?.receipt_sha256 ?? "") || !text(value?.effect_id) || dispositions.has(key) || !["EFFECTIVE", "REVERTED", "SUPERSEDED"].includes(value?.disposition) || !text(value?.evidence)) throw new Error("Deployment effect disposition is invalid or duplicated");
    dispositions.add(key);
  }
}

export function validateDeploymentDispositions(response, history) {
  if (response.review_status !== "COMPLETE") return;
  const required = new Set(history.flatMap(({receipt}) => receipt.protected_deployment_effects.map(({id}) => effectKey(receipt.receipt_sha256, id))));
  const supplied = response.deployment_effect_dispositions.map((value) => effectKey(value.receipt_sha256, value.effect_id));
  if (supplied.length !== required.size || supplied.some((key) => !required.has(key))) throw new Error("Completed review must independently disposition every inherited protected deployment effect");
}

async function git(root, args) {
  return (await execute("git", args, {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024})).stdout.trim();
}

async function directory(root) {
  const owner = await git(root, ["rev-parse", "--absolute-git-dir"]);
  const value = path.join(owner, "oracle");
  await metadataDirectory(owner, value);
  return {owner, value};
}

// Invocation-local immutable traversal facts. Original native bytes, absence,
// modes and transitive custody remain live acceptance inputs at return.
async function historyTraversal(root) {
  const layout = await directory(root), canonicalRoot = await realpath(root), native = new Map(), policy = new Map();
  const policyRoot = fileURLToPath(new URL(".", import.meta.url));
  const snapshot = async (filename, scopeRoot, metadata) => {
    const custody = await pathCustody(root, filename, {scopeRoot, allowMissing: true, allowFinalLink: false});
    const bytes = custody.metadata === null ? null : metadata ? await readMetadataFile(filename, {}, {root: layout.owner}) : await readFile(custody.resolved_path);
    if (custody.metadata !== null && custody.metadata.type !== "regular") throw new Error("History dependency must remain a regular file");
    return {path: filename, sha256: bytes === null ? null : contentHash(bytes), custody, bytes};
  };
  const identity = ({bytes: _bytes, ...value}) => value;
  const changed = (message, source = false) => Object.assign(new Error(message), {code: source ? "ORACLE_INPUT_DRIFT" : "ORACLE_EVIDENCE_INTEGRITY"});
  const remember = (records, value) => {
    const old = records.get(value.path);
    if (old && bindingHash(identity(old)) !== bindingHash(identity(value))) throw changed("Original deployment-history dependency changed during traversal");
    records.set(value.path, old ?? value);
  };
  for (const name of policyModules) {
    const value = await snapshot(fileURLToPath(new URL(name, import.meta.url)), policyRoot, false);
    if (value.bytes === null) throw changed("Deployment-history verifier source is missing", true);
    remember(policy, value);
  }
  const read = async (filename, encoding = null) => {
    const value = await snapshot(filename, layout.owner, true); remember(native, value);
    if (value.bytes === null) throw Object.assign(new Error(`Native history dependency is missing: ${filename}`), {code: "ENOENT"});
    return typeof encoding === "string" ? value.bytes.toString(encoding) : value.bytes;
  };
  const bindProofs = async (receipt, proofs) => {
    for (const proof of proofs) {
      const original = receipt.input_binding.validation.find(item => item.value === proof.evidence);
      const recordPath = path.resolve(root, proof.evidence.replace(/^@/, ""));
      const record = await read(recordPath);
      if (contentHash(record) !== original.sha256) throw changed("Original history validation record changed");
      const output = await read(path.resolve(root, proof.record.output_file));
      if (contentHash(output) !== proof.record.output_sha256) throw changed("Original history validation output changed");
    }
  };
  const verify = async () => {
    // Evidence wins over simultaneous source movement. Never turn damaged
    // cached native proof into a source-continuation hint.
    for (const [filename, old] of native) {
      const value = await snapshot(filename, layout.owner, true);
      if (bindingHash(identity(old)) !== bindingHash(identity(value))) throw changed("Original cached deployment-history evidence, absence or custody changed");
    }
    if (await realpath(root) !== canonicalRoot || (await directory(root)).owner !== layout.owner) throw changed("Deployment-history repository identity changed");
    for (const [filename, old] of policy) {
      const value = await snapshot(filename, policyRoot, false);
      if (bindingHash(identity(old)) !== bindingHash(identity(value))) throw changed("Deployment-history verifier source or policy changed", true);
    }
  };
  return {layout, read, bindProofs, verify, receipts: new Map(), histories: new Map()};
}

export async function archiveTechnicalReceipt(receipt, store, owner = path.dirname(store)) {
  if (receipt.verdict !== "APPROVED" || receipt.review_status !== "COMPLETE") return;
  const filename = path.join(store, "technical-receipts", `${receipt.receipt_sha256}.json`);
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try { await writeMetadataFile(filename, bytes, {flag: "wx", mode: 0o600}, {root: owner}); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await readMetadataFile(filename, "utf8", {root: owner}) !== bytes) throw new Error("Immutable technical receipt archive differs from its original bytes");
  }
  if (receipt.deployment_history_status === "UNAVAILABLE") return filename;
  const baselinePath = path.join(store, "deployment-baseline.json");
  const baseline = {schema: "my-crm.deployment-baseline/v1", commit: receipt.deployment_baseline_commit, first_receipt_sha256: receipt.receipt_sha256};
  try { await writeMetadataFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, {flag: "wx", mode: 0o600}, {root: owner}); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  if ((await readBaseline(store, owner)).commit !== receipt.deployment_baseline_commit) throw new Error("Deployment adoption baseline is immutable");
  return filename;
}

async function readBaseline(store, owner, read = (filename, encoding) => readMetadataFile(filename, encoding, {root: owner})) {
  const baseline = JSON.parse(await read(path.join(store, "deployment-baseline.json"), "utf8"));
  if (baseline.schema !== "my-crm.deployment-baseline/v1" || !commitPattern.test(baseline.commit ?? "") || !hashPattern.test(baseline.first_receipt_sha256 ?? "")) throw new Error("Deployment adoption baseline is invalid");
  const original = JSON.parse(await read(path.join(store, "technical-receipts", `${baseline.first_receipt_sha256}.json`), "utf8"));
  const {verifyReceipt} = await import("./oracle-review.mjs");
  verifyReceipt(original, original.reviewed_tree);
  if (original.receipt_sha256 !== baseline.first_receipt_sha256 || original.deployment_baseline_commit !== baseline.commit) throw new Error("Deployment adoption baseline differs from its original native technical receipt");
  return baseline;
}

export async function committedReceipt(root, reference) {
  const traversal = await historyTraversal(root), result = await cachedCommittedReceipt(root, reference, traversal);
  await traversal.verify(); return result;
}

async function cachedCommittedReceipt(root, reference, traversal) {
  const commit = commitPattern.test(reference) ? reference : await git(root, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]);
  if (traversal.receipts.has(commit)) return traversal.receipts.get(commit);
  const pending = readCommittedReceipt(root, commit, traversal); traversal.receipts.set(commit, pending);
  try { return await pending; }
  catch (error) { if (error.code !== "MYCRM_MISSING_HISTORICAL_RECEIPT") traversal.receipts.delete(commit); throw error; }
}

async function readCommittedReceipt(root, reference, traversal) {
  const {parseTrailers, verifyPublishedCommitTrailers, verifyReceipt} = await import("./oracle-review.mjs");
  const commit = await git(root, ["rev-parse", "--verify", "--end-of-options", `${reference}^{commit}`]);
  const tree = await git(root, ["rev-parse", `${commit}^{tree}`]);
  let reviewedCommit = commit;
  let message = await git(root, ["show", "-s", "--format=%B", reviewedCommit]);
  let detached = null;
  if (!parseTrailers(message)["Oracle-Verdict"]) {
    const {owner, value} = traversal.layout;
    try {
      detached = JSON.parse(await traversal.read(path.join(value, "committed-receipts", `${commit}.json`), "utf8"));
      const {checkpointDigest} = await import("./shipment-state.mjs");
      if (detached.schema !== "my-crm.shipment-validated/v1" || detached.checkpoint_sha256 !== checkpointDigest(detached) || detached.last_validated_commit !== commit || detached.tree !== tree || !hashPattern.test(detached.receipt_sha256 ?? "")) throw new Error("Detached committed-source checkpoint is malformed or changed");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!parseTrailers(message)["Oracle-Verdict"] && !detached) {
    const parents = (await git(root, ["show", "-s", "--format=%P", commit])).split(" ");
    if (parents.length !== 2 || await git(root, ["rev-parse", `${parents[1]}^{tree}`]) !== tree) throw missingHistory("Publication candidate has no exact-tree technical review stamp");
    await git(root, ["merge-base", "--is-ancestor", parents[0], parents[1]]);
    const reviewed = await cachedCommittedReceipt(root, parents[1], traversal);
    return {...reviewed, commit, tree, reviewedCommit: reviewed.reviewedCommit};
  }
  const trailers = detached ? {"Oracle-Receipt-SHA256": detached.receipt_sha256} : verifyPublishedCommitTrailers({message, tree});
  const {owner, value} = traversal.layout;
  const filename = path.join(value, "technical-receipts", `${trailers["Oracle-Receipt-SHA256"]}.json`);
  let original;
  try { original = await traversal.read(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") throw missingHistory("Original private historical technical receipt is unavailable", error); throw error; }
  const receipt = verifyReceipt(JSON.parse(original), tree);
  if (receipt.receipt_sha256 !== trailers["Oracle-Receipt-SHA256"]) throw new Error("Archived technical receipt identity differs from the reviewed commit stamp");
  const {sha256} = await import("./oracle-review.mjs");
  if (receipt.schema !== "my-crm.oracle-approval/v2" || receipt.review_status !== "COMPLETE" || receipt.reviewer?.role !== "independent-project-oracle" || receipt.reviewer.ephemeral !== true || receipt.reviewer.ignore_user_config !== true || !text(receipt.reviewer.model) || !hashPattern.test(receipt.reviewer.role_instruction_sha256 ?? "") || receipt.reviewer_metadata_sha256 !== sha256(`${JSON.stringify(receipt.reviewer, null, 2)}\n`)) throw new Error("Archived technical receipt lacks original independent reviewer custody");
  validateDeploymentAssessment(receipt, {required: true});
  const parents = (await git(root, ["show", "-s", "--format=%P", reviewedCommit])).split(" ");
  if (detached) {
    if (receipt.candidate_commit !== commit || parents[0] !== receipt.deployment_history_base_commit) throw new Error("Detached receipt differs from its exact reviewed commit or history parent");
    await git(root, ["merge-base", "--is-ancestor", receipt.base_commit, commit]);
  } else if (parents[0] !== receipt.base_commit) throw new Error("Technical receipt base differs from the reviewed source commit parent");
  const proofs = await readValidationProofs({root, directory: value, validation: receipt.input_binding?.validation ?? [], checkCurrentExecutable: false});
  await traversal.bindProofs(receipt, proofs);
  if (receipt.deployment_history_status === "UNAVAILABLE") throw missingHistory("Technical receipt lacks its sealed deployment-history binding: original readiness was UNAVAILABLE; assess the complete current range");
  if (receipt.deployment_history_status !== "READY" || !commitPattern.test(receipt.deployment_baseline_commit ?? "") || !hashPattern.test(receipt.deployment_history_sha256 ?? "")) throw new Error("Technical receipt lacks its sealed deployment-history binding");
  return {commit, tree, reviewedCommit, receipt, filename};
}

const historyDigest = (history, recovered = history.recovered_commits ?? []) => {
  const receipts = history.map(({receipt}) => ({receipt_sha256: receipt.receipt_sha256, reviewed_tree: receipt.reviewed_tree}));
  return recovered.length ? bindingHash({receipts, recovered}) : bindingHash(receipts);
};

async function historyBetween(root, baseline, target, cache, recoveryReceipt = null, traversal) {
  const cacheKey = `${baseline}:${target}:${recoveryReceipt?.receipt_sha256 ?? "none"}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  await git(root, ["merge-base", "--is-ancestor", baseline, target]);
  const commits = (await git(root, ["rev-list", "--reverse", "--topo-order", `${baseline}..${target}`])).split("\n").filter(Boolean);
  const covered = new Map((recoveryReceipt?.recovered_deployment_commits ?? []).map((item) => [item.commit, item.tree]));
  const history = [], seen = new Set(), recovered = [];
  for (const commit of commits) {
    let entry;
    try { entry = await cachedCommittedReceipt(root, commit, traversal); }
    catch (error) {
      const tree = await git(root, ["rev-parse", `${commit}^{tree}`]);
      if (error.code !== "MYCRM_MISSING_HISTORICAL_RECEIPT" || covered.get(commit) !== tree) throw error;
      recovered.push({commit, tree}); continue;
    }
    if (seen.has(entry.receipt.receipt_sha256)) continue;
    if (entry.receipt.deployment_baseline_commit !== baseline) throw new Error("Deployment history changed its sealed adoption baseline");
    if (entry.receipt.base_commit === commit) throw new Error("Deployment history has a cyclic receipt base");
    const prior = await historyBetween(root, baseline, (entry.receipt.deployment_history_base_commit ?? entry.receipt.base_commit), cache, entry.receipt, traversal);
    if (entry.receipt.deployment_history_sha256 !== historyDigest(prior)) throw new Error("Technical receipt deployment-history binding is stale or incomplete");
    validateDeploymentDispositions(entry.receipt, prior);
    history.push(entry); seen.add(entry.receipt.receipt_sha256);
  }
  history.recovered_commits = recovered;
  cache.set(cacheKey, history);
  return history;
}

export async function deploymentHistoryForReview(root = process.cwd(), {head: requestedHead = "HEAD"} = {}) {
  const head = await git(root, ["rev-parse", requestedHead]), traversal = await historyTraversal(root), {owner, value} = traversal.layout;
  let baseline = null, unavailable = null;
  try { baseline = (await readBaseline(value, owner, traversal.read)).commit; }
  catch (error) {
    let exists = true;
    try { await traversal.read(path.join(value, "deployment-baseline.json"), "utf8"); }
    catch (missing) { if (missing.code === "ENOENT") exists = false; else throw missing; }
    if (exists) unavailable = `Original deployment-history custody requires recovery: ${error.message}`;
    let published = null;
    try { published = await git(root, ["rev-parse", "--verify", "refs/remotes/origin/main"]); await git(root, ["merge-base", "--is-ancestor", published, head]); }
    catch { published = null; }
    if (published) baseline = published;
    else unavailable ??= "Configured published origin/main is unavailable or diverged; fetch and integrate canonical main, preserve all source, then assess the complete published-base-to-candidate range before deployment.";
  }
  const commits = baseline ? (await git(root, ["rev-list", "--reverse", "--topo-order", `${baseline}..${head}`])).split("\n").filter(Boolean) : [];
  const history = [], unknown = [], seen = new Set();
  for (const commit of commits) {
    try {
      const entry = await cachedCommittedReceipt(root, commit, traversal);
      if (entry.receipt.deployment_baseline_commit !== baseline) throw new Error("Original receipt uses another adoption baseline");
      const prior = await historyBetween(root, baseline, (entry.receipt.deployment_history_base_commit ?? entry.receipt.base_commit), traversal.histories, entry.receipt, traversal);
      if (entry.receipt.deployment_history_sha256 !== historyDigest(prior)) throw new Error("Original receipt history binding is incomplete");
      validateDeploymentDispositions(entry.receipt, prior);
      if (!seen.has(entry.receipt.receipt_sha256)) { history.push(entry); seen.add(entry.receipt.receipt_sha256); }
    } catch (error) {
      const recoverable = error.code === "MYCRM_MISSING_HISTORICAL_RECEIPT";
      if (!recoverable) unavailable ??= `Established historical custody requires verified recovery for ${commit}: ${error.message}`;
      unknown.push({commit, tree: await git(root, ["rev-parse", `${commit}^{tree}`]), reason: error.message, recoverable});
    }
  }
  const attested = new Map(history.flatMap(({receipt}) => (receipt.recovered_deployment_commits ?? []).map((item) => [item.commit, item.tree])));
  const unverified = unknown.filter((item) => !item.recoverable || attested.get(item.commit) !== item.tree);
  const recovered = unknown.filter((item) => item.recoverable).map(({commit, tree}) => ({commit, tree}));
  history.recovered_commits = recovered;
  const integratedPaths = unverified.length || unavailable ? (baseline ? await git(root, ["diff", "--name-only", baseline, head]) : await git(root, ["ls-tree", "-r", "--name-only", head])).split("\n").filter(Boolean) : [];
  await traversal.verify();
  if (await git(root, ["rev-parse", requestedHead]) !== head) throw Object.assign(new Error("Deployment-history candidate moved during traversal"), {code: "ORACLE_CANDIDATE_MOVED"});
  return {baseline, history, sha256: historyDigest(history, recovered), recovered_commits: recovered, unverified_commits: unverified, integrated_paths: integratedPaths, status: unavailable ? "UNAVAILABLE" : "READY", limitation: unavailable};
}

export async function verifyEffectAuthority(effect, receipt, root = process.cwd()) {
  if (effect.authority === null) return false;
  const candidates = [receipt.input_binding?.owner, ...(receipt.input_binding?.validation ?? [])].filter(Boolean);
  const original = candidates.find((item) => item.kind === "file" && path.resolve(root, item.value.replace(/^@/, "")) === effect.authority.evidence);
  if (!original) throw new Error("Protected deployment authority is absent from original hash-bound human evidence");
  const current = await evidenceBinding(root, original.value);
  if (bindingHash(current) !== bindingHash(original) || !(await readFile(effect.authority.evidence, "utf8")).includes(effect.authority.quote)) throw new Error("Protected deployment authority evidence changed or its exact human quote is missing");
  return true;
}

export async function verifyNewEffectAuthorities(response, inputs, root = process.cwd()) {
  for (const effect of response.protected_deployment_effects ?? []) await verifyEffectAuthority(effect, {input_binding: inputs}, root);
}

export async function pendingDeploymentEffects(plan, root = process.cwd()) {
  const pending = [];
  for (const item of plan.effects) if (!await verifyEffectAuthority(item.effect, item.receipt, root)) pending.push(item);
  return pending;
}

export async function deploymentPlan({root = process.cwd(), reference = "HEAD", requireClean = true} = {}) {
  const traversal = await historyTraversal(root), current = await cachedCommittedReceipt(root, reference, traversal);
  const {owner, value} = traversal.layout;
  await assertPublishedInvocation(current.receipt.invocation, value, owner);
  if (current.receipt.candidate_commit) {
    const {checkpointApplicable} = await import("./shipment-state.mjs");
    await checkpointApplicable(root, {receipt: current.receipt});
  }
  if ((await readBaseline(value, owner, traversal.read)).commit !== current.receipt.deployment_baseline_commit) throw new Error("Deployment candidate differs from the immutable adoption baseline");
  if (requireClean && (await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]) || await git(root, ["rev-parse", "HEAD^{tree}"]) !== current.tree)) throw new Error("Deployment requires the complete clean canonical source matching the reviewed target tree");
  const history = await historyBetween(root, current.receipt.deployment_baseline_commit, current.commit, traversal.histories, current.receipt, traversal);
  const inherited = history.filter((entry) => entry.receipt.receipt_sha256 !== current.receipt.receipt_sha256);
  validateDeploymentDispositions(current.receipt, inherited);
  const disposition = new Map(current.receipt.deployment_effect_dispositions.map((item) => [effectKey(item.receipt_sha256, item.effect_id), item]));
  const effects = [];
  for (const entry of history) for (const effect of entry.receipt.protected_deployment_effects) {
    const key = effectKey(entry.receipt.receipt_sha256, effect.id);
    if (entry.receipt.receipt_sha256 === current.receipt.receipt_sha256 || disposition.get(key)?.disposition === "EFFECTIVE") effects.push({key, effect, receipt: entry.receipt});
  }
  const binding = {target_tree: current.tree, technical_receipt_sha256: current.receipt.receipt_sha256, baseline_commit: current.receipt.deployment_baseline_commit, effects: effects.map(({key, effect}) => ({key, effect}))};
  await traversal.verify();
  return {...current, effects, binding, plan_sha256: bindingHash(binding)};
}

export function authorizationDigest(record) {
  const {authorization_sha256: _ignored, ...body} = record;
  return bindingHash(body);
}

export async function verifyDeploymentAuthorization(record, plan, root = process.cwd()) {
  const pending = await pendingDeploymentEffects(plan, root);
  if (record.schema !== "my-crm.deployment-authorization/v1" || record.authorization_sha256 !== authorizationDigest(record) || record.plan_sha256 !== plan.plan_sha256 || record.target_tree !== plan.tree || record.technical_receipt_sha256 !== plan.receipt.receipt_sha256 || record.decision !== "AUTHORIZED" || record.reviewer?.role !== "independent-project-oracle" || !hashPattern.test(record.reviewer?.role_instruction_sha256 ?? "") || !Array.isArray(record.approved_effect_keys) || bindingHash([...record.approved_effect_keys].sort()) !== bindingHash(pending.map(({key}) => key).sort())) throw new Error("Deployment authorization is missing, stale, incomplete or altered");
  if (record.reviewer_metadata_sha256 !== (await import("./oracle-review.mjs")).sha256(`${JSON.stringify(record.reviewer, null, 2)}\n`)) throw new Error("Deployment authorization reviewer custody changed");
  if (!text(record.authority?.quote) || !path.isAbsolute(record.authority?.evidence ?? "") || record.owner_evidence?.kind !== "file") throw new Error("Deployment authorization requires exact hash-bound human evidence");
  const binding = await evidenceBinding(root, record.owner_evidence.value);
  if (bindingHash(binding) !== bindingHash(record.owner_evidence) || path.resolve(root, record.owner_evidence.value.replace(/^@/, "")) !== record.authority.evidence || !(await readFile(record.authority.evidence, "utf8")).includes(record.authority.quote)) throw new Error("Deployment authorization human evidence changed or lacks the exact verified quote");
  return record;
}

export async function admitDeployment({root = process.cwd(), reference = "HEAD"} = {}) {
  const plan = await deploymentPlan({root, reference});
  const pending = await pendingDeploymentEffects(plan, root);
  if (pending.length) {
    const {owner, value} = await directory(root);
    const location = path.join(value, "deployment-authorizations", `${plan.tree}-${plan.receipt.receipt_sha256}`);
    let names = [];
    try { await metadataDirectory(owner, location, {create: false}); names = await readdir(location); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    let accepted = false; const failures = [];
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
      try {
        const record = JSON.parse(await readMetadataFile(path.join(location, name), "utf8", {root: owner}));
        if (name !== `${record.authorization_sha256}.json`) throw new Error("Authorization archive name differs from its immutable record digest");
        await verifyDeploymentAuthorization(record, plan, root); accepted = true; break;
      } catch (error) { failures.push(error.message); }
    }
    if (!accepted) throw new Error(`Protected deployment requires exact human authority for: ${pending.map(({key, effect}) => `${key} (${effect.description})`).join("; ")}. ${failures.join("; ")} Technical review and source-review publication remain complete and available.`);
  }
  return {status: "ADMITTED", technical_mode: plan.receipt.candidate_commit ? "COMMITTED_CHECKPOINT" : "HISTORICAL_STAMPED", source_commit: plan.commit, reviewed_source_commit: plan.reviewedCommit, target_tree: plan.tree, technical_receipt_sha256: plan.receipt.receipt_sha256, plan_sha256: plan.plan_sha256, protected_effects: plan.effects.map(({key}) => key)};
}

export function isProductPublicationRef(reference) {
  return reference === "refs/heads/main" || /^refs\/tags\/v\d+\.\d+\.\d+$/.test(reference);
}

export async function admitPush(input, {admit = admitDeployment} = {}) {
  for (const line of input.trim().split("\n").filter(Boolean)) {
    const [localRef, localSha, remoteRef] = line.trim().split(/\s+/);
    if (!localRef || !commitPattern.test(localSha ?? "") || !remoteRef) throw new Error("Invalid Git pre-push reference record");
    if (!isProductPublicationRef(remoteRef)) continue;
    if (/^0+$/.test(localSha)) throw new Error("Product publication reference deletion requires a separately reviewed deployment operation");
    await admit({reference: localSha});
  }
}

async function main() {
  if (process.argv[2] === "pre-push") {
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    await admitPush(input);
  } else if (process.argv[2] === "check") console.log(JSON.stringify(await admitDeployment({reference: process.argv[3] ?? "HEAD"})));
  else throw new Error("Usage: oracle-deployment.mjs check [ref]|pre-push");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(`MYCRM_DEPLOYMENT=BLOCKED ${error.message}`); process.exitCode = 1; });
