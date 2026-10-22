import assert from "node:assert/strict";
import test from "node:test";
import {chmod, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {cohortPlan, partitionPayload, aggregateCohorts, runParallelReview, verifyParallelArtifacts, payloadLimit} from "../scripts/oracle-parallel.mjs";
import {atomicJson, bindingHash, withOracleRun} from "../scripts/oracle-inputs.mjs";
import {prepareSeries, assessRound, saveRound, seriesFindingSchema} from "../scripts/oracle-series.mjs";

const candidate = {commit: "1".repeat(40), tree: "2".repeat(40), base: "3".repeat(40)};
const inputs = {authorities: [], owner: null};
const names = ["AGENTS.md", "src/service.mjs", "tests/flow.test.mjs"];
function evidence() { return {inputs, staged_files: names, deployment_history: {history: []}, review_context: {
  required_paths: names, eligible_coverage: [], supporting_coverage: [], prior_findings: [], finding_history: [],
  observed_assessments: [], unavailable_sources: [], validation_proofs: [], eligible_validations: []}}; }
function response(paths) { return {review_status: "COMPLETE", verdict: "APPROVED", summary: "Assigned scope assessed",
  authentication_impact: false, owner_approval_status: "NOT_REQUIRED", warning: null,
  api_version_assessment: {impact: "NONE", request_kind: "NOT_REQUIRED", requested_change: null, request_quote: null, request_evidence: null},
  findings: [], resolutions: [], validations: [], protected_deployment_effects: [], deployment_effect_dispositions: [], scope_dispositions: [],
  unreviewed: [], reused_coverage: [], reused_validations: [], synthesis: null,
  coverage: paths.map((name) => ({path: name, dependencies: [name], dependency_rationale: "Trace the consumed source",
    assessment: "Entrypoint, consumer and recovery inspected", criteria: ["Current owner criteria"], evidence: [name], finding_ids: []}))}; }
function envelope(plan, cohort) { return {cohort_id: cohort.id, candidate_commit: plan.candidate_commit,
  candidate_tree: plan.candidate_tree, input_binding_sha256: plan.input_binding_sha256, plan_sha256: plan.plan_sha256,
  reviewer_settings_sha256: bindingHash(plan.reviewer_settings),
  cross_area_assessment: "Traced construction, consumers, publication and recovery edges", response: response(cohort.required_paths)}; }

test("parallel plan bounds each payload and preserves exact candidate and mandatory cross-cutting scope", () => {
  const e = evidence();e.review_context.last_assessed_bindings = "private repeated history".repeat(100000);
  const plan = cohortPlan({candidate, inputs, context: e.review_context});
  assert.equal(plan.cohorts.length, 3);
  assert.deepEqual(plan.cohorts.flatMap((item) => item.required_paths).sort(), [...names].sort());
  for (const cohort of plan.cohorts) {
    const payload = partitionPayload(plan, cohort, e);
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= payloadLimit);
    assert.equal(payload.cohort.candidate_commit, candidate.commit);
    assert.equal(payload.review_context.last_assessed_bindings, undefined);
  }
});

test("cohort navigation keeps actual prior-attempt and cumulative pending deltas distinct", () => {
  const e = evidence(); e.review_context.changed_since_previous = [names[1]]; e.review_context.pending_changed_paths = [...names];
  const plan = cohortPlan({candidate, inputs, context: e.review_context});
  for (const cohort of plan.cohorts) {
    const payload = partitionPayload(plan, cohort, e), assigned = new Set(cohort.required_paths);
    assert.deepEqual(payload.review_context.changed_since_previous, e.review_context.changed_since_previous.filter(name => assigned.has(name)));
    assert.deepEqual(payload.review_context.pending_changed_paths, cohort.required_paths);
  }
  e.review_context.changed_since_previous = [];
  const interrupted = partitionPayload(plan, plan.cohorts[1], e);
  assert.deepEqual(interrupted.review_context.changed_since_previous, []);
  assert.deepEqual(interrupted.review_context.pending_changed_paths, [names[1]]);
});

