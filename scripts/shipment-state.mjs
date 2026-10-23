import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {readFile, readdir} from "node:fs/promises";
import {atomicJson, bindingHash, contentHash, pathCustody, metadataDirectory, readMetadataFile, assertPublishedInvocation, captureInputs, assertInputsMatch} from "./oracle-inputs.mjs";
import {activeReviewController, observeReviewController} from "./oracle-lifecycle.mjs";
import {verifyParallelArtifacts} from "./oracle-parallel.mjs";

const execute = promisify(execFile);
const commitHash = /^[a-f0-9]{40}$/;
const digestHash = /^[a-f0-9]{64}$/;
const git = async (root, args) => (await execute("git", args, {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024})).stdout.trim();
export const checkpointDigest = ({checkpoint_sha256: _ignored, ...record}) => bindingHash(record);
async function store(root) {
  const owner = await git(root, ["rev-parse", "--absolute-git-dir"]), directory = path.join(owner, "oracle");
  await metadataDirectory(owner, directory);
  return {owner, directory};
}
async function optionalJson(filename, owner) {
  try { return JSON.parse(await readMetadataFile(filename, "utf8", {root: owner})); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function exactSource(root, commit, tree) {
  if (await git(root, ["branch", "--show-current"]) !== "main" || await git(root, ["rev-parse", "HEAD"]) !== commit || await git(root, ["rev-parse", "HEAD^{tree}"]) !== tree || await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) {
    const error = new Error("Shipment requires the complete clean canonical main at its exact validated commit");
    error.code = "ORACLE_CANDIDATE_MOVED"; throw error;
  }
}
export async function publicationSourceMatches(root, source, publication) {
  if (source === publication) return true;
  const parents = (await git(root, ["show", "-s", "--format=%P", publication])).split(" ");
  if (parents.length !== 2 || parents[1] !== source || await git(root, ["rev-parse", `${source}^{tree}`]) !== await git(root, ["rev-parse", `${publication}^{tree}`])) return false;
  try { await git(root, ["merge-base", "--is-ancestor", parents[0], source]); return true; }
  catch { return false; }
}
export async function checkpointApplicable(root, checkpoint, {allowActiveController = false} = {}) {
  if (!allowActiveController && await activeReviewController(root)) throw new Error("Current candidate review is still in progress; await its exact-current decision");
  const {owner, directory} = await store(root), {receipt} = checkpoint;
  if (receipt.parallel_review_evidence) await verifyParallelArtifacts(receipt.parallel_review_evidence, {root: owner});
  await assertPublishedInvocation(receipt.invocation, directory, owner);
  const proposal = JSON.parse(await readMetadataFile(path.join(directory, "proposal.json"), "utf8", {root: owner}));
  if (proposal.record_sha256 !== receipt.proposal_record_sha256) throw new Error("Checkpoint proposal criteria changed");
  const {verifySeries} = await import("./oracle-series.mjs");
  const series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${receipt.base_commit}.json`), "utf8", {root: owner})), receipt.base_commit);
  if (series.sha256 !== receipt.review_series_sha256 || series.series_id !== receipt.review_series_id || series.rounds.at(-1)?.round !== receipt.review_round || series.rounds.at(-1)?.snapshot.tree !== receipt.reviewed_tree || series.rounds.at(-1)?.review_status !== "COMPLETE" || series.rounds.at(-1)?.verdict !== "APPROVED") throw new Error("Checkpoint independent review-series custody changed");
  const captureCurrent = () => captureInputs({root, base: receipt.base_commit, tree: receipt.reviewed_tree,
    validationEvidence: receipt.validation_evidence, ownerApprovalEvidence: receipt.owner_approval_evidence, proposal, complete: true,
    observedPaths: receipt.input_binding.observed_sources?.map((item) => item.path) ?? [],
    establishedObservedPaths: receipt.input_binding.observed_sources?.filter((item) => item.availability !== "UNAVAILABLE").map((item) => item.path) ?? [],
    reviewerSettings: receipt.input_binding.reviewer_settings});
  // Reject changed current criteria before reconstructing historical receipts.
  // These copied history values defer their check only to the existing full
  // history comparison below; this early comparison grants no acceptance.
  assertInputsMatch(receipt.input_binding, {...await captureCurrent(), candidate_commit: receipt.candidate_commit,
    deployment_history_sha256: receipt.input_binding.deployment_history_sha256,
    deployment_baseline_commit: receipt.input_binding.deployment_baseline_commit,
    deployment_history_state_sha256: receipt.input_binding.deployment_history_state_sha256});
  const {deploymentHistoryForReview} = await import("./oracle-deployment.mjs");
  const deployment = await deploymentHistoryForReview(root, {head: receipt.deployment_history_base_commit ?? receipt.base_commit});
  // Recapture after history work so intervening source/authority/evidence
  // changes retain the original fail-closed acceptance boundary.
  assertInputsMatch(receipt.input_binding, {...await captureCurrent(), candidate_commit: receipt.candidate_commit,
    deployment_history_sha256: deployment.sha256, deployment_baseline_commit: deployment.baseline,
    deployment_history_state_sha256: bindingHash({status: deployment.status, unverified: deployment.unverified_commits, limitation: deployment.limitation})});
  const {readValidationProofs} = await import("./oracle-validation.mjs");
  await readValidationProofs({root, directory, validation: receipt.input_binding.validation, checkCurrentExecutable: false});
  return true;
}
// Status selects recorded command coverage; it performs no original-output,
// review-series or history audit. Changed governing inputs reopen validation.
// Full native custody/effect admission is the separate validation-time preflight.
export async function checkpointSelectionApplicable(root, checkpoint) {
  const authorities = checkpoint.receipt.input_binding.authorities ?? [];
  const canonical = [];
  const walk = async (relative) => {
    let entries;
    try {entries = await readdir(path.join(root, relative), {withFileTypes: true});}
    catch (error) {if (error.code === "ENOENT") throw new Error(`Governing authority membership changed; missing ${relative}`); throw error;}
    for (const entry of entries) {
      if (["tmp", "index"].includes(entry.name)) continue;
      const name = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Governing authority custody changed: ${name}`);
      if (entry.isDirectory()) await walk(name); else if (entry.isFile()) canonical.push(name);
    }
  };
  await walk("Vault");
  const recordedCanonical = authorities.filter(item => !path.isAbsolute(item.path) && item.path.startsWith("Vault/")).map(item => item.path).sort();
  if (bindingHash(canonical.sort()) !== bindingHash(recordedCanonical)) throw new Error("Governing authority membership changed; validate the affected criteria");
  for (const authority of authorities) {
    const custody = await pathCustody(root, authority.path, {scopeRoot: path.isAbsolute(authority.path) ? path.dirname(path.resolve(root)) : root, allowMissing: true, allowFinalLink: false});
    const current = custody.metadata === null ? null : contentHash(await readFile(custody.resolved_path));
    if (current !== authority.sha256 || authority.custody && bindingHash(custody) !== bindingHash(authority.custody)) throw new Error(`Governing authority changed; validate affected criteria: ${authority.path}`);
  }
  return true;
}
export async function readValidatedCheckpoint(root = process.cwd()) {
  const {owner, directory} = await store(root), record = await optionalJson(path.join(directory, "shipment-validated.json"), owner);
  if (!record) return null;
  if (record.schema !== "my-crm.shipment-validated/v1" || record.checkpoint_sha256 !== checkpointDigest(record) || !commitHash.test(record.last_validated_commit ?? "") || !commitHash.test(record.tree ?? "") || !digestHash.test(record.receipt_sha256 ?? "")) throw new Error("Shipment validation checkpoint is malformed or changed");
  const {verifyReceipt} = await import("./oracle-review.mjs");
  const receipt = verifyReceipt(JSON.parse(await readMetadataFile(path.join(directory, "technical-receipts", `${record.receipt_sha256}.json`), "utf8", {root: owner})), record.tree);
  if (receipt.review_status !== "COMPLETE" || receipt.candidate_commit !== record.last_validated_commit || receipt.receipt_sha256 !== record.receipt_sha256 || await git(root, ["rev-parse", `${record.last_validated_commit}^{tree}`]) !== record.tree) throw new Error("Shipment checkpoint lacks its exact complete committed-source receipt");
  return {record, receipt};
}
export async function recordValidatedCommit({root = process.cwd(), receipt, beforePublish = async () => {}}) {
  if (!receipt.candidate_commit) return null; // Historical staged-tree receipts retain their own custody.
  const {verifyReceipt} = await import("./oracle-review.mjs");
  verifyReceipt(receipt, receipt.reviewed_tree);
  if (receipt.review_status !== "COMPLETE" || !commitHash.test(receipt.candidate_commit)) throw new Error("Shipment validation requires complete independent committed-source approval");
  await exactSource(root, receipt.candidate_commit, receipt.reviewed_tree);
  const {owner, directory} = await store(root);
  const archived = JSON.parse(await readMetadataFile(path.join(directory, "technical-receipts", `${receipt.receipt_sha256}.json`), "utf8", {root: owner}));
  if (bindingHash(archived) !== bindingHash(receipt)) throw new Error("Shipment validation requires its original archived technical receipt");
  const record = {schema: "my-crm.shipment-validated/v1", last_validated_commit: receipt.candidate_commit, tree: receipt.reviewed_tree, receipt_sha256: receipt.receipt_sha256, reviewed_base: receipt.base_commit};
  record.checkpoint_sha256 = checkpointDigest(record);
  await exactSource(root, receipt.candidate_commit, receipt.reviewed_tree);
  await beforePublish();
  await atomicJson(path.join(directory, "committed-receipts", `${receipt.candidate_commit}.json`), record, {root: owner});
  await exactSource(root, receipt.candidate_commit, receipt.reviewed_tree);
  await assertPublishedInvocation(receipt.invocation, directory, owner);
  await beforePublish();
  await atomicJson(path.join(directory, "shipment-validated.json"), record, {root: owner});
  return record;
}
export async function shipmentPlan({root = process.cwd(), publishedRef = "refs/remotes/origin/main", observeReview = true} = {}) {
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (await git(root, ["branch", "--show-current"]) !== "main") throw new Error("Shipment operates in canonical main");
  const active = observeReview ? await activeReviewController(root) : null;
  if (active) return {action: "REVIEW_IN_PROGRESS", candidate_commit: head, approval_state: "PENDING", controller: active,
    reason: "Observe the verified live native completed-review parent; normal source commits remain available"};
  const dirty = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) return {action: "PREPARE", candidate_commit: head, reason: "Commit every authored file before validation"};
  const checkpoint = await readValidatedCheckpoint(root), {owner, directory} = await store(root);
  let applicabilityError = null;
  const sourceMatches = checkpoint && await publicationSourceMatches(root, checkpoint.record.last_validated_commit, head);
  if (sourceMatches) {
    try {
      await checkpointSelectionApplicable(root, checkpoint);
      const {publicationDecisionStatus} = await import("./publication-checkpoint.mjs");
      const decision = await publicationDecisionStatus({root, sourceCommit: checkpoint.record.last_validated_commit, sourceTree: checkpoint.record.tree});
      if (decision && decision.status !== "APPROVED") throw new Error("Recorded candidate readiness awaits complete current assessment after its latest native decision");
    }
    catch (error) {
      applicabilityError = error;
      if (/Governing authority/.test(error.message)) {
        const {recordPublicationDecision} = await import("./publication-checkpoint.mjs");
        await recordPublicationDecision({root, sourceCommit: checkpoint.record.last_validated_commit, sourceTree: checkpoint.record.tree, status: "INVALIDATED_CRITERIA", decisionId: `criteria:${bindingHash(error.message)}`, invalidationReason: error.message});
      }
    }
  }
  if (sourceMatches && !applicabilityError) {
    const delivered = await optionalJson(path.join(directory, "shipment-delivered.json"), owner);
    if (delivered && (delivered.schema !== "my-crm.shipment-delivered/v1" || delivered.checkpoint_sha256 !== checkpointDigest(delivered))) throw new Error("Shipment delivery checkpoint is malformed or changed");
    const complete = delivered?.delivered_commit === head && delivered.validated_checkpoint_sha256 === checkpoint.record.checkpoint_sha256;
    return {action: complete ? "NO_CHANGES" : "DELIVER", candidate_commit: head, last_validated_commit: checkpoint.record.last_validated_commit, receipt_sha256: checkpoint.record.receipt_sha256, approval_state: "APPROVED", reason: complete ? "Exact validated candidate was already delivered" : "Resume authorized delivery of the exact validated candidate"};
  }
  let baseline = checkpoint?.record.last_validated_commit ?? null;
  if (!baseline) { try { baseline = await git(root, ["rev-parse", "--verify", publishedRef]); } catch { /* No baseline supplies no approval. */ } }
  if (!checkpoint && baseline === head) return {action: "NO_CHANGES", candidate_commit: head, last_validated_commit: null, approval_state: "UNKNOWN", reason: "No new commits beyond the configured published ref; no approval or delivery is inferred"};
  if (!baseline) throw new Error("Shipment needs a fetched published baseline or a verified validation checkpoint");
  await git(root, ["merge-base", "--is-ancestor", baseline, head]);
  return {action: "VALIDATE", candidate_commit: head, validation_base: baseline, last_validated_commit: checkpoint?.record.last_validated_commit ?? null, approval_state: "PENDING", ...(applicabilityError ? {reason: applicabilityError.message} : {}), commits: (await git(root, ["rev-list", "--reverse", `${baseline}..${head}`])).split("\n").filter(Boolean)};
}
export async function recordDeliveredCommit({root = process.cwd(), admission, installation}) {
  const checkpoint = await readValidatedCheckpoint(root);
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (!checkpoint || admission?.status !== "ADMITTED" || (admission.reviewed_source_commit ?? admission.source_commit) !== checkpoint.record.last_validated_commit || admission.source_commit !== head || admission.target_tree !== checkpoint.record.tree || admission.technical_receipt_sha256 !== checkpoint.record.receipt_sha256 || !digestHash.test(installation?.release?.content_sha256 ?? "") || !installation?.pluginId) throw new Error("Delivery requires exact validated admission and successful supported installation evidence");
  if (!await publicationSourceMatches(root, checkpoint.record.last_validated_commit, head)) throw new Error("Published source differs from its exact validated candidate");
  await exactSource(root, head, checkpoint.record.tree);
  await checkpointApplicable(root, checkpoint);
  if (await git(root, ["rev-parse", "refs/remotes/origin/main"]) !== head) throw new Error("Delivery checkpoint requires the exact validated publication on published main");
  const {owner, directory} = await store(root);
  const record = {schema: "my-crm.shipment-delivered/v1", delivered_commit: head, reviewed_source_commit: checkpoint.record.last_validated_commit, validated_checkpoint_sha256: checkpoint.record.checkpoint_sha256, artifact_sha256: installation.release.content_sha256, plugin_id: installation.pluginId};
  record.checkpoint_sha256 = checkpointDigest(record);
  await atomicJson(path.join(directory, "shipment-delivered.json"), record, {root: owner});
  return record;
}
// The native dispatch guard executes no callback for an unchanged shipment.
export async function runShipment({root = process.cwd(), prepare, validate, deliver, plan = shipmentPlan} = {}) {
  let selection = await plan({root});
  if (selection.action === "REVIEW_IN_PROGRESS") { await observeReviewController(selection.controller, {root}); selection = await plan({root}); }
  if (selection.action === "NO_CHANGES") return selection;
  if (selection.action === "PREPARE") { await prepare(selection); selection = await plan({root}); }
  if (selection.action === "VALIDATE") { await validate(selection); selection = await plan({root}); }
  if (selection.action === "NO_CHANGES") return selection;
  if (selection.action !== "DELIVER") throw new Error("Shipment has no complete current validation checkpoint");
  return deliver(selection);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) shipmentPlan().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`MYCRM_SHIPMENT=BLOCKED ${error.message}`); process.exitCode = 1; });
