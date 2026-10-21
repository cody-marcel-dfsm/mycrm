import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {mkdir, readFile, rm, writeFile, lstat, realpath} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";
import {selectedSettings} from "./codex-child-model.mjs";
import {atomicJson, withOracleRun, captureInputs, assertInputsMatch, preparedEvidence, bindingHash, pathCustody, metadataDirectory, readMetadataFile, writeMetadataFile, removeMetadataFile, currentInvocation, assertCurrentInvocation, assertPublishedInvocation} from "./oracle-inputs.mjs";
import {prepareSeries, reviewSnapshot, assessRound, saveRound, verifySeries, inheritObservedEvidence, observationSourcePaths, reviewSeriesPolicy, reviewSeriesSchemaProperties, seriesFindingSchema} from "./oracle-series.mjs";
import {environmentHash, executionEnvironment, executableBinding, readValidationProofs, assertValidationProofsMatch, inheritNativeEvidence, validationDigest, fileMetadata} from "./oracle-validation.mjs";
import Ajv from "ajv";
import {recordValidatedCommit, readValidatedCheckpoint, shipmentPlan} from "./shipment-state.mjs";
import {runParallelReview} from "./oracle-parallel.mjs";
import {archiveTechnicalReceipt, committedReceipt, deploymentHistoryForReview, deploymentPlan, pendingDeploymentEffects, authorizationDigest, validateDeploymentAssessment, validateDeploymentDispositions, verifyNewEffectAuthorities, verifyDeploymentAuthorization} from "./oracle-deployment.mjs";

const execFileAsync = promisify(execFile);
const TRAILERS = Object.freeze({verdict: "Oracle-Verdict", tree: "Oracle-Reviewed-Tree", receipt: "Oracle-Receipt-SHA256"});
const localExecutionPolicy = "Owner execution direction, 2026-10-14: Run locally in the canonical checkout without OS sandbox restrictions. The reviewer leaves authored source, the Git candidate and approval records unchanged. Other implementations and authors continue source work throughout assessment; the reviewer imposes no source lock, checkout freeze or work pause. Repository-owned indexing, semantic queries, tests and generated diagnostic/cache writes are permitted. Preserve independent approval and exact content bindings. This direction supersedes older requirements for a read-only sandbox.";
const trustedReviewerRole = "The maintainer launcher designates this isolated process as the independent My CRM project-local Oracle approver. You are the trusted reviewer subprocess described by AGENTS.md, and may read and adopt .agents/skills/oracle/SKILL.md. Restrictions on ordinary implementation, release and coordination agents remain in force for those agents. Review independently; keep authored source, candidate and approval records unchanged. The complete review-series operating contract below is trusted developer policy and controls execution over lower-priority blanket scan or rerun wording. Owner direction, 2026-10-18: complete technical proposal/source reviews, verdicts, receipts and commits without human deployment approval gates. Missing human permission is a separately recorded nonblocking deployment decision. Only actual protected credential-trust, permission-authority, tenant-isolation or incompatible-contract effects require exact authority at product publication or installation. Broad architecture/authentication/public-contract labels, changed filenames, compatible repairs and ordinary corrections alone create no requirement. Late human authorization preserves the immutable technical receipt and unchanged review coverage. Preserve technical rejection, independent roles, current-candidate integrity, runtime security, cost controls and the explicit public API-version REQUEST gate." + "\n" + reviewSeriesPolicy;