test("bounded payload retains authority and protected-effect identities without copying full custody or receipts", () => {
  const e = evidence();
  e.inputs = {...inputs, authorities: Array.from({length: 76}, (_, index) => ({path: `Vault/docs/authority-${index}.md`, sha256: String(index).padStart(64, "0"), custody: {entries: "Detailed native custody".repeat(500)}}))};
  e.deployment_history.history = [{commit: candidate.commit, tree: candidate.tree, reviewedCommit: candidate.commit,
    filename: "native-original-receipt.json", receipt: {receipt_sha256: "a".repeat(64),
      protected_deployment_effects: [{id: "KNOWN-EFFECT", category: "PERMISSION_AUTHORITY", description: "Retained exact permission effect", affected_paths: ["src/service.mjs"], authority: null}],
      deployment_effect_dispositions: [], api_version_assessment: response([]).api_version_assessment,
      authentication_impact: true, input_binding: "Detailed historical receipt".repeat(30000)}}];
  const plan = cohortPlan({candidate, inputs: e.inputs, context: e.review_context});
  const payload = partitionPayload(plan, plan.cohorts[0], e);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < payloadLimit);
  assert.equal(payload.inputs.authority_manifest_sha256, bindingHash(e.inputs.authorities));
  assert.equal(payload.inputs.authorities.length, 76); assert.equal(payload.inputs.authorities[0].custody, undefined);
  assert.equal(payload.inherited_effects[0].receipt.protected_deployment_effects[0].id, "KNOWN-EFFECT");
  assert.equal(payload.inherited_effects[0].receipt.authentication_impact, true);
  assert.equal(payload.inherited_effects[0].original_reference.pointer, "/deployment_history/history/0");
  assert.equal(payload.inherited_effects[0].receipt.input_binding, undefined);
});

test("retained ERROR findings use exact on-demand indexes rather than repeated unbounded historical text", () => {
  const e = evidence();
  const finding = {id: "RETAINED", code: "RETAINED_DEFECT", severity: "high", path: "src/service.mjs", origin: "missed",
    required_behavior: "Preserve the exact required behavior. ".repeat(1000), reproduction: "Detailed original reproduction. ".repeat(1000),
    affected_paths: ["src/service.mjs"], acceptance_checks: ["Detailed original acceptance. ".repeat(1000)], missed_finding_reason: "Original missed-review explanation"};
  e.review_context.prior_findings = [finding];
  e.review_context.finding_history = [{...finding, last_status: "OPEN", last_round: 3}];
  e.review_context.observed_assessments = [1, 2, 3].map((round) => ({round, findings: [finding], response_evidence: {value: `@original-${round}.json`, sha256: String(round).repeat(64)}}));
  const plan = cohortPlan({candidate, inputs, context: e.review_context}), payload = partitionPayload(plan, plan.cohorts[0], e);
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < payloadLimit);
  assert.equal(payload.review_context.observed_assessments.length, 3);
  assert.equal(payload.review_context.prior_findings[0].original_sha256, bindingHash(finding));
  assert.equal(payload.review_context.observed_assessments[2].findings[0].original_reference.pointer, "/review_context/observed_assessments/2/findings/0");
  assert.equal(payload.review_context.finding_history[0].last_status, "OPEN");
  assert.match(payload.reading_contract, /before current applicability\/disposition/);
  assert.equal(e.review_context.prior_findings[0].required_behavior, finding.required_behavior);
});

function largeRetainedEvidence() {
  const e = evidence();
  e.inputs = {...inputs, authorities: Array.from({length: 76}, (_, index) => ({path: `Vault/docs/authority-${index}.md`, sha256: String(index).padStart(64, "0")}))};
  const finding = {id: "RETAINED", code: "RETAINED_DEFECT", severity: "high", path: "src/service.mjs", origin: "missed",
    required_behavior: 'Preserve the exact \\"quoted\\" behavior. '.repeat(1000), reproduction: "Original producer and consumer reproduction. ".repeat(1000)};
  e.review_context.observed_assessments = Array.from({length: 100}, (_, round) => ({round, execution_status: "ERROR",
    reported_review_status: "COMPLETE", reported_verdict: "REJECTED", custody_intact: true, coverage: [], findings: [{...finding,
      required_behavior: round === 99 ? "A distinct retained version remains independently actionable" : finding.required_behavior}],
    response_evidence: {value: `@original-${round}.json`, sha256: String(round).padStart(64, "0"), custody: {entries: "Original exact custody".repeat(1000)}}}));
  return e;
}

