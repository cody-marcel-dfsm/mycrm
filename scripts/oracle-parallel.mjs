// Owner-local bounded independent review. Cohorts never publish approvals.
import path from "node:path";
import {atomicJson, bindingHash, readMetadataFile, writeMetadataFile} from "./oracle-inputs.mjs";

export const cohortIds = ["cross-cutting", "implementation-consumers", "verification-recovery"];
export const payloadLimit = 64 * 1024;
const unique = (values) => [...new Set(values)];
const governance = (name) => /(?:^|\/)(?:AGENTS\.md|CONSTITUTION\.md|architecture\.md)$|(?:^|\/)\.agents\/skills\/oracle\//.test(name);
const verification = (name) => /(?:^|\/)(?:tests?|\.github|\.githooks)\/|(?:release|deploy|install|shipment|recovery)/i.test(name);

export function cohortPlan({candidate, inputs, context}) {
  const plan = {schema: "my-crm.parallel-review/v1", candidate_commit: candidate.commit ?? null,
    candidate_tree: candidate.tree, input_binding_sha256: bindingHash(inputs), cohorts: []};
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
  const summarize = (items) => items.filter((item) => names.has(item.path)).map((item) => ({path: item.path,
    input_sha256: item.input_sha256 ?? null, dependencies: item.dependencies,
    origin: item.origin ?? item.round ?? null, assessment: String(item.assessment ?? item.reason ?? "").slice(0, 700)}));
  const value = {cohort: {...cohort, candidate_commit: plan.candidate_commit, candidate_tree: plan.candidate_tree,
    input_binding_sha256: plan.input_binding_sha256, plan_sha256: plan.plan_sha256},
    inputs: {authorities: evidence.inputs.authorities, candidate_commit: plan.candidate_commit,
      reviewed_tree: plan.candidate_tree, owner: evidence.inputs.owner},
    staged_files: evidence.staged_files,
    review_context: {required_paths: cohort.required_paths, eligible_coverage: summarize(context.eligible_coverage ?? []),
      supporting_coverage: summarize(context.supporting_coverage ?? []),
      prior_findings: primary ? context.prior_findings : [],
      finding_history: primary ? context.finding_history : [],
      observed_assessments: primary ? (context.observed_assessments ?? []).map((item) => ({round: item.round, findings: item.findings,
        response_evidence: item.response_evidence, execution_evidence: item.execution_evidence})) : [],
      unavailable_sources: primary ? context.unavailable_sources : [],
      validation_proofs: primary ? (context.validation_proofs ?? []).map((item) => ({id: item.id, eligible: item.eligible,
        reason: item.reason, evidence: item.evidence, record: item.record ? {command: item.record.command, output_file: item.record.output_file} : null})) : [],
      eligible_validations: primary ? (context.eligible_validations ?? []).map((item) => ({id: item.id, evidence: item.evidence})) : [],
      changed_since_previous: (context.pending_changed_paths ?? context.changed_since_previous ?? []).filter((name) => names.has(name))},
    inherited_effects: primary ? evidence.deployment_history.history : [],
    full_evidence_reference: "../../evidence.json",
    full_history_reference: context.history_file,
    reading_contract: "Read governing instructions first once per content identity, then this cohort's changes and applicable retained observations. Use bounded field projections and source chunks (at most 8 KiB per read); open full original records only for a named unresolved fact. A fresh reviewer conversation never resets sealed file coverage. No copied history grants proof or approval."};
  // Bound payload mechanically. Originals remain immutable, available by exact
  // references; omitted data never becomes an implicit assessment.
  if (Buffer.byteLength(JSON.stringify(value)) > payloadLimit) {
    value.review_context.supporting_coverage = [];
    value.review_context.finding_history = [];
    value.retained_details_on_demand = true;
  }
  if (Buffer.byteLength(JSON.stringify(value)) > payloadLimit) throw new Error("Cohort payload exceeds its bound; use narrower source cohorts");
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
    if (!envelope || envelope.cohort_id !== id || envelope.candidate_commit !== plan.candidate_commit
        || envelope.candidate_tree !== plan.candidate_tree || envelope.input_binding_sha256 !== plan.input_binding_sha256
        || envelope.plan_sha256 !== plan.plan_sha256) { issues.push(`Cohort ${id} candidate or plan binding differs`); continue; }
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
  if (resolutions.some((item) => findings.some((finding) => finding.id === item.id))) issues.push("Finding and resolution conflict across cohorts");
  const coverage = mergeRecords(responses, "coverage", (item) => item.path, issues);
  const validations = mergeRecords(responses, "validations", (item) => item.id, issues);
  const effects = mergeRecords(responses, "protected_deployment_effects", (item) => item.id, issues);
  const dispositions = mergeRecords(responses, "deployment_effect_dispositions", (item) => `${item.receipt_sha256}:${item.effect_id}`, issues);
  const scope = mergeRecords(responses, "scope_dispositions", (item) => item.path, issues);
  const changes = responses.map((item) => item.api_version_assessment).filter((item) => item?.impact === "CHANGE");
  if (changes.some((item) => bindingHash(item) !== bindingHash(changes[0]))) issues.push("Conflicting public API-version assessments");
  const complete = !issues.length;
  const rejected = findings.length > 0 || responses.some((item) => item.verdict === "REJECTED");
  return {issues, response: {review_status: complete ? "COMPLETE" : "INCOMPLETE", verdict: complete ? rejected ? "REJECTED" : "APPROVED" : null,
    summary: `Concurrent independent assessment: ${complete ? "all three cohorts complete" : issues.join("; ")}. ${responses.map((item) => item.summary).join(" ")}`,
    authentication_impact: responses.some((item) => item.authentication_impact),
    owner_approval_status: effects.length ? responses.some((item) => item.owner_approval_status === "MISSING") ? "MISSING" : "APPROVED" : "NOT_REQUIRED",
    warning: responses.map((item) => item.warning).filter(Boolean).join("; ") || null,
    api_version_assessment: changes[0] ?? responses[0]?.api_version_assessment ?? {impact: "NONE", request_kind: "NOT_REQUIRED", requested_change: null, request_quote: null, request_evidence: null},
    findings, resolutions, coverage, validations, protected_deployment_effects: effects, deployment_effect_dispositions: dispositions,
    scope_dispositions: scope, unreviewed: unique([...issues, ...responses.flatMap((item) => item.unreviewed ?? [])]),
    reused_coverage: unique(responses.flatMap((item) => item.reused_coverage ?? [])), reused_validations: unique(responses.flatMap((item) => item.reused_validations ?? [])),
    synthesis: responses.map((item) => item.synthesis).filter(Boolean).join("\n") || null}};
}

