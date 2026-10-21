// Owner-local bounded independent review. Cohorts never publish approvals.
import path from "node:path";
import {atomicJson, bindingHash, contentHash, readMetadataFile, writeMetadataFile} from "./oracle-inputs.mjs";

export const cohortIds = ["cross-cutting", "implementation-consumers", "verification-recovery"];
export const payloadLimit = 64 * 1024;
const unique = (values) => [...new Set(values)];
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
  const summarize = (items) => items.filter((item) => names.has(item.path)).map((item) => ({path: item.path,
    input_sha256: item.input_sha256 ?? null, dependencies: item.dependencies,
    origin: item.origin ?? item.round ?? null, assessment: String(item.assessment ?? item.reason ?? "").slice(0, 700)}));
  const value = {cohort: {...cohort, candidate_commit: plan.candidate_commit, candidate_tree: plan.candidate_tree,
    input_binding_sha256: plan.input_binding_sha256, plan_sha256: plan.plan_sha256},
    inputs: {authorities: (evidence.inputs.authorities ?? []).map((item, index) => ({path: item.path, sha256: item.sha256,
      external: item.external ?? false, controlling: item.controlling ?? false,
      original_index: index})),
      authority_manifest_sha256: bindingHash(evidence.inputs.authorities ?? []),
      authority_manifest_reference: {file: "../../evidence.json", pointer: "/inputs/authorities"}, candidate_commit: plan.candidate_commit,
      reviewed_tree: plan.candidate_tree, owner: evidence.inputs.owner},
    staged_files: evidence.staged_files,
    review_context: {required_paths: cohort.required_paths, eligible_coverage: summarize(context.eligible_coverage ?? []),
      supporting_coverage: summarize(context.supporting_coverage ?? []),
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
      changed_since_previous: (context.pending_changed_paths ?? context.changed_since_previous ?? []).filter((name) => names.has(name))},
    inherited_effects: primary ? evidence.deployment_history.history.map((item, index) => ({commit: item.commit, tree: item.tree,
      reviewedCommit: item.reviewedCommit, filename: item.filename,
      receipt: {receipt_sha256: item.receipt.receipt_sha256, protected_deployment_effects: item.receipt.protected_deployment_effects,
        deployment_effect_dispositions: item.receipt.deployment_effect_dispositions,
        api_version_assessment: item.receipt.api_version_assessment, authentication_impact: item.receipt.authentication_impact},
      original_reference: {file: "../../evidence.json", pointer: `/deployment_history/history/${index}`}})) : [],
    full_evidence_reference: "../../evidence.json",
    full_history_reference: context.history_file,
    reading_contract: "Read governing instructions first once per content identity, then this cohort's changes and applicable retained observations. Finding/history entries are identity indexes with hash-bound original pointers: inspect the original finding's reproduction, required behavior, affected paths and acceptance checks through bounded field projections before current applicability/disposition. Use source chunks at most 8 KiB per read; open original fields only for a named unresolved fact. A fresh reviewer conversation never resets sealed file coverage. No copied history grants proof or approval."};
  value.cohort.reviewer_settings_sha256 = bindingHash(plan.reviewer_settings);
  value.reviewer_settings = plan.reviewer_settings;
  // Bound payload mechanically. Originals remain immutable, available by exact
  // references; omitted data never becomes an implicit assessment.
  if (Buffer.byteLength(JSON.stringify(value)) > payloadLimit) {
    value.review_context.supporting_coverage = [];
    value.review_context.finding_history = [];
    value.retained_details_on_demand = true;
  }
  if (Buffer.byteLength(JSON.stringify(value)) > payloadLimit) throw new Error(`Cohort payload exceeds its bound; field bytes ${JSON.stringify(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Buffer.byteLength(JSON.stringify(item))])))}`);
  return value;
}

function mergeRecords(responses, field, identity, issues) {
  const records = new Map();
  for (const response of responses) for (const item of response[field] ?? []) {
    const key = identity(item), old = records.get(key);
    if (old && bindingHash(old) !== bindingHash(item)) {
      if (field === "coverage") {
        records.set(key, {...old, dependencies: unique([...old.dependencies, ...item.dependencies]),
          dependency_rationale: `${old.dependency_rationale}; ${item.dependency_rationale}`,
          assessment: `${old.assessment}; ${item.assessment}`, criteria: unique([...old.criteria, ...item.criteria]),
          evidence: unique([...old.evidence, ...item.evidence]), finding_ids: unique([...old.finding_ids, ...item.finding_ids])});
      } else if (field === "deployment_effect_dispositions" && old.disposition === item.disposition) {
        records.set(key, {...old, evidence: `${old.evidence}; ${item.evidence}`});
      } else issues.push(`Conflicting ${field} identity ${key}`);
    } else records.set(key, item);
  }
  return [...records.values()];
}

export function aggregateCohorts(plan, outcomes) {
  const issues = [], responses = [], seen = new Set();
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
    if (missing.length) issues.push(`Cohort ${id} omitted required coverage: ${missing.join(", ")}`);
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
    scope_dispositions: scope, unreviewed: complete ? [] : unique([...issues, ...responses.flatMap((item) => item.unreviewed ?? [])]),
    reused_coverage: unique(responses.flatMap((item) => item.reused_coverage ?? [])), reused_validations: unique(responses.flatMap((item) => item.reused_validations ?? [])),
    synthesis: responses.map((item) => item.synthesis).filter(Boolean).join("\n") || null}};
}