test("large retained history projects every finding version into exact immutable navigation with zero raw eligibility", () => {
  const e = largeRetainedEvidence(), original = JSON.stringify(e);
  const plan = cohortPlan({candidate, inputs: e.inputs, context: e.review_context});
  const payload = partitionPayload(plan, plan.cohorts[0], e);
  assert.ok(Buffer.byteLength(`${JSON.stringify(payload, null, 2)}\n`) <= payloadLimit);
  assert.deepEqual(payload.cohort.required_paths, ["AGENTS.md"]);
  assert.deepEqual(payload.inputs.authorities.map(item => [item.path, item.sha256]), e.inputs.authorities.map(item => [item.path, item.sha256]));
  assert.deepEqual(payload.review_context.eligible_coverage, []);
  assert.deepEqual(payload.review_context.eligible_validations, []);
  const manifest = payload.retained_collections.observed_assessments;
  assert.equal(manifest.original_sha256, bindingHash(e.review_context.observed_assessments));
  assert.equal(manifest.original_reference.pointer, "/review_context/observed_assessments");
  assert.equal(manifest.count, 100); assert.equal(manifest.grants_eligible_coverage, false); assert.equal(manifest.grants_approval, false);
  assert.equal(payload.review_context.observed_finding_index.length, 1);
  const identity = payload.review_context.observed_finding_index[0];
  assert.equal(identity.id, "RETAINED"); assert.equal(identity.occurrence_count, 100); assert.equal(identity.original_versions.length, 2);
  for (const version of identity.original_versions) {
    const resolved = version.original_reference.pointer.split("/").slice(1).reduce((value, key) => value[key], e);
    assert.equal(bindingHash(resolved), version.original_sha256);
  }
  assert.equal(JSON.stringify(e), original, "Original statuses, source criteria, custody and evidence remain unchanged");
  const impossible = structuredClone(e); impossible.review_context.required_paths = Array.from({length: 5000}, (_, i) => `AGENTS.md/${i}`);
  const tooLarge = cohortPlan({candidate, inputs: impossible.inputs, context: impossible.review_context});
  assert.throws(() => partitionPayload(tooLarge, tooLarge.cohorts[1], impossible), /exceeds its bound/);
});

test("aggregate rejects missing, duplicate, mixed-candidate and uncovered cohorts", () => {
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  const all = plan.cohorts.map((cohort) => ({id: cohort.id, envelope: envelope(plan, cohort)}));
  assert.equal(aggregateCohorts(plan, all).response.verdict, "APPROVED");
  for (const change of [() => all.slice(0, 2), () => [...all, all[0]], () => all.map((item, i) => i ? item : {...item, envelope: {...item.envelope, candidate_tree: "wrong"}}),
    () => all.map((item, i) => i ? item : {...item, envelope: {...item.envelope, response: response([])}})]) {
    const result = aggregateCohorts(plan, change());
    assert.equal(result.response.review_status, "INCOMPLETE");assert.equal(result.response.verdict, null);
  }
});

test("concurrent findings are consolidated and incompatible finding resolutions prevent approval", () => {
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  const all = plan.cohorts.map((cohort) => ({id: cohort.id, envelope: envelope(plan, cohort)}));
  all[1].envelope.response.findings = [{id: "F-cross-area", severity: "high", required_behavior: "Repair consumer recovery"}];
  all[1].envelope.response.verdict = "REJECTED";
  assert.equal(aggregateCohorts(plan, all).response.verdict, "REJECTED");
  all[2].envelope.response.resolutions = [{id: "F-cross-area", status: "RESOLVED", evidence: "Different conclusion"}];
  assert.equal(aggregateCohorts(plan, all).response.verdict, null);
});

