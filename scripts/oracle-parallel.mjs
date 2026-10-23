// Owner-local bounded independent review. Cohorts never publish approvals.
import path from "node:path";
import Ajv from "ajv";
import {atomicJson, bindingHash, contentHash, readMetadataFile, writeMetadataFile, evidenceBinding, assertEvidenceIntegrity} from "./oracle-inputs.mjs";
import {prepareSourcePacket, utf8Pages} from "./oracle-source-packet.mjs";

export const cohortIds = ["cross-cutting", "implementation-consumers", "verification-recovery"];
const auditStates = new WeakMap();
export function createNativeCohortAudit() {
  const state = {owner: null, verified: new Map(), reused: 0, assessed: 0};
  const audit = Object.freeze({get statistics() {return {reused: state.reused, assessed: state.assessed};}});
  auditStates.set(audit, state); return audit;
}
export const payloadLimit = 64 * 1024;
const unique = (values) => [...new Set(values)];
const serializedPayloadBytes = value => Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`);
const originalReference = pointer => ({file: "../../evidence.json", pointer});

function boundedPayload(value, evidence, primary) {
  const context = evidence.review_context;
  const collection = (items, pointer) => ({count: items.length, original_sha256: bindingHash(items), original_reference: originalReference(pointer)});
  if (serializedPayloadBytes(value) > payloadLimit) {
    value.retained_collections = {...value.retained_collections,
      supporting_coverage: collection(context.supporting_coverage ?? [], "/review_context/supporting_coverage"),
      finding_history: collection(context.finding_history ?? [], "/review_context/finding_history")};
    value.review_context.supporting_coverage = [];
    value.review_context.finding_history = [];
    value.retained_details_on_demand = true;
  }
  if (serializedPayloadBytes(value) > payloadLimit && primary) {
    const observed = context.observed_assessments ?? [], identities = new Map();
    for (const [assessmentNumber, assessment] of observed.entries()) for (const [findingNumber, finding] of assessment.findings.entries()) {
      const identity = {id: finding.id, code: finding.code, path: finding.path, origin: finding.origin, severity: finding.severity};
      const key = bindingHash(identity), item = identities.get(key) ?? {...identity, occurrence_count: 0, original_versions: []};
      const hash = bindingHash(finding);
      if (!item.original_versions.some(version => version.original_sha256 === hash)) item.original_versions.push({original_sha256: hash,
        original_reference: originalReference(`/review_context/observed_assessments/${assessmentNumber}/findings/${findingNumber}`)});
      item.occurrence_count++;
      identities.set(key, item);
    }
    value.retained_collections.observed_assessments = {...collection(observed, "/review_context/observed_assessments"),
      grants_eligible_coverage: false, grants_approval: false};
    value.review_context.observed_finding_index = [...identities.values()];
    value.review_context.observed_assessments = [];
  }
  if (serializedPayloadBytes(value) > payloadLimit && primary) {
    const proofs = context.validation_proofs ?? [];
    value.retained_collections.validation_proofs = collection(proofs, "/review_context/validation_proofs");
    value.review_context.validation_proof_index = proofs.map(item => ({id: item.id, eligible: item.eligible}));
    value.review_context.validation_proofs = [];
  }
  if (serializedPayloadBytes(value) > payloadLimit && primary && value.review_context.observed_finding_index?.length) {
    // Growing repair histories repeat the same original collection locator for
    // every distinct finding version. Keep each hash and exact numeric location
    // while declaring the shared immutable collection pointer once.
    value.review_context.observed_finding_versions = {
      original_reference: originalReference("/review_context/observed_assessments"),
      tuple_fields: ["original_sha256", "assessment_index", "finding_index"],
      reading_contract: "Each original_versions tuple selects findings[finding_index] in observed_assessments[assessment_index]; verify its exact original_sha256 before disposition."
    };
    for (const item of value.review_context.observed_finding_index) item.original_versions = item.original_versions.map(version => {
      if (Array.isArray(version)) return version; // A second bounded preparation pass retains the same projection.
      const location = /^\/review_context\/observed_assessments\/(\d+)\/findings\/(\d+)$/.exec(version.original_reference.pointer);
      if (!location) throw new Error("Observed finding version has no exact original collection location");
      return [version.original_sha256, Number(location[1]), Number(location[2])];
    });
  }
  if (serializedPayloadBytes(value) > payloadLimit) {
    value.retained_collections = {...value.retained_collections,
      requalification_candidates: collection(context.requalification_candidates ?? [], "/review_context/requalification_candidates"),
      eligible_coverage: collection(context.eligible_coverage ?? [], "/review_context/eligible_coverage")};
    value.review_context.eligible_coverage = value.review_context.eligible_coverage.map(item => ({path: item.path,
      input_sha256: item.input_sha256, original_sha256: item.original_sha256, original_reference: item.original_reference,
      independent_current_applicability_required: true}));
    value.review_context.requalification_candidates = value.review_context.requalification_candidates.map(item => ({path: item.path,
      original_sha256: item.original_sha256, original_reference: item.original_reference, coverage_eligibility: "NONE",
      independent_current_applicability_required: true}));
  }
  if (serializedPayloadBytes(value) > payloadLimit) throw new Error(`Cohort payload exceeds its bound after retained collection projection: ${serializedPayloadBytes(value)} bytes`);
  return value;
}
const governance = (name) => /(?:^|\/)(?:AGENTS\.md|CONSTITUTION\.md|architecture\.md)$|(?:^|\/)\.agents\/skills\/oracle\//.test(name);
const verification = (name) => /(?:^|\/)(?:tests?|\.github|\.githooks)\/|(?:release|deploy|install|shipment|recovery)/i.test(name);

export function cohortPlan({candidate, inputs, context}) {
  const plan = {schema: "my-crm.parallel-review/v1", candidate_commit: candidate.commit ?? null,
    candidate_tree: candidate.tree, input_binding_sha256: bindingHash(inputs), reviewer_settings: inputs.reviewer_settings ?? null, cohorts: []};
  const groups = Object.fromEntries(cohortIds.map((id) => [id, []]));
  for (const name of unique(context.required_paths)) groups[governance(name) ? cohortIds[0] : verification(name) ? cohortIds[2] : cohortIds[1]].push(name);
  for (const id of cohortIds) plan.cohorts.push({id, required_paths: groups[id].sort(),
    cross_area: id === "cross-cutting" ? "Independently assess current criteria, every open finding, production entrypoints, construction, consumers, publication and failure/recovery interactions across all cohorts. Account for all protected/API effects and inherited dispositions."
      : "Trace assigned changes through their actual producers, consumers, dependency construction and failure/recovery edges; report cross-area dependencies and findings explicitly."});
  plan.plan_sha256 = bindingHash(plan);
  return plan;
}

export function partitionPayload(plan, cohort, evidence) {
  const context = evidence.review_context, names = new Set(cohort.required_paths);
  const primary = cohort.id === "cross-cutting";
  const original = (pointer) => ({file: "../../evidence.json", pointer});
  const findingIndex = (item, pointer) => ({id: item.id, severity: item.severity, code: item.code,
    path: item.path, origin: item.origin, required_behavior: String(item.required_behavior ?? "").slice(0, 300),
    original_sha256: bindingHash(item), original_reference: original(pointer)});
  const summarize = (items, pointer) => items.flatMap((item, index) => names.has(item.path) ? [{path: item.path,
    input_sha256: item.input_sha256 ?? null, dependencies: item.dependencies,
    origin: typeof item.origin === "object" && item.origin ? {kind: item.origin.kind, id: item.origin.id, original_round: item.origin.original_round,
      original_tree: item.origin.original_tree, aggregate_status: item.origin.aggregate_status, child_status: item.origin.child_status, child_verdict: item.origin.child_verdict} : item.origin ?? item.round ?? null,
    assessment: String(item.assessment ?? item.reason ?? "").slice(0, 700),
    independent_current_applicability_required: true, coverage_eligibility: item.coverage_eligibility ?? null, policy_applicability: item.policy_applicability ?? null,
    original_sha256: bindingHash(item), original_reference: original(`${pointer}/${index}`)}] : []);

  const value = {cohort: {...cohort, candidate_commit: plan.candidate_commit, candidate_tree: plan.candidate_tree,
    input_binding_sha256: plan.input_binding_sha256, plan_sha256: plan.plan_sha256},
    inputs: {authorities: (evidence.inputs.authorities ?? []).map((item, index) => ({path: item.path, sha256: item.sha256,
      external: item.external ?? false, controlling: item.controlling ?? false,
      original_index: index})),
      authority_manifest_sha256: bindingHash(evidence.inputs.authorities ?? []),
      authority_manifest_reference: {file: "../../evidence.json", pointer: "/inputs/authorities"}, candidate_commit: plan.candidate_commit,
      reviewed_tree: plan.candidate_tree, owner: evidence.inputs.owner},
    staged_files: evidence.staged_files,
    review_context: {required_paths: cohort.required_paths, eligible_coverage: summarize(context.eligible_coverage ?? [], "/review_context/eligible_coverage"),
      supporting_coverage: summarize(context.supporting_coverage ?? [], "/review_context/supporting_coverage"),
      requalification_candidates: summarize(context.requalification_candidates ?? [], "/review_context/requalification_candidates"),
      requalification_required_paths: (context.requalification_required_paths ?? []).filter(name => names.has(name)),
      fresh_source_paths: (context.fresh_source_paths ?? cohort.required_paths).filter(name => names.has(name)),
      ambiguous_source_context: primary ? {count: (context.ambiguous_source_context ?? []).length,
        original_sha256: bindingHash(context.ambiguous_source_context ?? []), original_reference: original("/review_context/ambiguous_source_context"),
        source_eligibility: "CONTEXT_ONLY_REQUIRES_INDEPENDENT_CURRENT_ADOPTION"} : null,
      prior_findings: primary ? context.prior_findings.map((item, index) => findingIndex(item, `/review_context/prior_findings/${index}`)) : [],
      finding_history: primary ? context.finding_history.map((item, index) => ({id: item.id, code: item.code, path: item.path,
        last_status: item.last_status, last_round: item.last_round, original_sha256: bindingHash(item),
        original_reference: original(`/review_context/finding_history/${index}`)})) : [],
      observed_assessments: primary ? (context.observed_assessments ?? []).map((item, index) => ({round: item.round,
        findings: item.findings.map((finding, findingNumber) => findingIndex(finding, `/review_context/observed_assessments/${index}/findings/${findingNumber}`)),
        original_sha256: bindingHash(item), original_reference: original(`/review_context/observed_assessments/${index}`),
        response_evidence: item.response_evidence, execution_evidence: item.execution_evidence})) : [],
      unavailable_sources: primary ? context.unavailable_sources : [],
      validation_proofs: primary ? (context.validation_proofs ?? []).map((item) => ({id: item.id, eligible: item.eligible,
        reason: item.reason, evidence: item.evidence, record: item.record ? {command: item.record.command, output_file: item.record.output_file} : null})) : [],
      eligible_validations: primary ? (context.eligible_validations ?? []).map((item) => ({id: item.id, evidence: item.evidence})) : [],
      changed_since_previous: (context.changed_since_previous ?? []).filter((name) => names.has(name)),
      pending_changed_paths: (context.pending_changed_paths ?? []).filter((name) => names.has(name))},
    inherited_effects: primary ? evidence.deployment_history.history.map((item, index) => ({commit: item.commit, tree: item.tree,
      reviewedCommit: item.reviewedCommit, filename: item.filename,
      receipt: {receipt_sha256: item.receipt.receipt_sha256, protected_deployment_effects: item.receipt.protected_deployment_effects,
        deployment_effect_dispositions: item.receipt.deployment_effect_dispositions,
        api_version_assessment: item.receipt.api_version_assessment, authentication_impact: item.receipt.authentication_impact},
      original_reference: {file: "../../evidence.json", pointer: `/deployment_history/history/${index}`}})) : [],
    full_evidence_reference: "../../evidence.json",
    full_history_reference: context.history_file,
    reading_contract: "Read governing instructions first once per content identity, then this cohort's changes and applicable retained observations. Finding/history entries and retained_collections are identity indexes with hash-bound original pointers: inspect original statuses, criteria, custody, and each finding version's reproduction, required behavior, affected paths and acceptance checks through bounded field projections before current applicability/disposition. Raw ERROR observations grant zero eligible coverage or approval. Use source chunks at most 8 KiB per read; open original fields only for a named unresolved fact. A fresh reviewer conversation never resets sealed file coverage. No copied history grants proof or approval."};
  value.cohort.reviewer_settings_sha256 = bindingHash(plan.reviewer_settings);
  value.reviewer_settings = plan.reviewer_settings;
  return boundedPayload(value, evidence, primary);
}

function mergeRecords(responses, field, identity, issues) {
  const records = new Map();
  const combinedText = (...values) => unique(values.filter(value => typeof value === "string" && value)).join("\n\n");
  for (const response of responses) {
    const local = new Set();
    for (const item of response[field] ?? []) {
    const key = identity(item), old = records.get(key);
    if (local.has(key)) { issues.push(`Duplicate ${field} identity ${key} within one cohort`); continue; }
    local.add(key);
    if (old && bindingHash(old) !== bindingHash(item)) {
      if (field === "coverage") {
        records.set(key, {...old, dependencies: unique([...old.dependencies, ...item.dependencies]),
          dependency_rationale: `${old.dependency_rationale}; ${item.dependency_rationale}`,
          assessment: `${old.assessment}; ${item.assessment}`, criteria: unique([...old.criteria, ...item.criteria]),
          evidence: unique([...old.evidence, ...item.evidence]), finding_ids: unique([...old.finding_ids, ...item.finding_ids])});
      } else if (field === "deployment_effect_dispositions" && old.disposition === item.disposition) {
        records.set(key, {...old, evidence: `${old.evidence}; ${item.evidence}`});
      } else if (field === "resolutions" && old.status === item.status) {
        records.set(key, {...old, evidence: combinedText(old.evidence, item.evidence)});
      } else if (field === "scope_dispositions" && old.disposition === "UNAVAILABLE" && item.disposition === "UNAVAILABLE"
          && typeof old.evidence === "string" && old.evidence.trim() && typeof item.evidence === "string" && item.evidence.trim()) {
        records.set(key, {...old, evidence: combinedText(old.evidence, item.evidence)});
      } else if (field === "findings" && old.code === item.code && old.path === item.path && old.origin === item.origin) {
        const severity = ["critical", "high", "medium", "low"].find(value => [old.severity, item.severity].includes(value)) ?? old.severity;
        records.set(key, {...old, severity, message: combinedText(old.message, item.message),
          reproduction: combinedText(old.reproduction, item.reproduction), required_behavior: combinedText(old.required_behavior, item.required_behavior),
          affected_paths: unique([...old.affected_paths ?? [], ...item.affected_paths ?? []]),
          acceptance_checks: unique([...old.acceptance_checks ?? [], ...item.acceptance_checks ?? []]),
          missed_finding_reason: combinedText(old.missed_finding_reason, item.missed_finding_reason) || null});
      } else issues.push(`Conflicting ${field} identity ${key}`);
    } else records.set(key, item);
    }
  }
  return [...records.values()];
}

export function aggregateCohorts(plan, outcomes) {
  const issues = [], missingSources = new Set(), responses = [], seen = new Set();
  for (const outcome of outcomes) {
    const envelope = outcome.envelope, id = outcome.id;
    if (seen.has(id) || !plan.cohorts.some((item) => item.id === id)) issues.push(`Unexpected or duplicate cohort ${id}`);
    seen.add(id);
    if (outcome.error) issues.push(`Cohort ${id} execution failed: ${outcome.error}`);
    if (outcome.inputs_valid === false) issues.push(`Cohort ${id} bound inputs changed during assessment`);
    if (!envelope || envelope.cohort_id !== id || envelope.candidate_commit !== plan.candidate_commit
        || envelope.candidate_tree !== plan.candidate_tree || envelope.input_binding_sha256 !== plan.input_binding_sha256
        || envelope.plan_sha256 !== plan.plan_sha256 || envelope.reviewer_settings_sha256 !== bindingHash(plan.reviewer_settings)) { issues.push(`Cohort ${id} candidate or plan binding differs`); continue; }
    const response = envelope.response;
    if (typeof envelope.cross_area_assessment !== "string" || !envelope.cross_area_assessment.trim()) issues.push(`Cohort ${id} omitted cross-area integration assessment`);
    if (!response || !["COMPLETE", "INCOMPLETE"].includes(response.review_status)) { issues.push(`Cohort ${id} has no formal assessment`); continue; }
    if (response.review_status === "COMPLETE" && !["APPROVED", "REJECTED"].includes(response.verdict)) issues.push(`Cohort ${id} completed without a verdict`);
    const covered = new Set([...(response.coverage ?? []).map((item) => item.path), ...(response.reused_coverage ?? [])]);
    const missing = plan.cohorts.find((item) => item.id === id)?.required_paths.filter((name) => !covered.has(name)) ?? [];
    if (missing.length) {
      missing.forEach(name => missingSources.add(name));
      issues.push(`Cohort ${id} omitted required coverage: ${missing.join(", ")}`);
    }
    if (response.review_status !== "COMPLETE" || response.unreviewed?.length) issues.push(`Cohort ${id} has unfinished assessment`);
    responses.push(response);
  }
  for (const id of cohortIds) if (!seen.has(id)) issues.push(`Missing required cohort ${id}`);
  const findings = mergeRecords(responses, "findings", (item) => item.id, issues);
  const resolutions = mergeRecords(responses, "resolutions", (item) => item.id, issues);
  if (resolutions.some((item) => item.status !== "OPEN" && findings.some((finding) => finding.id === item.id))) issues.push("Finding and resolution conflict across cohorts");
  const coverage = mergeRecords(responses, "coverage", (item) => item.path, issues);
  const validations = mergeRecords(responses, "validations", (item) => item.id, issues);
  const effects = mergeRecords(responses, "protected_deployment_effects", (item) => item.id, issues);
  const dispositions = mergeRecords(responses, "deployment_effect_dispositions", (item) => `${item.receipt_sha256}:${item.effect_id}`, issues);
  const scope = mergeRecords(responses, "scope_dispositions", (item) => item.path, issues);
  const changes = responses.map((item) => item.api_version_assessment).filter((item) => item?.impact === "CHANGE");
  if (changes.some((item) => bindingHash(item) !== bindingHash(changes[0]))) issues.push("Conflicting public API-version assessments");
  const cross = outcomes.find((item) => item.id === "cross-cutting")?.envelope?.response;
  if (cross) for (const item of outcomes.filter((item) => item.id !== "cross-cutting")) {
    const specialist = item.envelope?.response;
    if (!specialist) continue;
    if (specialist.authentication_impact && !cross.authentication_impact) issues.push(`Cross-cutting authentication assessment omits ${item.id} impact`);
    if (specialist.api_version_assessment?.impact === "CHANGE" && bindingHash(specialist.api_version_assessment) !== bindingHash(cross.api_version_assessment)) issues.push(`Cross-cutting API assessment omits ${item.id} change`);
    for (const effect of specialist.protected_deployment_effects ?? []) if (!(cross.protected_deployment_effects ?? []).some((entry) => bindingHash(entry) === bindingHash(effect))) issues.push(`Cross-cutting assessment omits or contradicts ${item.id} protected effect ${effect.id}`);
    for (const disposition of specialist.deployment_effect_dispositions ?? []) if (!(cross.deployment_effect_dispositions ?? []).some((entry) => entry.receipt_sha256 === disposition.receipt_sha256 && entry.effect_id === disposition.effect_id && entry.disposition === disposition.disposition)) issues.push(`Cross-cutting assessment omits or contradicts ${item.id} inherited disposition`);
  }
  // Preserve the reported assessment separately from process success. A model
  // may return complete findings before its process exits unsuccessfully.
  const complete = !issues.some((item) => !item.includes(" execution failed:"));
  const rejected = findings.length > 0 || responses.some((item) => item.verdict === "REJECTED");
  return {issues, fatal_issues: issues.filter((item) => !/has unfinished assessment|omitted required coverage/.test(item)), reported_count: responses.length, response: {review_status: complete ? "COMPLETE" : "INCOMPLETE", verdict: complete ? rejected ? "REJECTED" : "APPROVED" : null,
    summary: `Concurrent independent assessment, plan ${plan.plan_sha256}: ${complete ? "all three cohorts reported complete assessment" : issues.join("; ")}. ${responses.map((item) => item.summary).join(" ")} ${outcomes.filter((item) => item.envelope).map((item) => `[${item.id} ${bindingHash(item.envelope)}] ${item.envelope.cross_area_assessment ?? ""}`).join(" ")}`,
    authentication_impact: responses.some((item) => item.authentication_impact),
    owner_approval_status: effects.length || dispositions.some((item) => item.disposition === "EFFECTIVE")
      ? responses.some((item) => item.owner_approval_status === "MISSING") ? "MISSING" : "APPROVED" : "NOT_REQUIRED",
    warning: responses.map((item) => item.warning).filter(Boolean).join("; ") || null,
    api_version_assessment: changes[0] ?? responses[0]?.api_version_assessment ?? {impact: "NONE", request_kind: "NOT_REQUIRED", requested_change: null, request_quote: null, request_evidence: null},
    findings, resolutions, coverage, validations, protected_deployment_effects: effects, deployment_effect_dispositions: dispositions,
    scope_dispositions: scope, unreviewed: complete ? [] : unique([...missingSources, ...issues, ...responses.flatMap((item) => item.unreviewed ?? [])]),
    reused_coverage: unique(responses.flatMap((item) => item.reused_coverage ?? [])), reused_validations: unique(responses.flatMap((item) => item.reused_validations ?? [])),
    synthesis: responses.map((item) => item.synthesis).filter(Boolean).join("\n") || null}};
}

export async function verifyParallelArtifacts(reference, {root} = {}) {
  if (!reference || path.basename(reference.path) !== "cohort-artifacts.json") throw new Error("Parallel review artifact reference is malformed");
  const raw = await readMetadataFile(reference.path, {}, {root});
  if (contentHash(raw) !== reference.sha256) throw new Error("Parallel review artifact manifest changed");
  const manifest = JSON.parse(raw), directory = path.dirname(reference.path);
  if (manifest.schema !== "my-crm.parallel-artifacts/v1" || !Array.isArray(manifest.files)) throw new Error("Parallel review artifact manifest is malformed");
  for (let start = 0; start < manifest.files.length; start += 16) {
    await Promise.all(manifest.files.slice(start, start + 16).map(async item => {
      if (!item.path.startsWith(`${directory}${path.sep}`) || contentHash(await readMetadataFile(item.path, {}, {root})) !== item.sha256) throw new Error("Parallel review original cohort evidence changed");
      if (item.binding) {
        if (item.binding.kind !== "file" || item.binding.sha256 !== item.sha256 || path.resolve(path.dirname(directory), item.binding.value.replace(/^@/, "")) !== item.path) throw new Error("Parallel review original cohort binding differs from its manifest");
        await assertEvidenceIntegrity(path.dirname(directory), [item.binding]);
      }
    }));
  }
  return manifest;
}

// A native ERROR may precede aggregate admission. Preserve its individual
// finding obligations without promoting source coverage or any reported verdict.
export async function nativeCohortObservations({root, directory, validation = [], retained = [], base = null, seriesId = null, audit = createNativeCohortAudit()}) {
  const owner = path.dirname(directory), runs = path.join(directory, "runs");
  const auditState = auditStates.get(audit);
  if (!auditState || auditState.owner && auditState.owner !== owner) throw new Error("Native cohort audit belongs to another owner");
  auditState.owner = owner;
  const pattern = /^([a-f0-9-]{36})\/cohorts\/(cross-cutting|implementation-consumers|verification-recovery)\/response\.json$/;
  const originals = new Map(retained.map(item => [item.response_evidence.value, item]));
  const references = new Map(retained.map(item => [item.response_evidence.value, item.response_evidence]));
  for (const item of validation) if (item.kind === "file") {
    const filename = path.resolve(root, item.value.replace(/^@/, ""));
    if (pattern.test(path.relative(runs, filename))) references.set(item.value, item);
  }
  const observations = [];
  // All cohorts in one invocation share the original manifest and parent
  // metadata. Audit those originals once in this call; each later preparation
  // or final integrity boundary creates a fresh audit and catches mutations.
  const manifests = new Map(), metadata = new Map(), bindings = new Map();
  const read = name => {if (!metadata.has(name)) metadata.set(name, readMetadataFile(name, "utf8", {root: owner}).then(JSON.parse)); return metadata.get(name);};
  const bind = value => {if (!bindings.has(value)) bindings.set(value, evidenceBinding(root, value)); return bindings.get(value);};
  for (const reference of references.values()) {
    const filename = path.resolve(root, reference.value.replace(/^@/, "")), match = path.relative(runs, filename).match(pattern);
    if (!match) throw new Error("Retained cohort report is outside the native review store");
    const [, invocation, cohort] = match, run = path.join(runs, invocation), area = path.dirname(filename);
    const binding = await bind(reference.value);
    if (binding.sha256 !== reference.sha256 || reference.custody && bindingHash(binding.custody) !== bindingHash(reference.custody)) throw new Error("Native cohort original report content or custody changed");
    const manifestPath = path.join(run, "cohort-artifacts.json"), manifestBinding = await bind(`@${manifestPath}`);
    const cacheKey = bindingHash(binding), checkpoint = auditState.verified.get(cacheKey);
    if (checkpoint) {
      if (base && base !== checkpoint.base || seriesId && seriesId !== checkpoint.seriesId) throw new Error("Native cohort report belongs to another review base or series");
      // Every phase freshly hashes all original bytes and custody identities.
      // Identical sealed facts can skip parsing and semantic provenance replay.
      const artifacts = await Promise.all(checkpoint.manifest.files.map(item => bind(`@${item.path}`)));
      const nativeBindings = await Promise.all(checkpoint.observation.native_bindings.map(item => bind(item.value)));
      if (bindingHash(manifestBinding) !== bindingHash(checkpoint.manifestBinding) || bindingHash(artifacts) !== checkpoint.observation.artifact_custody_sha256
          || bindingHash(nativeBindings) !== bindingHash(checkpoint.observation.native_bindings)) throw new Error("Native cohort original artifact content or custody changed");
      const old = originals.get(reference.value);
      if (old && (old.artifact_custody_sha256 !== checkpoint.observation.artifact_custody_sha256 || old.native_manifest_sha256 !== manifestBinding.sha256
          || bindingHash(old.native_bindings) !== bindingHash(checkpoint.observation.native_bindings))) throw new Error("Native cohort retained checkpoint differs from original provenance");
      auditState.reused++; observations.push(structuredClone(checkpoint.observation)); continue;
    }
    if (!manifests.has(manifestPath)) manifests.set(manifestPath, verifyParallelArtifacts({path: manifestPath, sha256: manifestBinding.sha256}, {root: owner}));
    const manifest = await manifests.get(manifestPath);
    const original = await read(path.join(run, "evidence.json")), native = await read(path.join(run, "outcome.json"));
    const plan = await read(path.join(run, "cohort-plan.json")), {plan_sha256, ...planBody} = plan;
    const payload = await read(path.join(area, "evidence.json")), process = await read(path.join(area, "process.json"));
    const outcome = await read(path.join(area, "outcome.json")), envelope = await read(filename), schema = await read(path.join(area, "response.schema.json"));
    const reviewerPath = path.join(run, "reviewer.json"), reviewer = await read(reviewerPath);
    const packet = await read(payload.source_packet.path);
    const required = [filename, path.join(run, "cohort-plan.json"), path.join(area, "evidence.json"), path.join(area, "process.json"), path.join(area, "outcome.json"), path.join(area, "response.schema.json"), payload.source_packet.path];
    if (required.some(name => !manifest.files.some(item => item.path === name))) throw new Error("Native cohort original provenance is absent from its artifact manifest");
    if (native.kind !== "review" || native.outcome !== "ERROR" || !native.reviewer_invoked || !native.started_at || !native.finished_at ||
        original.inputs.base_commit === undefined || base && original.inputs.base_commit !== base || seriesId && original.review_context.series_id !== seriesId || original.inputs.reviewed_tree !== plan.candidate_tree ||
        plan.schema !== "my-crm.parallel-review/v1" || plan_sha256 !== bindingHash(planBody) || manifest.plan_sha256 !== plan_sha256 ||
        plan.input_binding_sha256 !== bindingHash(original.inputs) || reviewer.role !== "independent-project-oracle" ||
        bindingHash(reviewer) !== bindingHash(original.reviewer) || contentHash(await readMetadataFile(reviewerPath, {}, {root: owner})) !== original.reviewer_metadata_sha256 ||
        reviewer.response_schema_sha256 !== contentHash(`${JSON.stringify(schema.properties.response, null, 2)}\n`) ||
        !original.producer_origin?.fresh_module_graph || !Number.isSafeInteger(process.pid) || !process.started_at || !process.finished_at ||
        outcome.inputs_valid !== true || bindingHash(outcome.process) !== bindingHash(process) || bindingHash(outcome.envelope) !== bindingHash(envelope) ||
        envelope.cohort_id !== cohort || envelope.candidate_commit !== plan.candidate_commit || envelope.candidate_tree !== plan.candidate_tree ||
        envelope.input_binding_sha256 !== plan.input_binding_sha256 || envelope.plan_sha256 !== plan_sha256 || envelope.reviewer_settings_sha256 !== bindingHash(plan.reviewer_settings) ||
        bindingHash(payload.cohort) !== bindingHash({...plan.cohorts.find(item => item.id === cohort), candidate_commit: plan.candidate_commit,
          candidate_tree: plan.candidate_tree, input_binding_sha256: plan.input_binding_sha256, plan_sha256, reviewer_settings_sha256: bindingHash(plan.reviewer_settings)}) ||
        packet.cohort_id !== cohort || packet.candidate_tree !== plan.candidate_tree || packet.candidate_commit !== plan.candidate_commit || packet.input_binding_sha256 !== plan.input_binding_sha256 ||
        !new Ajv({strict: false}).validate(schema, envelope)) throw new Error("Native cohort report lacks verified child, candidate, schema or source provenance");
    const artifacts = await Promise.all(manifest.files.map(item => bind(`@${item.path}`)));
    const custody = bindingHash(artifacts), old = originals.get(reference.value);
    if (old && (old.artifact_custody_sha256 !== custody || old.native_manifest_sha256 !== manifestBinding.sha256)) throw new Error("Native cohort original artifact content or custody changed");
    const nativeBindings = await Promise.all([...new Set([manifestPath, path.join(run, "evidence.json"), path.join(run, "outcome.json"), reviewerPath, ...required])].map(name => bind(`@${name}`)));
    if (old) await assertEvidenceIntegrity(root, old.native_bindings);
    const response = envelope.response;
    const completeChild = response.review_status === "COMPLETE" && response.unreviewed.length === 0 && outcome.error === null
      && process.exit_code === 0 && !process.signal && !process.interrupted;
    const knownPolicy = /^[a-f0-9]{64}$/.test(original.inputs.reviewer_policy_sha256 ?? "")
      && /^[a-f0-9]{64}$/.test(original.inputs.reviewer_policy_version ?? "") && /^[a-f0-9]{64}$/.test(reviewer.role_instruction_sha256 ?? "");
    const observation = {id: `cohort-${invocation}-${cohort}`, round: original.review_context.round, execution_status: "ERROR", source_verdict: null,
      reported_review_status: response.review_status, reported_verdict: response.verdict, observed_tree: plan.candidate_tree,
      response_evidence: binding, original_response_sha256: bindingHash(response), native_manifest_sha256: manifestBinding.sha256,
      artifact_custody_sha256: custody, native_bindings: nativeBindings, execution: process, custody_intact: true,
      coverage: [], reported_coverage: response.coverage, findings: response.findings, reported_findings: response.findings, unreviewed: response.unreviewed,
      reuse_completion: {candidate: completeChild && knownPolicy, reason: !completeChild ? "Independent child assessment is unfinished or its process failed" : !knownPolicy ? "Original effective policy or trusted role identity is unknown" : "Complete independent child observations require exact current dependency/context checks and fresh explicit current coverage",
        reviewer_policy_sha256: original.inputs.reviewer_policy_sha256 ?? null, reviewer_policy_version: original.inputs.reviewer_policy_version ?? null,
        trusted_role_sha256: reviewer.role_instruction_sha256 ?? null, reviewer_metadata_sha256: original.reviewer_metadata_sha256,
        input_binding_sha256: plan.input_binding_sha256, response_file_sha256: binding.sha256},
      applicability: "Original aggregate ERROR and child status remain unchanged. Intact COMPLETE child observations with known policy remain eligibility-NONE requalification context until fresh explicit current criteria/dependency/evidence coverage is admitted; no native coverage witness, passing validation or approval is inherited."};
    auditState.assessed++; auditState.verified.set(cacheKey, {manifest, manifestBinding, base: original.inputs.base_commit, seriesId: original.review_context.series_id, observation: structuredClone(observation)});
    observations.push(observation);
  }
  const identities = new Map();
  for (const observation of observations) for (const finding of observation.reported_findings) {
    const versions = identities.get(finding.id) ?? new Set(); versions.add(bindingHash({code: finding.code, path: finding.path})); identities.set(finding.id, versions);
  }
  for (const observation of observations) {
    observation.finding_identity_versions = observation.reported_findings.filter(finding => identities.get(finding.id).size > 1).map(finding => ({
      original_id: finding.id, qualified_id: `${finding.id}-${bindingHash({code: finding.code, path: finding.path}).slice(0, 16)}`,
      code: finding.code, path: finding.path, original_response_sha256: observation.original_response_sha256,
      reason: "Distinct literal finding identities reused one original ID; fresh independent disposition is required for every qualified version"}));
    observation.findings = observation.reported_findings.map(finding => ({...finding,
      id: observation.finding_identity_versions.find(version => version.original_id === finding.id && version.code === finding.code && version.path === finding.path)?.qualified_id ?? finding.id}));
  }
  return observations;
}

export async function runParallelReview({run, candidate, inputs, evidence, schema, invoke, sharedPrompt, diffForPaths, diffBase = candidate.base, sourceForPath}) {
  // Every projected pointer resolves into this frozen original, including on
  // provider failures and after the model has returned its current decision.
  const originalFile = path.join(run, "evidence.json"), evidenceRoot = path.dirname(run);
  const originalBinding = await evidenceBinding(evidenceRoot, `@${originalFile}`);
  if (bindingHash(JSON.parse(await readMetadataFile(originalFile, "utf8"))) !== bindingHash(evidence)) throw new Error("Parallel review original evidence differs from its projection inputs");
  const plan = cohortPlan({candidate, inputs, context: evidence.review_context});
  await atomicJson(path.join(run, "cohort-plan.json"), plan, {exclusive: true});
  const wrapperSchema = {type: "object", additionalProperties: false,
    required: ["cohort_id", "candidate_commit", "candidate_tree", "input_binding_sha256", "plan_sha256", "reviewer_settings_sha256", "cross_area_assessment", "response"],
    properties: {cohort_id: {type: "string"}, candidate_commit: {type: ["string", "null"]}, candidate_tree: {type: "string"},
      input_binding_sha256: {type: "string"}, plan_sha256: {type: "string"}, reviewer_settings_sha256: {type: "string"}, cross_area_assessment: {type: "string", minLength: 1}, response: schema}};
  const prepared = plan.cohorts.map((cohort) => ({cohort, directory: path.join(run, "cohorts", cohort.id), payload: partitionPayload(plan, cohort, evidence)}));
  // Finish all bounded input preparation before launching any reviewer.
  for (const area of prepared) {
    const {directory, payload, cohort} = area;
    const diff = diffForPaths ? await diffForPaths(payload.cohort.required_paths) : "";
    area.sourcePacket = await prepareSourcePacket({directory, candidate, inputs, evidence, cohort, diff, diffBase, sourceForPath});
    area.sourcePacket.files = await Promise.all(area.sourcePacket.files.map(async item => ({...item,
      binding: await evidenceBinding(evidenceRoot, `@${item.path}`)})));
    payload.source_packet = area.sourcePacket.reference;
    await writeMetadataFile(path.join(directory, "delta.diff"), diff, {flag: "wx"});
    await atomicJson(path.join(directory, "changes.json"), {bytes: Buffer.byteLength(diff), excerpt: utf8Pages(diff)[0],
      excerpt_complete: Buffer.byteLength(diff) <= 8192, scoped_diff_reference: "delta.diff", scoped_diff_sha256: bindingHash(diff)}, {exclusive: true});
    payload.changes_reference = "changes.json";
    payload.changes_excerpt_complete = Buffer.byteLength(diff) <= 8192;
    payload.full_evidence_sha256 = originalBinding.sha256;
    await atomicJson(path.join(directory, "evidence.json"), boundedPayload(payload, evidence, cohort.id === "cross-cutting"), {exclusive: true});
    await atomicJson(path.join(directory, "response.schema.json"), wrapperSchema, {exclusive: true});
  }
  const settled = await Promise.allSettled(prepared.map(async ({cohort, directory, sourcePacket}) => {
    const payloadBytes = await readMetadataFile(path.join(directory, "evidence.json"));
    const schemaBytes = await readMetadataFile(path.join(directory, "response.schema.json"));
    const changesBytes = await readMetadataFile(path.join(directory, "changes.json"));
    const diffBytes = await readMetadataFile(path.join(directory, "delta.diff"));
    const started = new Date().toISOString(); let error = null, envelope = null, inputsValid = true;
    try {
      await invoke({directory, schema: path.join(directory, "response.schema.json"), output: path.join(directory, "response.json"),
        prompt: `${sharedPrompt}\nAssigned cohort: ${cohort.id}. ${cohort.cross_area}\nBounded cohort inputs: ${path.join(directory, "evidence.json")}. Begin with the source packet ${sourcePacket.reference.path}: each path's retained_review_navigation pages preserve actual prior assessment, rationale, criteria, result evidence and exact per-dependency content/facts/custody/context comparisons. all_invalidation_reasons pages preserve every native reason, including validation and observed evidence. Read that navigation before repeating source or history reads. Actual assigned diff and complete source definitions are paged in UTF-8 with original Git/tree/line/byte locators; trace only concrete changed, missing or uncertain dependencies independently. Read authorities once per current identity and retain applicable checkpoints. Packet presence grants no coverage, proof or approval. Assess ONLY required new/missing/affected paths and relevant dependencies. The cross-cutting cohort owns global proposal, criteria, inherited-effect and API assessment. Other cohorts independently report effects discovered in their assigned implementation/tests. Every cohort runs concurrently; return only your cohort decision with exact bindings and cross-area entrypoint/construction/consumer/publication/recovery assessment. The native controller admits the complete-candidate decision; no serial model follows. Open full original history only for a named unresolved fact.`});
      envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8"));
    } catch (cause) { error = cause.message; try { envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8")); } catch {} }
    // Failed provider execution can still return useful observations. Their
    // original cohort inputs must be checked even on that error path.
    try {
      await assertEvidenceIntegrity(evidenceRoot, [originalBinding]);
      for (const [name, original] of [["evidence.json", payloadBytes], ["response.schema.json", schemaBytes], ["changes.json", changesBytes], ["delta.diff", diffBytes]]) {
        if (contentHash(original) !== contentHash(await readMetadataFile(path.join(directory, name)))) throw new Error("Cohort inputs changed during assessment");
      }
      for (const item of sourcePacket.files) if (contentHash(await readMetadataFile(item.path)) !== item.sha256) throw new Error("Cohort source packet original changed during assessment");
      await assertEvidenceIntegrity(evidenceRoot, sourcePacket.files.map(item => item.binding));
    } catch (cause) { inputsValid = false; error = [error, cause.message].filter(Boolean).join("; "); }
    let process = null;
    try { process = JSON.parse(await readMetadataFile(path.join(directory, "process.json"), "utf8")); } catch {}
    const outcome = {id: cohort.id, started_at: started, finished_at: new Date().toISOString(), error, inputs_valid: inputsValid, process, envelope};
    await atomicJson(path.join(directory, "outcome.json"), outcome, {exclusive: true});
    return outcome;
  }));
  const outcomes = settled.map((item, index) => item.status === "fulfilled" ? item.value : {id: prepared[index].cohort.id,
    error: String(item.reason), envelope: null, started_at: null, finished_at: new Date().toISOString()});
  const aggregate = aggregateCohorts(plan, outcomes);
  await atomicJson(path.join(run, "cohort-outcomes.json"), {plan_sha256: plan.plan_sha256, outcomes, issues: aggregate.issues,
    actual_overlap: outcomes.every((item) => item.started_at) && Math.max(...outcomes.map((item) => Date.parse(item.started_at))) < Math.min(...outcomes.map((item) => Date.parse(item.finished_at))),
    actual_process_overlap: outcomes.every((item) => item.process?.pid && item.process?.started_at && item.process?.finished_at)
      && Math.max(...outcomes.map((item) => Date.parse(item.process.started_at))) < Math.min(...outcomes.map((item) => Date.parse(item.process.finished_at)))}, {exclusive: true});
  if (aggregate.reported_count) await atomicJson(path.join(run, "response.json"), aggregate.response, {exclusive: true});
  await atomicJson(path.join(run, "process.json"), {exit_code: aggregate.fatal_issues.length ? 1 : 0,
    signal: outcomes.find((item) => item.process?.signal)?.process.signal ?? null,
    interrupted: outcomes.some((item) => item.process?.interrupted), cohort_count: outcomes.length,
    cohort_exit_codes: outcomes.map((item) => ({id: item.id, ...item.process}))}, {exclusive: true});
  const files = [{path: originalFile, sha256: originalBinding.sha256, binding: originalBinding}, ...prepared.flatMap(area => area.sourcePacket.files)];
  for (const name of ["cohort-plan.json", "cohort-outcomes.json", "response.json", "process.json",
    ...cohortIds.flatMap((id) => ["evidence.json", "changes.json", "delta.diff", "response.schema.json", "response.json", "outcome.json", "process.json", "reviewer.stdout.log", "reviewer.stderr.log"].map((leaf) => `cohorts/${id}/${leaf}`))]) {
    const filename = path.join(run, name);
    try { files.push({path: filename, sha256: contentHash(await readMetadataFile(filename))}); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const manifestPath = path.join(run, "cohort-artifacts.json");
  await atomicJson(manifestPath, {schema: "my-crm.parallel-artifacts/v1", plan_sha256: plan.plan_sha256, files}, {exclusive: true});
  const reference = {path: manifestPath, sha256: contentHash(await readMetadataFile(manifestPath))};
  if (aggregate.fatal_issues.length) throw Object.assign(new Error(`Concurrent independent review incomplete: ${aggregate.issues.join("; ")}`), {parallel_review_evidence: reference});
  return {response: aggregate.response, reference};
}