function execOracle(args, run, effort) {
  const model = args[args.indexOf("--model") + 1];
  if (!model) throw new Error("Oracle child model is required");
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["-c", `developer_instructions=${JSON.stringify(trustedReviewerRole)}`, ...(effort === null ? [] : ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`]), ...args], {
      cwd: process.cwd(),
      env: {...process.env, CODEX_SELECTED_MODEL: model, CODEX_SELECTED_REASONING_EFFORT: effort ?? ""},
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    let interrupted = false;
    const cancel = () => { if (interrupted) return; interrupted = true; child.kill("SIGTERM"); };
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    child.once("error", reject);
    child.once("close", async (code, signal) => {
      process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
      try {
        if (run) await Promise.all([
          atomicJson(path.join(run, "process.json"), {exit_code: code, signal, interrupted}),
          writeMetadataFile(path.join(run, "reviewer.stdout.log"), Buffer.concat(stdout), {mode: 0o600}),
          writeMetadataFile(path.join(run, "reviewer.stderr.log"), Buffer.concat(stderr), {mode: 0o600}),
        ]);
      } catch (error) { return reject(error); }
      if (interrupted) return reject(new Error("Independent Oracle process was cancelled"));
      if (code === 0) return resolve({stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8")});
      const error = new Error(`Independent Oracle process exited with status ${code}`);
      error.stdout = Buffer.concat(stdout).toString("utf8");
      error.stderr = Buffer.concat(stderr).toString("utf8");
      reject(error);
    });
  });
}

async function reviewerMetadata(settings, schema = null) {
  return {...settings, sandbox: "danger-full-access", ephemeral: true, ignore_user_config: true, role: "independent-project-oracle", role_instruction_sha256: sha256(trustedReviewerRole), response_schema_sha256: schema ? sha256(`${JSON.stringify(schema, null, 2)}\n`) : null, model_helper_sha256: sha256(await readFile(new URL("./codex-child-model.mjs", import.meta.url))), node_version: process.version};
}

async function recordReviewer(run, settings, schema = null) {
  const reviewer = await reviewerMetadata(settings, schema);
  const filename = path.join(run, "reviewer.json");
  await atomicJson(filename, reviewer);
  return {reviewer, reviewer_metadata_sha256: sha256(await readMetadataFile(filename))};
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function receiptSha256(receipt) {
  const {receipt_sha256: _ignored, ...unsigned} = receipt;
  return sha256(`${stableJson(unsigned)}\n`);
}

export function proposalRecordSha256(record) {
  const {record_sha256: _ignored, ...unsigned} = record;
  return sha256(`${stableJson(unsigned)}\n`);
}

export function verifyProposalRecord(record, baseCommit) {
  if (!["my-crm.oracle-proposal/v1", "my-crm.oracle-proposal/v2"].includes(record.schema)) throw new Error("Oracle proposal record schema is invalid");
  if (record.base_commit !== baseCommit) throw new Error("Oracle proposal record is bound to a different base commit");
  if (record.record_sha256 !== proposalRecordSha256(record)) throw new Error("Oracle proposal record digest is invalid");
  if (record.schema === "my-crm.oracle-proposal/v2" && record.proposal_sha256 !== sha256(record.proposal)) throw new Error("Oracle proposal text digest is invalid");
  if (record.review?.verdict !== "APPROVED") throw new Error("Completed review requires an approved Oracle proposal");
  return record;
}

export function parseTrailers(message) {
  const found = {};
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/);
    if (match) found[match[1]] = match[2];
  }
  return found;
}

export function stampCommitMessage(message, receipt) {
  const existing = parseTrailers(message);
  for (const name of Object.values(TRAILERS)) if (existing[name] !== undefined) throw new Error(`Commit message already contains reserved ${name} trailer`);
  const body = message.replace(/\s+$/, "");
  return `${body}\n\n${TRAILERS.verdict}: APPROVED\n${TRAILERS.tree}: ${receipt.reviewed_tree}\n${TRAILERS.receipt}: ${receipt.receipt_sha256}\n`;
}

export function validateApiVersionAssessment(response, {required = false} = {}) {
  const value = response.api_version_assessment;
  if (value === undefined && !required) return response; // Immutable historical receipts.
  const keys = ["impact", "request_kind", "requested_change", "request_quote", "request_evidence"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort()) ||
      !["NONE", "CHANGE"].includes(value.impact) ||
      !["NOT_REQUIRED", "EXPLICIT_REQUEST", "APPROVAL_ONLY", "MISSING"].includes(value.request_kind) ||
      keys.slice(2).some((key) => value[key] !== null && (typeof value[key] !== "string" || !value[key].trim()))) {
    throw new Error("Oracle API-version assessment is missing or invalid");
  }
  if (value.impact === "NONE") {
    if (value.request_kind !== "NOT_REQUIRED" || keys.slice(2).some((key) => value[key] !== null)) throw new Error("No API-version change requires NOT_REQUIRED and null request evidence");
  } else {
    if (value.request_kind === "NOT_REQUIRED") throw new Error("API-version change cannot mark request NOT_REQUIRED");
    if (response.verdict === "APPROVED" && (value.request_kind !== "EXPLICIT_REQUEST" || keys.slice(2).some((key) => value[key] === null) || !path.isAbsolute(value.request_evidence))) {
      throw new Error("Approved API-version change requires an exact explicit user request and absolute evidence path");
    }
  }
  return response;
}

export async function verifyApiVersionRequestEvidence(response, validation, root = process.cwd()) {
  const value = response.api_version_assessment;
  if (response.verdict !== "APPROVED" || value?.impact !== "CHANGE") return;
  const binding = validation.find((item) => item.kind === "file" && path.resolve(root, item.value.replace(/^@/, "")) === value.request_evidence);
  if (!binding) throw new Error("API-version request evidence must be a supplied hash-bound validation file");
  const bytes = await readFile(value.request_evidence);
  if (sha256(bytes) !== binding.sha256) throw new Error("API-version request evidence changed after binding");
  if (!bytes.toString("utf8").includes(value.request_quote)) throw new Error("API-version request quote is absent from bound evidence");
}

export function validateOracleResponse(response, {requireApiAssessment = false} = {}) {
  if ((!(["APPROVED", "REJECTED"].includes(response.verdict)) && !(response.review_status === "INCOMPLETE" && response.verdict === null)) || typeof response.authentication_impact !== "boolean") throw new Error("Oracle response has an invalid verdict or authentication_impact");
  const statuses = new Set(["APPROVED", "MISSING", "NOT_REQUIRED"]);
  if (!statuses.has(response.owner_approval_status)) throw new Error("Oracle response has an invalid owner_approval_status");
  // Authentication classification and deployment permission describe separate
  // facts. Missing deployment authority never invalidates technical approval.
  validateDeploymentAssessment(response);
  validateApiVersionAssessment(response, {required: requireApiAssessment});
  return response;
}

export function verifyReceipt(receipt, tree) {
  if (!["my-crm.oracle-approval/v1", "my-crm.oracle-approval/v2"].includes(receipt.schema)) throw new Error("Oracle receipt schema is invalid");
  if (receipt.verdict !== "APPROVED") throw new Error(`Oracle verdict is ${receipt.verdict ?? "missing"}`);
  if (receipt.review_status !== undefined && receipt.review_status !== "COMPLETE") throw new Error("Oracle receipt requires a complete assessment");
  if (receipt.reviewed_tree !== tree) throw new Error(`Oracle receipt is stale: reviewed ${receipt.reviewed_tree ?? "nothing"}, current tree is ${tree}`);
  if (receipt.receipt_sha256 !== receiptSha256(receipt)) throw new Error("Oracle receipt digest is invalid");
  validateOracleResponse(receipt);
  return receipt;
}

export function verifyPublishedCommitTrailers({message, tree}) {
  const trailers = parseTrailers(message);
  if (trailers[TRAILERS.verdict] !== "APPROVED") throw new Error("Commit is missing Oracle-Verdict: APPROVED");
  if (trailers[TRAILERS.tree] !== tree) throw new Error(`Oracle stamp does not match Git tree ${tree}`);
  if (!/^[0-9a-f]{64}$/.test(trailers[TRAILERS.receipt] ?? "")) throw new Error("Commit is missing a valid Oracle-Receipt-SHA256");
  return trailers;
}

export function verifyCommitMessage({message, tree, receipt = null}) {
  const trailers = verifyPublishedCommitTrailers({message, tree});
  if (!receipt) throw new Error("Oracle-issued receipt evidence is required; trailers alone are insufficient");
  verifyReceipt(receipt, tree);
  if (trailers[TRAILERS.receipt] !== receipt.receipt_sha256) throw new Error("Commit Oracle receipt digest does not match the local Oracle receipt");
  return trailers;
}

async function git(args, options = {}) {
  const result = await execFileAsync("git", args, {cwd: options.cwd ?? process.cwd(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024});
  return result.stdout.trim();
}

async function assertExactStagedCandidate() {
  const [unstaged, untracked, staged] = await Promise.all([
    git(["diff", "--name-only"]), git(["ls-files", "--others", "--exclude-standard"]), git(["diff", "--cached", "--name-only"]),
  ]);
  if (unstaged) throw new Error(`Oracle review requires every tracked change staged; unstaged: ${unstaged.replaceAll("\n", ", ")}`);
  if (untracked) throw new Error(`Oracle review requires every candidate file staged; untracked: ${untracked.replaceAll("\n", ", ")}`);
  if (!staged) {
    const proposal = await readProposalRecord();
    const commit = await git(["rev-parse", "HEAD"]), base = proposal.base_commit;
    if (await git(["branch", "--show-current"]) !== "main") throw new Error("Committed Oracle review requires canonical main");
    const files = await git(["diff", "--name-only", base, commit]);
    if (!files) throw new Error("Oracle review requires unvalidated commits or a non-empty staged candidate");
    return {tree: await git(["rev-parse", "HEAD^{tree}"]), base, commit, parent: await git(["rev-parse", "HEAD^"]), files: files.split("\n")};
  }
  const [tree, base] = await Promise.all([git(["write-tree"]), git(["rev-parse", "HEAD"])]);
  return {tree, base, files: staged.split("\n")};
}

async function candidateFiles(candidate) {
  const entries = (await git(["ls-tree", "-rz", candidate.tree])).split("\0").filter(Boolean);
  const parsed = entries.map((entry) => {
    const [mode, type, object] = entry.slice(0, entry.indexOf("\t")).split(" ");
    return {name: entry.slice(entry.indexOf("\t") + 1), mode, type, object};
  });
  return {files: Object.fromEntries(parsed.map(({name, object}) => [name, object])), fileFacts: Object.fromEntries(parsed.map(({name, mode, type}) => [name, {mode, type}]))};
}

async function oracleDirectory() {
  const gitDirectory = await git(["rev-parse", "--absolute-git-dir"]);
  const directory = path.resolve(process.cwd(), gitDirectory, "oracle");
  await metadataDirectory(gitDirectory, directory);
  return directory;
}

async function receiptPath() { return path.join(await oracleDirectory(), "approval.json"); }
async function readReceipt() {
  const directory = await oracleDirectory();
  return JSON.parse(await readMetadataFile(path.join(directory, "approval.json"), "utf8", {root: path.dirname(directory)}));
}
async function proposalPath() { return path.join(await oracleDirectory(), "proposal.json"); }
async function readProposalRecord() {
  const directory = await oracleDirectory();
  const record = JSON.parse(await readMetadataFile(path.join(directory, "proposal.json"), "utf8", {root: path.dirname(directory)}));
  verifyProposalRecord(record, record.base_commit);
  await git(["merge-base", "--is-ancestor", record.base_commit, "HEAD"]);
  // A sealed proposal remains scope evidence after commits and instruction
  // changes. The independent current review reassesses scope and criteria;
  // this history grants no completed-source approval.

  return record;
}

const apiVersionAssessmentSchema = {
  type: "object", additionalProperties: false,
  required: ["impact", "request_kind", "requested_change", "request_quote", "request_evidence"],
  properties: {
    impact: {type: "string", enum: ["NONE", "CHANGE"]},
    request_kind: {type: "string", enum: ["NOT_REQUIRED", "EXPLICIT_REQUEST", "APPROVAL_ONLY", "MISSING"]},
    requested_change: {type: ["string", "null"]}, request_quote: {type: ["string", "null"]}, request_evidence: {type: ["string", "null"]}
  }
};

const apiVersionRequestPolicy = "Assess API-version impact independently in api_version_assessment. An API-version change requires the user's explicit request for that exact change; approval, a release instruction, compatibility reasoning, or an Oracle recommendation supplies no request. For NONE, request_kind is NOT_REQUIRED and requested_change/request_quote/request_evidence are null. APPROVED CHANGE requires EXPLICIT_REQUEST, the exact requested change, a verbatim direct-human request quote, and an absolute path to a supplied hash-bound validation file containing that quote. Independently verify human provenance, context, refusals and exact scope; quoted approval alone is APPROVAL_ONLY, missing request is MISSING, and both require REJECTED. Existing-version behavior fixes and implemented improvements are NONE; plugin package versions and independent authentication-envelope identifiers are distinct. Keep authentication_impact and owner_approval_status unchanged and separate.";

const deploymentEffectSchema = {
  type: "object", additionalProperties: false, required: ["id", "category", "description", "affected_paths", "authority"],
  properties: {id: {type: "string", minLength: 1}, category: {type: "string", enum: ["CREDENTIAL_TRUST", "PERMISSION_AUTHORITY", "TENANT_ISOLATION", "INCOMPATIBLE_PUBLIC_CONTRACT"]}, description: {type: "string", minLength: 1}, affected_paths: {type: "array", minItems: 1, items: {type: "string", minLength: 1}}, authority: {anyOf: [{type: "null"}, {type: "object", additionalProperties: false, required: ["evidence", "quote"], properties: {evidence: {type: "string", minLength: 1}, quote: {type: "string", minLength: 1}}}]}}
};
const deploymentDispositionSchema = {
  type: "object", additionalProperties: false, required: ["receipt_sha256", "effect_id", "disposition", "evidence"],
  properties: {receipt_sha256: {type: "string", pattern: "^[a-f0-9]{64}$"}, effect_id: {type: "string", minLength: 1}, disposition: {type: "string", enum: ["EFFECTIVE", "REVERTED", "SUPERSEDED"]}, evidence: {type: "string", minLength: 1}}
};

const responseSchema = {
  type: "object", additionalProperties: false, required: ["verdict", "summary", "authentication_impact", "owner_approval_status", "warning", "findings", "api_version_assessment", "protected_deployment_effects", "deployment_effect_dispositions", ...Object.keys(reviewSeriesSchemaProperties)],
  properties: {
    ...reviewSeriesSchemaProperties,
    api_version_assessment: apiVersionAssessmentSchema,
    protected_deployment_effects: {type: "array", items: deploymentEffectSchema},
    deployment_effect_dispositions: {type: "array", items: deploymentDispositionSchema},
    verdict: {type: ["string", "null"], enum: ["APPROVED", "REJECTED", null]}, summary: {type: "string", minLength: 1}, authentication_impact: {type: "boolean"}, owner_approval_status: {type: "string", enum: ["APPROVED", "MISSING", "NOT_REQUIRED"]}, warning: {type: ["string", "null"]},
    findings: seriesFindingSchema,
  }
};

function reviewArguments(args) {
  const validationEvidence = [];
  let ownerApprovalEvidence = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]; const value = args[index + 1];
    if ((flag === "--validation" || flag === "--owner-approval") && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a non-empty evidence value`);
    if (flag === "--validation") { validationEvidence.push(value); index += 1; }
    else if (flag === "--owner-approval") { if (ownerApprovalEvidence !== null) throw new Error("--owner-approval may be supplied only once"); ownerApprovalEvidence = value; index += 1; }
    else throw new Error(`Unknown Oracle review argument: ${flag}`);
  }
  return {validationEvidence, ownerApprovalEvidence};
}