test("an OPEN disposition and its stable current finding reach native assessment and repair synthesis", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mycrm-parallel-open-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const options = {directory, candidate: {...candidate, files: names}, inputs: {...inputs, tool_sha256: "synthetic-tool", proposal_sha256: "synthetic-proposal", validation: []},
    files: Object.fromEntries(names.map((name) => [name, "same-content"])), environment: "synthetic"};
  const finding = {id: "OPEN-FINDING", code: "OPEN-FINDING", severity: "high", path: names[1], message: "Synthetic open repair",
    reproduction: "Invoke synthetic consumer", required_behavior: "Preserve failure recovery", affected_paths: [names[1]],
    acceptance_checks: ["Exercise recovery"], origin: "initial", missed_finding_reason: null};
  const initial = await prepareSeries(options), first = {...response(names), verdict: "REJECTED", findings: [finding]};
  await saveRound(initial, first, assessRound(initial, first, []));
  const current = await prepareSeries(options), plan = cohortPlan({candidate, inputs, context: current.public});
  const all = plan.cohorts.map((cohort) => ({id: cohort.id, envelope: envelope(plan, cohort)}));
  all[0].envelope.response.resolutions = [{id: finding.id, status: "OPEN", evidence: "Current independent inspection confirms the remaining defect"}];
  all[1].envelope.response.findings = [finding]; all[1].envelope.response.verdict = "REJECTED";
  all[2].envelope.response.findings = [{...finding, message: "Independent consumer finding", reproduction: "A second current reproduction",
    required_behavior: "Preserve the independently traced consumer recovery", acceptance_checks: ["Second consumer acceptance"]}];
  all[2].envelope.response.verdict = "REJECTED";
  all[2].envelope.response.resolutions = [{id: finding.id, status: "OPEN", evidence: "Separate current reproduction confirms the same stable open defect"}];
  const originals = JSON.stringify(all);
  const merged = aggregateCohorts(plan, all);
  assert.deepEqual(merged.issues, []); assert.equal(merged.response.review_status, "COMPLETE"); assert.equal(merged.response.verdict, "REJECTED");
  assert.match(merged.response.findings[0].reproduction, /Invoke synthetic consumer[\s\S]*second current reproduction/);
  assert.match(merged.response.resolutions[0].evidence, /Current independent[\s\S]*Separate current/);
  assert.equal(JSON.stringify(all), originals, "Every original independent observation remains unchanged");
  const saved = await saveRound(current, merged.response, assessRound(current, merged.response, []));
  assert.equal(saved.rounds.at(-1).findings[0].id, finding.id);
  const again = await prepareSeries(options);
  const synthesized = await saveRound(again, merged.response, assessRound(again, merged.response, []));
  assert.ok(synthesized.rounds.at(-1).repair_plan, "Two failed repair rounds retain native consolidated repair synthesis");
});

test("finding identity contradictions, disposition conflicts and local duplicates remain fatal", () => {
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  for (const change of ["code", "path", "origin", "disposition", "duplicate"]) {
    const all = plan.cohorts.map(cohort => ({id:cohort.id,envelope:envelope(plan,cohort)}));
    const finding={id:"STABLE",code:"STABLE_CODE",path:"src/service.mjs",origin:"repair",severity:"high"};
    all[0].envelope.response.findings=[finding];all[0].envelope.response.verdict="REJECTED";
    all[1].envelope.response.findings=[{...finding}];all[1].envelope.response.verdict="REJECTED";
    if(["code","path","origin"].includes(change)) all[1].envelope.response.findings[0][change]="contradictory";
    if(change==="disposition") {all[0].envelope.response.resolutions=[{id:finding.id,status:"OPEN",evidence:"Open"}];all[1].envelope.response.resolutions=[{id:finding.id,status:"RESOLVED",evidence:"Contradiction"}];}
    if(change==="duplicate") all[1].envelope.response.findings.push({...finding});
    assert.equal(aggregateCohorts(plan,all).response.verdict,null,change);
  }
});

test("compatible finding consolidation preserves the strongest schema severity in either order", () => {
  const ranking = ["critical", "high", "medium", "low"];
  assert.deepEqual([...seriesFindingSchema.items.properties.severity.enum].sort(), [...ranking].sort());
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  for (const first of ranking) for (const second of ranking) {
    const all = plan.cohorts.map(cohort => ({id:cohort.id,envelope:envelope(plan,cohort)}));
    for (const [index,severity] of [[0,first],[1,second]]) {
      all[index].envelope.response.findings = [{id:"SAME",code:"SAME_CODE",path:"src/service.mjs",origin:"repair",severity,message:`Independent ${index}`}];
      all[index].envelope.response.verdict = "REJECTED";
    }
    const original = JSON.stringify(all), result = aggregateCohorts(plan,all);
    assert.deepEqual(result.issues, []); assert.equal(result.response.verdict,"REJECTED");
    assert.equal(result.response.findings[0].severity, ranking[Math.min(ranking.indexOf(first),ranking.indexOf(second))]);
    assert.equal(JSON.stringify(all),original);
  }
});

