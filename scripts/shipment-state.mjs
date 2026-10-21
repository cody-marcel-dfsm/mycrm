import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {atomicJson, bindingHash, metadataDirectory, readMetadataFile, assertPublishedInvocation, captureInputs, assertInputsMatch} from "./oracle-inputs.mjs";

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
  if (await git(root, ["branch", "--show-current"]) !== "main" || await git(root, ["rev-parse", "HEAD"]) !== commit || await git(root, ["rev-parse", "HEAD^{tree}"]) !== tree || await git(root, ["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("Shipment requires the complete clean canonical main at its exact validated commit");
}
export async function publicationSourceMatches(root, source, publication) {
  if (source === publication) return true;
  const parents = (await git(root, ["show", "-s", "--format=%P", publication])).split(" ");
  if (parents.length !== 2 || parents[1] !== source || await git(root, ["rev-parse", `${source}^{tree}`]) !== await git(root, ["rev-parse", `${publication}^{tree}`])) return false;
  try { await git(root, ["merge-base", "--is-ancestor", parents[0], source]); return true; }
  catch { return false; }
}
export async function checkpointApplicable(root, checkpoint) {
  const {owner, directory} = await store(root), {receipt} = checkpoint;
  await assertPublishedInvocation(receipt.invocation, directory, owner);
  const proposal = JSON.parse(await readMetadataFile(path.join(directory, "proposal.json"), "utf8", {root: owner}));
  if (proposal.record_sha256 !== receipt.proposal_record_sha256) throw new Error("Checkpoint proposal criteria changed");
  const {deploymentHistoryForReview} = await import("./oracle-deployment.mjs");
  const deployment = await deploymentHistoryForReview(root, {head: receipt.deployment_history_base_commit ?? receipt.base_commit});
  const current = await captureInputs({root, base: receipt.base_commit, tree: receipt.reviewed_tree,
    validationEvidence: receipt.validation_evidence, ownerApprovalEvidence: receipt.owner_approval_evidence, proposal, complete: true,
    observedPaths: receipt.input_binding.observed_sources?.map((item) => item.path) ?? [],
    establishedObservedPaths: receipt.input_binding.observed_sources?.filter((item) => item.availability !== "UNAVAILABLE").map((item) => item.path) ?? [],
    reviewerSettings: receipt.input_binding.reviewer_settings});
  assertInputsMatch(receipt.input_binding, {...current, candidate_commit: receipt.candidate_commit,
    deployment_history_sha256: deployment.sha256, deployment_baseline_commit: deployment.baseline,
    deployment_history_state_sha256: bindingHash({status: deployment.status, unverified: deployment.unverified_commits, limitation: deployment.limitation})});
  const {readValidationProofs} = await import("./oracle-validation.mjs");
  await readValidationProofs({root, directory, validation: receipt.input_binding.validation, checkCurrentExecutable: false});
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
export async function recordValidatedCommit({root = process.cwd(), receipt}) {
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
  await atomicJson(path.join(directory, "committed-receipts", `${receipt.candidate_commit}.json`), record, {root: owner});
  await exactSource(root, receipt.candidate_commit, receipt.reviewed_tree);
  await assertPublishedInvocation(receipt.invocation, directory, owner);
  await atomicJson(path.join(directory, "shipment-validated.json"), record, {root: owner});
  return record;
}
export async function shipmentPlan({root = process.cwd(), publishedRef = "refs/remotes/origin/main"} = {}) {
  const head = await git(root, ["rev-parse", "HEAD"]);
  if (await git(root, ["branch", "--show-current"]) !== "main") throw new Error("Shipment operates in canonical main");
  const dirty = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (dirty) return {action: "PREPARE", candidate_commit: head, reason: "Commit every authored file before validation"};
  const checkpoint = await readValidatedCheckpoint(root), {owner, directory} = await store(root);
  let applicabilityError = null;
  const sourceMatches = checkpoint && await publicationSourceMatches(root, checkpoint.record.last_validated_commit, head);
  if (sourceMatches) {
    try { await checkpointApplicable(root, checkpoint); }
    catch (error) { applicabilityError = error; }
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
  if (selection.action === "NO_CHANGES") return selection;
  if (selection.action === "PREPARE") { await prepare(selection); selection = await plan({root}); }
  if (selection.action === "VALIDATE") { await validate(selection); selection = await plan({root}); }
  if (selection.action === "NO_CHANGES") return selection;
  if (selection.action !== "DELIVER") throw new Error("Shipment has no complete current validation checkpoint");
  return deliver(selection);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) shipmentPlan().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(`MYCRM_SHIPMENT=BLOCKED ${error.message}`); process.exitCode = 1; });