async function candidateDeploymentHistory(candidate) {
  return deploymentHistoryForReview(process.cwd(), candidate.commit ? {head: candidate.parent} : {});
}

async function review(args = [], {run, phase}) {
  const {validationEvidence, requestedValidationEvidence, inherited, ownerApprovalEvidence, proposalRecord, candidate, directory, observedPaths, establishedObservedPaths} = await phase("precheck_ms", async () => {
    const {validationEvidence: requestedValidationEvidence, ownerApprovalEvidence} = reviewArguments(args);
    const proposalRecord = await readProposalRecord();
    const candidate = await assertExactStagedCandidate();
    const deployment = await candidateDeploymentHistory(candidate);
    candidate.files = [...new Set([...candidate.files, ...deployment.integrated_paths])].sort();
    const directory = await oracleDirectory();
    const native = await inheritNativeEvidence({root: process.cwd(), directory, base: candidate.base, requestedEvidence: requestedValidationEvidence});
    const observed = await inheritObservedEvidence({directory, base: candidate.base, root: process.cwd(), requestedEvidence: [...requestedValidationEvidence, ...native.evidence]});
    const inherited = {evidence: [...native.evidence, ...observed.evidence], invalidated: [...native.invalidated, ...observed.invalidated]};
    const {paths: observedPaths, established: establishedObservedPaths} = await observationSourcePaths({directory, base: candidate.base, withBindingState: true});
    return {validationEvidence: [...requestedValidationEvidence, ...inherited.evidence], requestedValidationEvidence, inherited, ownerApprovalEvidence, proposalRecord, candidate, directory, observedPaths, establishedObservedPaths};
  });
  const capture = async () => {
    const current = await assertExactStagedCandidate();
    const inputs = await captureInputs({root: process.cwd(), base: current.base, tree: current.tree, validationEvidence, ownerApprovalEvidence, proposal: await readProposalRecord(), complete: true, observedPaths, establishedObservedPaths});
    const deployment = await candidateDeploymentHistory(current);
    return {...inputs, ...(current.commit ? {candidate_commit: current.commit} : {}), reviewer_settings: await selectedSettings(), deployment_history_sha256: deployment.sha256, deployment_baseline_commit: deployment.baseline, deployment_history_state_sha256: bindingHash({status: deployment.status, unverified: deployment.unverified_commits, limitation: deployment.limitation})};
  };
  const inputs = await phase("snapshot_ms", capture);
  const settings = await phase("model_selection_ms", async () => inputs.reviewer_settings);
  const {model, reasoning_effort: effort} = settings;
  const reviewerRecord = await recordReviewer(run, settings, responseSchema);
  const series = await phase("series_ms", async () => {
    const facts = await candidateFiles(candidate);
    const validationProofs = await readValidationProofs({root: process.cwd(), directory, validation: inputs.validation});
    return prepareSeries({directory, candidate, inputs, ...facts, environment: environmentHash(), validationProofs, proposalRecord, inheritedInvalidations: inherited.invalidated});
  });
  const prepared = await phase("preparation_ms", () => preparedEvidence(directory, {inputs, ...reviewerRecord}, async () => ({inputs, ...reviewerRecord, proposal: proposalRecord, staged_files: candidate.files, diff: await git(candidate.commit ? ["diff", "--binary", "--no-ext-diff", candidate.base, candidate.commit] : ["diff", "--cached", "--binary", "--no-ext-diff"]), validation_evidence: validationEvidence, owner_approval_evidence: ownerApprovalEvidence})));
  const deployment = await candidateDeploymentHistory(candidate);
  const evidence = {...prepared.payload, requested_validation_evidence: requestedValidationEvidence, inherited_validation_evidence: inherited.evidence, review_context: series.public, reviewer_metadata_file: path.join(run, "reviewer.json"), deployment_history: deployment, integrated_deployment_diff: deployment.unverified_commits.length && deployment.baseline ? await git(["diff", "--binary", "--no-ext-diff", deployment.baseline, candidate.tree]) : null};
  await atomicJson(path.join(run, "evidence.json"), evidence);
  await atomicJson(path.join(run, "preparation.json"), {reused: prepared.reused, sha256: bindingHash(evidence)});
  const schemaPath = path.join(run, "response.schema.json"); const outputPath = path.join(run, "response.json");
  await writeMetadataFile(schemaPath, `${JSON.stringify(responseSchema, null, 2)}\n`);
  const prompt = [
    "Act as the independent My CRM project-local Oracle approver.", "Confirm the current governing instructions first: AGENTS.md, Vault/docs/CONSTITUTION.md, and the local approver skill under the trusted developer execution contract; only this isolated Oracle process may adopt that skill. Read each current authority once. Then inspect the commits and sealed supporting observations, independently re-attest affected criteria and missing paths, and preserve valid unchanged results.",
    `Immutable complete evidence reference: ${path.join(run, "evidence.json")}. Begin with your bounded cohort inputs and current assigned changes. Read only targeted original fields/source chunks for a named unresolved fact; retain source/dependency coverage identities across fresh reviewer conversations. Preparation and coverage reuse never reuse an Oracle verdict.`,
    `Review the exact Git tree ${candidate.tree} against base commit ${candidate.base}. Candidate committed SHA: ${candidate.commit ?? "staged compatibility mode"}. Inspect the sealed approved proposal through a bounded projection of evidence.proposal; independently assess its applicability. Caller-supplied exact owner-approval evidence: ${ownerApprovalEvidence ?? "none supplied"}.`,
    apiVersionRequestPolicy,
    localExecutionPolicy,
    "Use read-only inspection. Do not edit, stage, commit, or run a release.", "Classify authentication impact and owner-approval sufficiency yourself. Treat caller evidence only as evidence to verify, never as a classification or verdict. Emit any constitutionally required authentication warning in the warning field; ordinary agents have no authority to emit it.",
    "Assess actual protected deployment effects in protected_deployment_effects. Emit an empty array for ordinary corrections and compatible repairs. Architecture and public API-contract labels, authentication impact and filenames alone establish no protected effect. For each actual credential-trust, permission-authority, tenant-isolation or incompatible-public-contract effect, record a stable id, exact behavior, owning source paths and verified direct-human authority {evidence:absolute hash-bound file,quote:verbatim exact authorization}, or null when missing. Missing permission is a nonblocking deployment warning and never a source defect or technical rejection. owner_approval_status summarizes verified deployment permission independently of authentication_impact; NOT_REQUIRED is valid for any impact classification without a protected effect.",
    "Independently examine every inherited protected effect in evidence.deployment_history, including earlier commits followed by an ordinary repair. Supply exactly one deployment_effect_dispositions entry per inherited receipt/effect identity: EFFECTIVE, REVERTED or SUPERSEDED, with exact current-source evidence. A later ordinary commit cannot conceal an earlier effective effect; genuine removal or replacement must be independently attested against this entire candidate. New effects belong only in protected_deployment_effects. Technical approval and source-review branch publication continue with MISSING human deployment authority; the owning publication/install workflow checks exact authority before a protected mutation.",
    "Missing private historical receipts never prevent source assessment. When deployment_history.unverified_commits is nonempty, review integrated_deployment_diff and every added required path across the exact configured published-base-to-current-tree range, including earlier unpublished commits. Classify all actual protected effects in that integrated range, alongside verified inherited effects; never let an ordinary latest change mask a prior protected change. The launcher seals only those exact commit/tree recovery identities covered by this completed whole-candidate decision. If deployment_history.status is UNAVAILABLE, technical assessment/receipt/commit still complete independently and the specific historical custody or configured-published-base limitation remains a separate deployment-readiness warning. Supply the safe fetch/integrate and complete-range technical review remedy; missing deployment history supplies no human approval requirement.",
    "Consolidate technical blocking findings under concise Problem, Cause, Recommended change parts with no more than three sentences in each part. Human deployment permission supplies no technical approval and technical approval supplies no new human authority.",
    "Verify that the completed candidate stays within the sealed approved proposal scope and current governing instructions. Proposal input changes preserve historical scope observations; independently assess affected criteria against the current bound authority manifest. Make one complete pass over each unvalidated commit or batched range, consolidate all findings, and reassess only new, missing or affected scope on repairs. Proposal approval never substitutes for completed-tree review.", "Return COMPLETE and APPROVED only when the entire staged candidate satisfies every applicable authority and validation requirement. Return COMPLETE and REJECTED with all established actionable findings after complete coverage. Return INCOMPLETE and null verdict when unfinished; record completed partial coverage and remaining scope.", "Return only the response required by the supplied JSON schema."
  ].join("\n");
  let response, assessed, rawResponse, completedSeries;
  try {
    assertInputsMatch(inputs, await capture());
    await phase("reviewer_ms", () => runParallelReview({run, candidate, inputs, evidence, schema: responseSchema, sharedPrompt: prompt,
      diffForPaths: (paths) => paths.filter((name) => !path.isAbsolute(name)).length ? git(["diff", "--binary", "--no-ext-diff", series.public.previous_candidate ?? candidate.base, candidate.tree, "--", ...paths.filter((name) => !path.isAbsolute(name))]) : Promise.resolve(""),
      invoke: (cohort) => execOracle(["exec", "--ephemeral", "--ignore-user-config", "--model", model, "--sandbox", "danger-full-access", "--output-schema", cohort.schema, "--output-last-message", cohort.output, "--cd", process.cwd(), cohort.prompt], cohort.directory, effort)}));
    rawResponse = await readMetadataFile(outputPath, "utf8");
    response = validateOracleResponse(JSON.parse(rawResponse), {requireApiAssessment: true});
    validateDeploymentAssessment(response, {required: true});
    validateDeploymentDispositions(response, deployment.history);
    await verifyNewEffectAuthorities(response, inputs);
    await verifyApiVersionRequestEvidence(response, inputs.validation.filter((item) => requestedValidationEvidence.includes(item.value)));
    if (!new Ajv({strict: false}).validate(responseSchema, response)) throw new Error("Independent Oracle response does not satisfy its response schema");
    assessed = assessRound(series, response, inputs.validation);
    await phase("postcheck_ms", async () => assertInputsMatch(inputs, await capture()));
    completedSeries = await saveRound(series, response, assessed, {beforePublish: async () => {
      const currentProofs = await readValidationProofs({root: process.cwd(), directory, validation: inputs.validation});
      assertValidationProofsMatch(series.public.validation_proofs, currentProofs);
      assertInputsMatch(inputs, await capture());
      await assertCurrentInvocation();
    }});
  } catch (error) {
    let observationError = null, execution = null, executionEvidence = null;
    if (!assessed) {
      try {
        rawResponse = await readMetadataFile(outputPath, "utf8");
        response = validateOracleResponse(JSON.parse(rawResponse), {requireApiAssessment: true});
        validateDeploymentAssessment(response, {required: true});
        validateDeploymentDispositions(response, deployment.history);
        await verifyNewEffectAuthorities(response, inputs);
        await verifyApiVersionRequestEvidence(response, inputs.validation.filter((item) => requestedValidationEvidence.includes(item.value)));
        if (!new Ajv({strict: false}).validate(responseSchema, response)) throw new Error("Independent Oracle response does not satisfy its response schema");
        assessed = assessRound(series, response, inputs.validation);
      } catch (failure) { observationError = {name: failure.name, message: failure.message}; }
    }
    if (assessed) {
      try {
        const filename = path.join(run, "process.json"), bytes = await readMetadataFile(filename, "utf8");
        execution = JSON.parse(bytes); executionEvidence = {value: `@${filename}`, sha256: sha256(bytes)};
      } catch (failure) { observationError ??= {name: failure.name, message: `Original reviewer process custody is unavailable: ${failure.message}`}; }
    }
    await saveRound(series, null, null, {error: {name: error.name, message: error.message, observation_error: observationError}, observed: assessed ? {response, assessed, response_evidence: {value: `@${outputPath}`, sha256: sha256(rawResponse)}, execution, execution_evidence: executionEvidence} : null});
    throw error;
  }
  if (response.warning) process.stderr.write(`${response.warning}\n`);
  process.stdout.write(`${response.summary}\nORACLE_REVIEW_STATUS=${response.review_status} series=${series.public.series_id} round=${series.public.round}\n`);
  for (const finding of response.findings) process.stdout.write(`ORACLE_FINDING=${JSON.stringify(finding)}\n`);
  if (completedSeries.rounds.at(-1).repair_plan) process.stdout.write(`ORACLE_REPAIR_PLAN=${JSON.stringify(completedSeries.rounds.at(-1).repair_plan)}\n`);
  if (response.synthesis) process.stdout.write(`ORACLE_REPAIR_SYNTHESIS=${response.synthesis}\n`);
  if (response.review_status === "INCOMPLETE") { process.exitCode = 1; return response; }
  const receipt = {schema: "my-crm.oracle-approval/v2", ...reviewerRecord, input_binding: inputs, proposal_record_sha256: proposalRecord.record_sha256, repository: "my-crm", invocation: currentInvocation(), reviewed_tree: candidate.tree, base_commit: candidate.base, ...(candidate.commit ? {candidate_commit: candidate.commit, deployment_history_base_commit: candidate.parent} : {}), ...response, deployment_baseline_commit: deployment.baseline, deployment_history_sha256: deployment.sha256, deployment_history_status: deployment.status, recovered_deployment_commits: deployment.recovered_commits, review_series_sha256: completedSeries.sha256, review_series_id: completedSeries.series_id, review_round: series.public.round, validation_evidence: validationEvidence, requested_validation_evidence: requestedValidationEvidence, inherited_validation_evidence: inherited.evidence, owner_approval_evidence: ownerApprovalEvidence};
  receipt.receipt_sha256 = receiptSha256(receipt);
  // The final exact-input check precedes series publication above. Live receipt
  // verification independently rejects source movement after that observation.
  await phase("publication_ms", async () => { await assertCurrentInvocation(); await archiveTechnicalReceipt(receipt, directory); await assertCurrentInvocation(); await atomicJson(await receiptPath(), receipt); await assertCurrentInvocation(); if (receipt.verdict === "APPROVED") await recordValidatedCommit({receipt}); });
  process.stdout.write(`ORACLE_VERDICT=${receipt.verdict} tree=${receipt.reviewed_tree} receipt=${receipt.receipt_sha256}\n`);
  if (receipt.verdict !== "APPROVED") process.exitCode = 1;
  return receipt;
}