test("effective inherited effects retain independent deployment permission status", () => {
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  const all = plan.cohorts.map((cohort) => ({id: cohort.id, envelope: envelope(plan, cohort)}));
  const cross = all[0].envelope.response;
  cross.deployment_effect_dispositions = [{receipt_sha256: "a".repeat(64), effect_id: "INHERITED", disposition: "EFFECTIVE", evidence: "Verified current consumer retains exact effect"}];
  cross.owner_approval_status = "MISSING";
  assert.equal(aggregateCohorts(plan, all).response.verdict, "APPROVED");
  assert.equal(aggregateCohorts(plan, all).response.owner_approval_status, "MISSING");
  cross.owner_approval_status = "APPROVED";
  assert.equal(aggregateCohorts(plan, all).response.owner_approval_status, "APPROVED");
  for (const disposition of ["REVERTED", "SUPERSEDED"]) {
    cross.deployment_effect_dispositions[0].disposition = disposition;
    assert.equal(aggregateCohorts(plan, all).response.owner_approval_status, "NOT_REQUIRED");
  }
});

async function runFixture(invoke, after, retained = evidence()) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-parallel-"));
  try { return await withOracleRun(path.join(root, "oracle"), async ({run}) => {
    let entered = 0, active = 0, peak = 0, release;
    const barrier = new Promise((resolve) => { release = resolve; });
    await atomicJson(path.join(run, "evidence.json"), retained, {exclusive: true});
    const result = await runParallelReview({run, candidate, inputs: retained.inputs, evidence: retained, schema: {type: "object"}, sharedPrompt: "Trusted governing-first fixture",
      diffForPaths: async (paths) => paths.map((name) => `changed ${name}\n`).join(""),
      sourceForPath: async (name, revision) => ({state: "PRESENT", text: `// ${name}\nexport function synthetic(){ return ${revision === candidate.tree}; }\n`, git_blob: "synthetic-body", locator: {revision, path: name}}),
      invoke: async (area) => {
        active++;peak = Math.max(peak, active);if (++entered === 3) release();
        await barrier;await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          const payload = JSON.parse(await readFile(path.join(area.directory, "evidence.json"), "utf8"));
          const binding = payload.cohort;
          const value = {cohort_id: binding.id, candidate_commit: binding.candidate_commit, candidate_tree: binding.candidate_tree,
            input_binding_sha256: binding.input_binding_sha256, plan_sha256: binding.plan_sha256,
            reviewer_settings_sha256: binding.reviewer_settings_sha256,
            cross_area_assessment: "Entrypoint/consumer/dependency/publication/recovery trace", response: response(binding.required_paths)};
          await invoke?.(area, value);
          await writeFile(area.output, JSON.stringify(value));
        } finally { active--; }
      }});
    const outcomes = JSON.parse(await readFile(path.join(run, "cohort-outcomes.json"), "utf8"));
    await after?.({root, run, result});
    return {result: result.response, outcomes, peak};
  }, {ownerRoot: root}); } finally { await rm(root, {recursive: true, force: true}); }
}

test("native dispatch starts all three independent assessments before any finishes", {timeout: 5000}, async () => {
  const {result, peak, outcomes} = await runFixture();
  assert.equal(peak, 3);assert.equal(outcomes.actual_overlap, true);assert.equal(outcomes.outcomes.length, 3);
  assert.equal(result.verdict, "APPROVED");
});