export async function runParallelReview({run, candidate, inputs, evidence, schema, invoke, sharedPrompt, diffForPaths}) {
  const plan = cohortPlan({candidate, inputs, context: evidence.review_context});
  await atomicJson(path.join(run, "cohort-plan.json"), plan, {exclusive: true});
  const wrapperSchema = {type: "object", additionalProperties: false,
    required: ["cohort_id", "candidate_commit", "candidate_tree", "input_binding_sha256", "plan_sha256", "cross_area_assessment", "response"],
    properties: {cohort_id: {type: "string"}, candidate_commit: {type: ["string", "null"]}, candidate_tree: {type: "string"},
      input_binding_sha256: {type: "string"}, plan_sha256: {type: "string"}, cross_area_assessment: {type: "string", minLength: 1}, response: schema}};
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
    const started = new Date().toISOString(); let error = null, envelope = null;
    try {
      await invoke({directory, schema: path.join(directory, "response.schema.json"), output: path.join(directory, "response.json"),
        prompt: `${sharedPrompt}\nAssigned cohort: ${cohort.id}. ${cohort.cross_area}\nBounded cohort inputs: ${path.join(directory, "evidence.json")}. Assess ONLY its required new/missing/affected paths and relevant dependencies, re-attesting applicable unchanged sealed observations. The cross-cutting cohort owns the global proposal, criteria, inherited-effect and API assessment; other cohorts independently report any actual effect discovered in their assigned implementation and tests without rereading unrelated deployment history. Every cohort is required and runs concurrently; this response is your cohort's decision, never a whole-candidate approval. Return the exact echoed cohort/candidate/input/plan bindings and response wrapper required by the supplied schema. The native controller consolidates all findings and performs complete-candidate admission; no serial final reviewer follows. Return explicit cross_area_assessment tracing entrypoints, construction, consumers, dependencies, publication and recovery edges, with source/evidence references. Do not read the full original history/context unless a named unresolved fact requires a bounded projection.`});
      envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8"));
      if (bindingHash(payloadBytes.toString()) !== bindingHash((await readMetadataFile(path.join(directory, "evidence.json"))).toString())) throw new Error("Cohort inputs changed during assessment");
      if (bindingHash(schemaBytes.toString()) !== bindingHash((await readMetadataFile(path.join(directory, "response.schema.json"))).toString())
          || bindingHash(changesBytes.toString()) !== bindingHash((await readMetadataFile(path.join(directory, "changes.json"))).toString())
          || bindingHash(diffBytes.toString()) !== bindingHash((await readMetadataFile(path.join(directory, "delta.diff"))).toString())) throw new Error("Cohort schema or source-delta inputs changed during assessment");
    } catch (cause) { error = cause.message; try { envelope = JSON.parse(await readMetadataFile(path.join(directory, "response.json"), "utf8")); } catch {} }
    let process = null;
    try { process = JSON.parse(await readMetadataFile(path.join(directory, "process.json"), "utf8")); } catch {}
    const outcome = {id: cohort.id, started_at: started, finished_at: new Date().toISOString(), error, process, envelope};
    await atomicJson(path.join(directory, "outcome.json"), outcome, {exclusive: true});
    return outcome;
  }));
  const outcomes = settled.map((item, index) => item.status === "fulfilled" ? item.value : {id: prepared[index].cohort.id,
    error: String(item.reason), envelope: null, started_at: null, finished_at: new Date().toISOString()});
  const aggregate = aggregateCohorts(plan, outcomes);
  await atomicJson(path.join(run, "cohort-outcomes.json"), {plan_sha256: plan.plan_sha256, outcomes, issues: aggregate.issues,
    actual_overlap: outcomes.every((item) => item.started_at) && Math.max(...outcomes.map((item) => Date.parse(item.started_at))) < Math.min(...outcomes.map((item) => Date.parse(item.finished_at)))}, {exclusive: true});
  await atomicJson(path.join(run, "response.json"), aggregate.response, {exclusive: true});
  await atomicJson(path.join(run, "process.json"), {exit_code: aggregate.issues.length ? 1 : 0,
    signal: outcomes.find((item) => item.process?.signal)?.process.signal ?? null,
    interrupted: outcomes.some((item) => item.process?.interrupted), cohort_count: outcomes.length}, {exclusive: true});
  if (aggregate.issues.length) throw new Error(`Concurrent independent review incomplete: ${aggregate.issues.join("; ")}`);
  return aggregate.response;
}