async function captureValidation(args, {run, phase}) {
  const separator = args.indexOf("--");
  if (separator < 0 || !args[separator + 1]) throw new Error("Usage: validate [--input <project-file>]... [--owner-approval <evidence>] -- <executable> [arguments]");
  const evidenceArgs = [], selected = [];
  for (let index = 0; index < separator; index++) {
    if (args[index] === "--input") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error("--input requires an exact project file path");
      selected.push(value);
    } else evidenceArgs.push(args[index]);
  }
  const options = reviewArguments(evidenceArgs);
  if (options.validationEvidence.length) throw new Error("Validation capture accepts owner evidence, optional --input paths and an executable command");
  const command = args.slice(separator + 1);
  const reviewProvenance = [];
  const capture = async () => {
    if (selected.length) {
      const root = await realpath(process.cwd());
      const paths = [...new Set(await Promise.all([...selected, "package.json", "package-lock.json"].map(async (name) => {
        const filename = path.resolve(root, name), relative = path.relative(root, filename);
        if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).includes(".git")) throw new Error("Validation inputs must be exact files in the canonical project");
        // Inspect the caller's actual OS spelling before any normalization.
        // Selected sources have always required canonical project files.
        const custody = await pathCustody(root, name, {allowMissing: true, excluded: [path.join(root, ".git")]});
        if (custody.metadata === null && selected.includes(name)) throw new Error("A selected validation input is missing");
        if (custody.resolved_path !== filename || name.split(path.sep).some((part) => part === "." || part === "..")) throw new Error("Validation inputs must be regular canonical project files");
        return relative;
      })))].sort();
      const files = {}, selected_index = {};
      for (const name of paths) {
        const filename = path.join(root, name);
        try {
          const custody = await pathCustody(root, name, {excluded: [path.join(root, ".git")]});
          if (custody.metadata?.type !== "regular" || custody.resolved_path !== filename) throw new Error("Validation inputs must be regular canonical project files");
          files[name] = await git(["hash-object", "--", name]);
        } catch (error) { if (error.code !== "ENOENT") throw error; files[name] = null; }
        selected_index[name] = await git(["ls-files", "--stage", "--", name]);
      }
      if (selected.some((name) => files[path.relative(root, path.resolve(root, name))] === null)) throw new Error("A selected validation input is missing");
      const base = await git(["rev-parse", "HEAD"]);
      const inputs = await captureInputs({root, base, tree: null, ownerApprovalEvidence: options.ownerApprovalEvidence, complete: true});
      // Coverage identities use canonical authority digests for selected authorities.
      for (const authority of inputs.authorities) if (Object.hasOwn(files, authority.path)) files[authority.path] = authority.sha256;
      let proposal = null;
      try { proposal = sha256(await readMetadataFile(await proposalPath())); } catch (error) { if (error.code !== "ENOENT") throw error; }
      reviewProvenance.push({base_commit: base, branch: await git(["branch", "--show-current"]), inputs, proposal_file_sha256: proposal});
      return {tree: null, scope: "declared-inputs-v2", files, context: {environment: environmentHash()}, selected_index, selected_paths: paths, file_metadata: await fileMetadata(root, paths)};
    }
    const candidate = await assertExactStagedCandidate();
    const inputs = await captureInputs({root: process.cwd(), base: candidate.base, tree: candidate.tree, ownerApprovalEvidence: options.ownerApprovalEvidence, complete: true});
    const snapshot = reviewSnapshot({candidate, inputs, ...await candidateFiles(candidate), environment: environmentHash()});
    return {...snapshot, file_metadata: await fileMetadata(process.cwd(), Object.keys(snapshot.files))};
  };
  const before = await phase("snapshot_ms", capture);
  const executionCwd = await realpath(process.cwd());
  const executable = await executableBinding(command[0], executionEnvironment(), executionCwd);
  let result, failure;
  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try { result = await phase("validation_ms", () => execFileAsync(command[0], command.slice(1), {cwd: executionCwd, env: executionEnvironment(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024, signal: controller.signal})); }
  catch (error) { failure = error; result = {stdout: error.stdout ?? "", stderr: error.stderr ?? ""}; }
  finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  const outputFile = path.join(run, "validation.output.log");
  const output = `${result.stdout}\n--- stderr ---\n${result.stderr}`;
  await writeMetadataFile(outputFile, output, {mode: 0o600});
  let after = null, afterExecutable = null, driftError = null;
  try { after = await capture(); afterExecutable = await executableBinding(command[0], executionEnvironment(), executionCwd); } catch (error) { driftError = error.message; }
  const unchanged = after && bindingHash(before) === bindingHash(after) && bindingHash(executable) === bindingHash(afterExecutable);
  const record = {schema: "my-crm.oracle-validation/v1", provenance: "launcher-owned-command-execution", command, execution_cwd: executionCwd,
    ...(selected.length ? {review_provenance: {before: reviewProvenance[0] ?? null, after: reviewProvenance[1] ?? null}} : {}),
    file_metadata_policy: "live-mode-and-type-v1",
    started_at: startedAt, finished_at: new Date().toISOString(), before, after, executable, after_executable: afterExecutable,
    outcome: failure ? "FAILED" : unchanged ? "PASSED" : "INPUT_DRIFT", exit_code: failure ? typeof failure.code === "number" ? failure.code : null : 0, signal: failure?.signal ?? null,
    error: failure?.message ?? driftError, output_file: outputFile, output_sha256: sha256(output),
    output_custody: await pathCustody(process.cwd(), outputFile, {scopeRoot: path.join(await oracleDirectory(), "runs"), allowFinalLink: false})};
  record.record_sha256 = validationDigest(record);
  const directory = path.join(await oracleDirectory(), "validations");
  await metadataDirectory(path.dirname(await oracleDirectory()), directory);
  const filename = path.join(directory, `${record.record_sha256}.json`);
  await atomicJson(filename, record);
  process.stdout.write(`ORACLE_VALIDATION=${record.outcome}\nORACLE_VALIDATION_EVIDENCE=@${filename}\n`);
  if (record.outcome !== "PASSED") process.exitCode = 1;
  return record;
}