test("native dispatch bounds final serialized wrappers and seals projected originals through receipt admission", {timeout: 10000}, async () => {
  await runFixture(null, async ({root, run, result}) => {
    await verifyParallelArtifacts(result.reference, {root});
    for (const id of ["cross-cutting", "implementation-consumers", "verification-recovery"]) {
      const raw = await readFile(path.join(run, "cohorts", id, "evidence.json"));
      assert.ok(raw.byteLength <= payloadLimit, `${id}: complete actual serialized payload`);
      const parsed = JSON.parse(raw);
      assert.ok(parsed.source_packet.path); assert.equal(parsed.changes_reference, "changes.json");
      assert.equal(parsed.full_evidence_sha256.length, 64);
    }
    const original = path.join(run, "evidence.json"), bytes = await readFile(original);
    await writeFile(original, "tampered original");
    await assert.rejects(verifyParallelArtifacts(result.reference, {root}), /evidence changed/);
    await writeFile(original, bytes);
    await chmod(original, 0o640);
    await assert.rejects(verifyParallelArtifacts(result.reference, {root}), /evidence changed/);
    await chmod(original, 0o600);
    await verifyParallelArtifacts(result.reference, {root});
    await rm(original);
    await assert.rejects(verifyParallelArtifacts(result.reference, {root}), /ENOENT|missing/);
  }, largeRetainedEvidence());
});

test("original navigation corruption during native assessment retains ERROR and prevents approval", {timeout: 5000}, async () => {
  await assert.rejects(runFixture(async area => {
    if (area.directory.endsWith("cross-cutting")) await writeFile(path.resolve(area.directory, "../../evidence.json"), "changed original");
  }), /evidence changed/);
});

test("child crash or changed cohort inputs preserves partial assessment and prevents approval", {timeout: 5000}, async () => {
  await assert.rejects(runFixture((area) => { if (area.directory.endsWith("implementation-consumers")) throw new Error("Synthetic transport failure"); }), /execution failed/);
  await assert.rejects(runFixture(async (area) => { if (area.directory.endsWith("verification-recovery")) await writeFile(path.join(area.directory, "evidence.json"), "changed"); }), /inputs changed/);
});

test("native parallel admission preserves a cross-cutting protected effect with unaffected specialist defaults", () => {
  const plan = cohortPlan({candidate, inputs, context: evidence().review_context});
  const all = plan.cohorts.map((cohort) => ({id: cohort.id, envelope: envelope(plan, cohort)}));
  all[0].envelope.response.authentication_impact = true;
  all[0].envelope.response.owner_approval_status = "MISSING";
  all[0].envelope.response.protected_deployment_effects = [{id: "F-trust", category: "CREDENTIAL_TRUST", description: "Actual trust effect", affected_paths: ["src/service.mjs"], authority: null}];
  const result = aggregateCohorts(plan, all);
  assert.equal(result.response.verdict, "APPROVED");assert.equal(result.response.owner_approval_status, "MISSING");
  all[1].envelope.response.api_version_assessment = {...all[1].envelope.response.api_version_assessment, impact: "CHANGE"};
  assert.equal(aggregateCohorts(plan, all).response.verdict, null);
});

test("receipt artifact custody detects a changed original cohort outcome", async () => {
  await runFixture(null, async ({root, run, result}) => {
    await verifyParallelArtifacts(result.reference, {root});
    await writeFile(path.join(run, "cohorts/cross-cutting/outcome.json"), "changed original outcome");
    await assert.rejects(verifyParallelArtifacts(result.reference, {root}), /evidence changed/);
  });
});

test("receipt custody includes every native source packet page and manifest", async () => {
  await runFixture(null, async ({root, run, result}) => {
    const evidence = JSON.parse(await readFile(path.join(run, "cohorts/implementation-consumers/evidence.json"), "utf8"));
    const manifest = JSON.parse(await readFile(evidence.source_packet.path, "utf8"));
    assert.deepEqual(manifest.required_paths, ["src/service.mjs"]);
    const current = manifest.items[0].versions.find(version => version.revision === candidate.tree);
    assert.match(await readFile(current.pages[0].path, "utf8"), /export function synthetic/);
    await writeFile(current.pages[0].path, "altered original source body");
    await assert.rejects(verifyParallelArtifacts(result.reference, {root}), /evidence changed/);
  });
});

test("exclusive atomic cohort publication preserves the first immutable result on collision", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-cohort-collision-"));
  try {
    const file = path.join(root, "result.json");
    await atomicJson(file, {result: "first"}, {root, exclusive: true});
    await assert.rejects(atomicJson(file, {result: "second"}, {root, exclusive: true}), {code: "EEXIST"});
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {result: "first"});
  } finally { await rm(root, {recursive: true, force: true}); }
});