export async function verifyParallelArtifacts(reference, {root} = {}) {
  if (!reference || path.basename(reference.path) !== "cohort-artifacts.json") throw new Error("Parallel review artifact reference is malformed");
  const raw = await readMetadataFile(reference.path, {}, {root});
  if (contentHash(raw) !== reference.sha256) throw new Error("Parallel review artifact manifest changed");
  const manifest = JSON.parse(raw), directory = path.dirname(reference.path);
  if (manifest.schema !== "my-crm.parallel-artifacts/v1" || !Array.isArray(manifest.files)) throw new Error("Parallel review artifact manifest is malformed");
  for (const item of manifest.files) {
    if (!item.path.startsWith(`${directory}${path.sep}`) || contentHash(await readMetadataFile(item.path, {}, {root})) !== item.sha256) throw new Error("Parallel review original cohort evidence changed");
  }
  return manifest;
}

export async function runParallelReview({run, candidate, inputs, evidence, schema, invoke, sharedPrompt, diffForPaths}) {
  const plan = cohortPlan({candidate, inputs, context: evidence.review_context});
  await atomicJson(path.join(run, "cohort-plan.json"), plan, {exclusive: true});
  const wrapperSchema = {type: "object", additionalProperties: false,
    required: ["cohort_id", "candidate_commit", "candidate_tree", "input_binding_sha256", "plan_sha256", "reviewer_settings_sha256", "cross_area_assessment", "response"],
    properties: {cohort_id: {type: "string"}, candidate_commit: {type: ["string", "null"]}, candidate_tree: {type: "string"},
      input_binding_sha256: {type: "string"}, plan_sha256: {type: "string"}, reviewer_settings_sha256: {type: "string"}, cross_area_assessment: {type: "string", minLength: 1}, response: schema}};
  const prepared = plan.cohorts.map((cohort) => ({cohort, directory: path.join(run, "cohorts", cohort.id), payload: partitionPayload(plan, cohort, evidence)}));
  // Finish all bounded input preparation before launching any reviewer.
  for (const {directory, payload} of prepared) {
    const diff = diffForPaths ? await diffForPaths(payload.cohort.required_paths) : "";
    await writeMetadataFile(path.join(directory, "delta.diff"), diff, {flag: "wx"});
    await atomicJson(path.join(directory, "changes.json"), {bytes: Buffer.byteLength(diff), excerpt: diff.slice(0, 8192),
      excerpt_complete: diff.length <= 8192, scoped_diff_reference: "delta.diff", scoped_diff_sha256: bindingHash(diff)}, {exclusive: true});
    payload.changes_reference = "changes.json";
    payload.changes_excerpt_complete = diff.length <= 8192;
    await atomicJson(path.join(directory, "evidence.json"), payload, {exclusive: true});
    await atomicJson(path.join(directory, "response.schema.json"), wrapperSchema, {exclusive: true});
  }
  const settled = await Promise.allSettled(prepared.map(async ({cohort, directory}) => {
    const payloadBytes = await readMetadataFile(path.join(directory, "evidence.json"));
    const schemaBytes = await readMetadataFile(path.join(directory, "response.schema.json"));
    const changesBytes = await readMetadataFile(path.join(directory, "changes.json"));
    const diffBytes = await readMetadataFile(path.join(directory, "delta.diff"));
    const started = new Date().toISOString(); let error = null, envelope = null, inputsValid = true;
    try {
      await invoke({directory, schema: path.join(directory, "response.schema.json"), output: path.join(directory, "response.json"),
        prompt: `${sharedPrompt}\nAssigned cohort: ${cohort.id}. ${cohort.cross_area}\nBounded cohort inputs: ${path.join(directory, "evidence.json")}. Assess ONLY its required new/missing/affected paths and relevant dependencies, re-attesting applicable unchanged sealed observations. The cross-cutting cohort owns the global proposal, criteria, inherited-effect and API assessment; other cohorts independently report any actual effect discovered in their assigned implementation and tests without rereading unrelated deployment history. Every cohort is required and runs concurrently; this response is your cohort's decision, never a whole-candidate approval. Return the exact echoed cohort/candidate/input/plan bindings and response wrapper required by the supplied schema. The native controller consolidates all findings and performs complete-candidate admission; no serial final reviewer follows. Return explicit cross_area_assessment tracing entrypoints, construction, consumers, dependencies, publication and recovery edges, with source/evidence references. Do not read the full original history/context unless a named unresolved fact requires a bounded projection.`});
      envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8"));
    } catch (cause) { error = cause.message; try { envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8")); } catch {} }
    // Failed provider execution can still return useful observations. Their
    // original cohort inputs must be checked even on that error path.
    try {
      for (const [name, original] of [["evidence.json", payloadBytes], ["response.schema.json", schemaBytes], ["changes.json", changesBytes], ["delta.diff", diffBytes]]) {
        if (contentHash(original) !== contentHash(await readMetadataFile(path.join(directory, name)))) throw new Error("Cohort inputs changed during assessment");
      }
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
  const files = [];
  for (const name of ["cohort-plan.json", "cohort-outcomes.json", "response.json", "process.json",
    ...cohortIds.flatMap((id) => ["evidence.json", "changes.json", "delta.diff", "response.schema.json", "response.json", "outcome.json", "process.json", "reviewer.stdout.log", "reviewer.stderr.log"].map((leaf) => `cohorts/${id}/${leaf}`))]) {
    const filename = path.join(run, name);
    try { files.push({path: filename, sha256: contentHash(await readMetadataFile(filename))}); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const manifestPath = path.join(run, "cohort-artifacts.json");
  await atomicJson(manifestPath, {schema: "my-crm.parallel-artifacts/v1", plan_sha256: plan.plan_sha256, files}, {exclusive: true});
  const reference = {path: manifestPath, sha256: contentHash(await readMetadataFile(manifestPath))};
  if (aggregate.fatal_issues.length) throw new Error(`Concurrent independent review incomplete: ${aggregate.issues.join("; ")}`);
  return {response: aggregate.response, reference};
}