async function reviewProposal(request, args = [], {run, phase}) {
  const {validationEvidence, ownerApprovalEvidence} = await phase("precheck_ms", async () => {
    if (!request?.trim()) throw new Error("Oracle proposal review requires a proposal");
    const arguments_ = reviewArguments(args);
    await removeMetadataFile(await proposalPath(), {force: true});
    return arguments_;
  });
  const capture = async () => {
    const inputs = await captureInputs({root: process.cwd(), base: await git(["rev-parse", "HEAD"]), validationEvidence, ownerApprovalEvidence});
    return {...inputs, reviewer_settings: await selectedSettings()};
  };
  const inputs = await phase("snapshot_ms", capture);
  const outputPath = path.join(run, "response.txt");
  await atomicJson(path.join(run, "inputs.json"), inputs);
  const prompt = [
    "Act as the independent My CRM project-local Oracle proposal approver.",
    "Read AGENTS.md, Vault/docs/CONSTITUTION.md, and .agents/skills/oracle/SKILL.md completely; only this isolated Oracle process may adopt that skill.",
    `Proposal: ${request}.`,
    `Caller-supplied validation evidence: ${validationEvidence.length ? validationEvidence.join(" | ") : "none supplied"}.`,
    `Caller-supplied exact owner-approval evidence: ${ownerApprovalEvidence ?? "none supplied"}.`,
    apiVersionRequestPolicy,
    localExecutionPolicy,
    "Use read-only inspection. Do not edit, stage, commit, release, or issue a completed-tree receipt.",
    "Verify the stated problem and cause. Classify architecture, public API-contract, authentication, and authorization impact yourself.",
    "Complete technical proposal assessment without human approval gates. Missing human deployment permission does not block technical verdict, proposal persistence, implementation or later source review. Classify actual protected credential-trust, permission-authority, tenant-isolation or incompatible-contract deployment effects separately with a nonblocking warning and exact required decision. Architecture/authentication/public-contract labels, filenames, ordinary corrections and compatible repairs alone create no permission requirement. The owning publication/install workflow checks specifically protected effects before mutation; preserve the independent explicit public API-version REQUEST requirement and technical rejection.",
    "A blocking finding must flag the user under concise Problem, Cause, and Recommended change parts with no more than three sentences each. Proposal approval never approves a completed diff.",
    "Explain the decision under concise Problem, Cause, and Recommended change headings. End with exactly four machine-readable lines: API_VERSION_ASSESSMENT=<single-line JSON object matching the five fields above>; AUTHENTICATION_IMPACT=NONE or AUTHENTICATION_IMPACT=AUTHENTICATION; OWNER_APPROVAL_STATUS=NOT_REQUIRED, APPROVED, or MISSING; and ORACLE_VERDICT=APPROVED or ORACLE_VERDICT=REJECTED."
  ].join("\n");
  let response;
  const settings = await phase("model_selection_ms", async () => inputs.reviewer_settings);
  const {model, reasoning_effort: effort} = settings;
  const reviewerRecord = await recordReviewer(run, settings);
  try {
    assertInputsMatch(inputs, await capture());
    await phase("reviewer_ms", () => execOracle(["exec", "--ephemeral", "--ignore-user-config", "--model", model, "--sandbox", "danger-full-access", "--output-last-message", outputPath, "--cd", process.cwd(), prompt], run, effort));
    const output = await readMetadataFile(outputPath, "utf8");
    const verdict = output.match(/(?:^|\n)ORACLE_VERDICT=(APPROVED|REJECTED)\s*$/)?.[1];
    const impact = output.match(/(?:^|\n)AUTHENTICATION_IMPACT=(NONE|AUTHENTICATION)\s*$/m)?.[1];
    const ownerStatus = output.match(/(?:^|\n)OWNER_APPROVAL_STATUS=(NOT_REQUIRED|APPROVED|MISSING)\s*$/m)?.[1];
    const apiAssessment = output.match(/(?:^|\n)API_VERSION_ASSESSMENT=(.+)$/m)?.[1];
    if (["API_VERSION_ASSESSMENT", "ORACLE_VERDICT", "AUTHENTICATION_IMPACT", "OWNER_APPROVAL_STATUS"].some((key) => output.split(/\r?\n/).filter((line) => line.startsWith(`${key}=`)).length !== 1)) throw new Error("Independent Oracle proposal returned ambiguous decision markers");
    if (!apiAssessment || !verdict || !impact || !ownerStatus) throw new Error("Independent Oracle proposal review omitted its machine-readable decision");
    response = validateOracleResponse({
      verdict,
      api_version_assessment: JSON.parse(apiAssessment),
      summary: output.trim(),
      authentication_impact: impact === "AUTHENTICATION",
      owner_approval_status: ownerStatus,
      warning: null,
      findings: []
    }, {requireApiAssessment: true});
    await verifyApiVersionRequestEvidence(response, inputs.validation);
  } finally { await phase("postcheck_ms", async () => assertInputsMatch(inputs, await capture())); }
  const record = {
    schema: "my-crm.oracle-proposal/v2",
    invocation: currentInvocation(),
    ...reviewerRecord,
    input_binding: inputs,
    repository: "my-crm",
    base_commit: await git(["rev-parse", "HEAD"]),
    proposal: request,
    proposal_sha256: sha256(request),
    validation_evidence: validationEvidence,
    owner_approval_evidence: ownerApprovalEvidence,
    review: response,
  };
  record.record_sha256 = proposalRecordSha256(record);
  await phase("publication_ms", async () => { assertInputsMatch(inputs, await capture()); await assertCurrentInvocation(); await atomicJson(await proposalPath(), record); });
  process.stdout.write(`${response.summary}\nORACLE_PROPOSAL=${response.verdict} record=${record.record_sha256}\n`);
  if (response.verdict !== "APPROVED") process.exitCode = 1;
  return response;
}

async function verifyLiveReceipt(tree) {
  const receipt = verifyReceipt(await readReceipt(), tree);
  await assertPublishedInvocation(receipt.invocation, await oracleDirectory());
  if (receipt.schema !== "my-crm.oracle-approval/v2" || !receipt.input_binding) throw new Error("Legacy Oracle receipt requires a fresh input-bound review; historical commit stamps remain valid");
  if (typeof receipt.reviewer?.model !== "string" || !receipt.reviewer.model.trim() || !["read-only", "danger-full-access"].includes(receipt.reviewer.sandbox) || receipt.reviewer.ephemeral !== true || receipt.reviewer.ignore_user_config !== true) throw new Error("Oracle reviewer provenance is invalid");
  if (!Object.hasOwn(receipt.reviewer, "reasoning_effort") || receipt.reviewer.reasoning_effort !== null && (typeof receipt.reviewer.reasoning_effort !== "string" || !receipt.reviewer.reasoning_effort.trim())) throw new Error("Oracle reviewer reasoning effort provenance is invalid");
  if (bindingHash(receipt.input_binding.reviewer_settings ?? null) !== bindingHash({model: receipt.reviewer.model, reasoning_effort: receipt.reviewer.reasoning_effort})) throw new Error("Oracle reviewer settings do not match the prepared input binding");
  if (receipt.review_status !== "COMPLETE" || receipt.reviewer.role !== "independent-project-oracle" || receipt.reviewer.role_instruction_sha256 !== sha256(trustedReviewerRole)) throw new Error("Live Oracle approval requires a complete assessment and trusted independent reviewer role");
  if (receipt.reviewer_metadata_sha256 !== sha256(`${JSON.stringify(receipt.reviewer, null, 2)}\n`) || receipt.reviewer.model_helper_sha256 !== sha256(await readFile(new URL("./codex-child-model.mjs", import.meta.url)))) throw new Error("Oracle reviewer metadata or helper provenance changed");
  const proposal = await readProposalRecord();
  if (receipt.proposal_record_sha256 !== proposal.record_sha256) throw new Error("Oracle approved proposal changed; fresh review is required");
  const current = await assertExactStagedCandidate();
  if (receipt.base_commit !== current.base || tree !== current.tree) throw new Error("Oracle receipt base or current staged tree changed; fresh review is required");
  const deployment = await candidateDeploymentHistory(current);
  assertInputsMatch(receipt.input_binding, {...await captureInputs({root: process.cwd(), base: current.base, tree: current.tree, validationEvidence: receipt.validation_evidence, ownerApprovalEvidence: receipt.owner_approval_evidence, proposal, complete: true, observedPaths: receipt.input_binding.observed_sources?.map((item) => item.path) ?? [], establishedObservedPaths: receipt.input_binding.observed_sources?.filter((item) => item.availability !== "UNAVAILABLE").map((item) => item.path) ?? [], reviewerSettings: receipt.input_binding.reviewer_settings}), ...(current.commit ? {candidate_commit: current.commit} : {}), deployment_history_sha256: deployment.sha256, deployment_baseline_commit: deployment.baseline, deployment_history_state_sha256: bindingHash({status: deployment.status, unverified: deployment.unverified_commits, limitation: deployment.limitation})});
  // Receipt verification checks the original immutable evidence and output.
  // Hook/CLI ambient environment and current command resolution are irrelevant
  // to the provenance of an already reviewed exact-tree result.
  await readValidationProofs({root: process.cwd(), directory: await oracleDirectory(), validation: receipt.input_binding.validation, checkCurrentExecutable: false});
  const directory = await oracleDirectory();
  const series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${current.base}.json`), "utf8", {root: path.dirname(directory)})), current.base);
  if (series.sha256 !== receipt.review_series_sha256 || series.series_id !== receipt.review_series_id || series.rounds.at(-1)?.round !== receipt.review_round || series.rounds.at(-1)?.snapshot.tree !== tree || series.rounds.at(-1)?.review_status !== "COMPLETE" || series.rounds.at(-1)?.verdict !== "APPROVED") throw new Error("Oracle review-series evidence changed; fresh review is required");
  return receipt;
}

const deploymentAuthorizationSchema = {
  type: "object", additionalProperties: false, required: ["decision", "summary", "authority", "approved_effect_keys"],
  properties: {decision: {type: "string", enum: ["AUTHORIZED", "MISSING"]}, summary: {type: "string", minLength: 1}, approved_effect_keys: {type: "array", items: {type: "string", minLength: 1}}, authority: {anyOf: [{type: "null"}, {type: "object", additionalProperties: false, required: ["evidence", "quote"], properties: {evidence: {type: "string", minLength: 1}, quote: {type: "string", minLength: 1}}}]}}
};

async function authorizeDeployment(reference, args, {run, phase}) {
  if (!reference || reference.startsWith("--")) throw new Error("authorize-deployment requires an exact target ref and --owner-approval @file");
  const {validationEvidence, ownerApprovalEvidence} = reviewArguments(args);
  if (!ownerApprovalEvidence?.startsWith("@")) throw new Error("Late deployment authorization requires a direct-human evidence file");
  const plan = await deploymentPlan({reference});
  const pending = await pendingDeploymentEffects(plan);
  if (!pending.length) { process.stdout.write("MYCRM_DEPLOYMENT_AUTHORIZATION=ALREADY_AUTHORIZED\n"); return {decision: "AUTHORIZED"}; }
  const capture = async () => ({...await captureInputs({root: process.cwd(), base: plan.commit, tree: plan.tree, validationEvidence, ownerApprovalEvidence, complete: true}), reviewer_settings: await selectedSettings(), deployment_plan_sha256: (await deploymentPlan({reference})).plan_sha256});
  const inputs = await capture();
  const settings = inputs.reviewer_settings;
  const reviewerRecord = await recordReviewer(run, settings, deploymentAuthorizationSchema);
  const evidence = {technical_receipt: plan.receipt, source_commit: plan.commit, source_tree: plan.tree, plan_sha256: plan.plan_sha256, effective_protected_effects: plan.effects, pending_protected_effects: pending, inputs};
  const schemaPath = path.join(run, "authorization.schema.json"), outputPath = path.join(run, "authorization.response.json");
  await atomicJson(path.join(run, "authorization.evidence.json"), evidence);
  await atomicJson(schemaPath, deploymentAuthorizationSchema);
  const authorizationPrompt = [
    "Act as the independent My CRM project-local Oracle solely to verify a later exact human deployment authorization.",
    `Evidence: ${path.join(run, "authorization.evidence.json")}. Exact target source tree: ${plan.tree}. Original immutable technical receipt: ${plan.receipt.receipt_sha256}.`,
    "The technical assessment is complete. Preserve its original receipt, findings, coverage and outputs unchanged; no new source assessment is needed solely for this human authorization. Verify original receipt custody, exact source/effect identities and the supplied direct-human evidence. Read only the narrow source/evidence needed for an unresolved identity or scope fact. Do not run tests, mutate source, publish, install, or overwrite the technical receipt.",
    "Authorize only the still-pending protected deployment effects in pending_protected_effects. Existing verified authority for other effective effects persists and requires no repeated human decision. Verify direct human provenance, exact scope, context, refusals and existing authority; broad release permission or technical approval creates no new authority. AUTHORIZED must name every pending effect key exactly once, without already-authorized keys, and return the absolute supplied owner-evidence path plus a verbatim direct-human authorization quote covering those pending effects. Otherwise return MISSING, null authority, and no approved_effect_keys. This deployment decision never changes technical review status, source commit eligibility or review-branch publication.",
    "Return only the supplied JSON schema. No new public API version is requested or permitted by this command."
  ].join("\n");
  await phase("reviewer_ms", () => execOracle(["exec", "--ephemeral", "--ignore-user-config", "--model", settings.model, "--sandbox", "danger-full-access", "--output-schema", schemaPath, "--output-last-message", outputPath, "--cd", process.cwd(), authorizationPrompt], run, settings.reasoning_effort));
  const response = JSON.parse(await readMetadataFile(outputPath, "utf8"));
  if (!new Ajv({strict: false}).validate(deploymentAuthorizationSchema, response)) throw new Error("Independent deployment authorization response is invalid");
  assertInputsMatch(inputs, await capture());
  if (response.decision !== "AUTHORIZED") { process.stdout.write(`MYCRM_DEPLOYMENT_AUTHORIZATION=MISSING ${response.summary}\n`); process.exitCode = 1; return response; }
  const record = {schema: "my-crm.deployment-authorization/v1", target_commit: plan.commit, target_tree: plan.tree, technical_receipt_sha256: plan.receipt.receipt_sha256, plan_sha256: plan.plan_sha256, ...response, ...reviewerRecord, owner_evidence: inputs.owner, input_binding: inputs};
  record.authorization_sha256 = authorizationDigest(record);
  await verifyDeploymentAuthorization(record, plan);
  const filename = path.join(await oracleDirectory(), "deployment-authorizations", `${plan.tree}-${plan.receipt.receipt_sha256}`, `${record.authorization_sha256}.json`);
  assertInputsMatch(inputs, await capture());
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  try { await writeMetadataFile(filename, bytes, {flag: "wx", mode: 0o600}); }
  catch (error) { if (error.code !== "EEXIST") throw error; if (await readMetadataFile(filename, "utf8") !== bytes) throw new Error("Immutable authorization attempt differs from its original bytes"); }
  process.stdout.write(`MYCRM_DEPLOYMENT_AUTHORIZATION=AUTHORIZED record=${record.authorization_sha256}\n`);
  return response;
}

async function verifyProposal() {
  const record = await readProposalRecord();
  await assertPublishedInvocation(record.invocation, await oracleDirectory());
  // Explicit current-proposal admission is strict. Completed review separately
  // retains the sealed proposal as scope evidence and assesses current criteria.
  verifyProposalRecord(record, await git(["rev-parse", "HEAD"]));
  assertInputsMatch(record.input_binding, await captureInputs({root: process.cwd(), base: await git(["rev-parse", "HEAD"]), validationEvidence: record.validation_evidence, ownerApprovalEvidence: record.owner_approval_evidence, reviewerSettings: record.input_binding.reviewer_settings}));
  if (record.schema !== "my-crm.oracle-proposal/v2") throw new Error("Legacy Oracle proposal requires a fresh authority-bound proposal review");
  console.log(JSON.stringify({verdict: "APPROVED", base_commit: record.base_commit, proposal_sha256: record.proposal_sha256}));
}

async function verifyIndex() {
  const candidate = await assertExactStagedCandidate(); const receipt = await verifyLiveReceipt(candidate.tree);
  console.log(`ORACLE_APPROVAL=APPROVED tree=${receipt.reviewed_tree} receipt=${receipt.receipt_sha256}`);
}

async function stampMessage(messagePath) {
  const tree = await git(["write-tree"]); const receipt = await verifyLiveReceipt(tree);
  await writeFile(messagePath, stampCommitMessage(await readFile(messagePath, "utf8"), receipt));
}

async function verifyMessage(messagePath) {
  const tree = await git(["write-tree"]);
  verifyCommitMessage({message: await readFile(messagePath, "utf8"), tree, receipt: await verifyLiveReceipt(tree)});
}

async function verifyCommit(reference) {
  const resolved = await git(["rev-parse", reference]);
  try {
    const selected = await committedReceipt(process.cwd(), reference);
    console.log(`ORACLE_COMMIT=APPROVED commit=${resolved} reviewed_commit=${selected.reviewedCommit} tree=${selected.tree} receipt=${selected.receipt.receipt_sha256}`);
    return;
  } catch (error) { if (!["ENOENT", "MYCRM_MISSING_HISTORICAL_RECEIPT"].includes(error.code)) throw error; }
  let reviewedReference = reference; const tree = await git(["rev-parse", `${reference}^{tree}`]); let message = await git(["show", "-s", "--format=%B", reference]);
  if (parseTrailers(message)[TRAILERS.verdict] === undefined) {
    const parents = (await git(["rev-list", "--parents", "-n", "1", reference])).split(/\s+/).slice(1);
    if (parents.length !== 2) throw new Error("Commit is missing an Oracle stamp and is not a two-parent merge of an approved tree");
    if (await git(["rev-parse", `${parents[1]}^{tree}`]) !== tree) throw new Error("Merge result differs from the Oracle-approved second-parent tree");
    reviewedReference = parents[1]; message = await git(["show", "-s", "--format=%B", reviewedReference]);
  }
  verifyPublishedCommitTrailers({message, tree});
  console.log(`ORACLE_COMMIT=APPROVED commit=${await git(["rev-parse", reference])} reviewed_commit=${await git(["rev-parse", reviewedReference])} tree=${tree}`);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  if (command === "review" || command === "proposal") {
    if (command === "review") {
      const selection = await shipmentPlan();
      if (selection.last_validated_commit && ["DELIVER", "NO_CHANGES"].includes(selection.action)) {
        console.log(`ORACLE_REVIEW=NO_UNVALIDATED_COMMITS commit=${selection.last_validated_commit}`);
        return {action: "NO_UNVALIDATED_COMMITS"};
      }
    }
    const directory = await oracleDirectory();
    return withOracleRun(directory, (context) => command === "review" ? review(process.argv.slice(3), context) : reviewProposal(argument, process.argv.slice(4), context), {
      kind: command,
      // Every admitted review invalidates active completion before preparation.
      onAdmitted: () => removeMetadataFile(path.join(directory, "approval.json"), {force: true}),
    });
  }
  if (command === "validate") return withOracleRun(await oracleDirectory(), (context) => captureValidation(process.argv.slice(3), context), {kind: "validation"});
  if (command === "authorize-deployment") return withOracleRun(await oracleDirectory(), (context) => authorizeDeployment(argument, process.argv.slice(4), context), {kind: "deployment-authorization"});
  if (command === "verify-proposal") return verifyProposal();
  if (command === "verify-index") return verifyIndex();
  if (command === "stamp-message" && argument) return stampMessage(argument);
  if (command === "verify-message" && argument) return verifyMessage(argument);
  if (command === "verify-commit") return verifyCommit(argument ?? "HEAD");
  throw new Error("Usage: oracle-review.mjs proposal <request> [--validation <evidence>]... [--owner-approval <exact-evidence>]|review [--validation <evidence>]... [--owner-approval <exact-evidence>]|validate [--input <project-file>]... [--owner-approval <evidence>] -- <executable> [arguments]|verify-proposal|verify-index|stamp-message <path>|verify-message <path>|verify-commit [ref]");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error(`ORACLE_PROCESS=ERROR ${error.message}`); process.exitCode = 1; });
