import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {cohortPlan, partitionPayload, aggregateCohorts, runParallelReview, payloadLimit} from "../scripts/oracle-parallel.mjs";
import {atomicJson, withOracleRun} from "../scripts/oracle-inputs.mjs";

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

async function runFixture(invoke) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-parallel-"));
  try { return await withOracleRun(path.join(root, "oracle"), async ({run}) => {
    let entered = 0, active = 0, peak = 0, release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const result = await runParallelReview({run, candidate, inputs, evidence: evidence(), schema: {type: "object"}, sharedPrompt: "Trusted governing-first fixture",
      diffForPaths: async (paths) => paths.map((name) => `changed ${name}\n`).join(""),
      invoke: async (area) => {
        active++;peak = Math.max(peak, active);if (++entered === 3) release();
        await barrier;await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          const payload = JSON.parse(await readFile(path.join(area.directory, "evidence.json"), "utf8"));
          const binding = payload.cohort;
          const value = {cohort_id: binding.id, candidate_commit: binding.candidate_commit, candidate_tree: binding.candidate_tree,
            input_binding_sha256: binding.input_binding_sha256, plan_sha256: binding.plan_sha256,
            cross_area_assessment: "Entrypoint/consumer/dependency/publication/recovery trace", response: response(binding.required_paths)};
          await invoke?.(area, value);
          await writeFile(area.output, JSON.stringify(value));
        } finally { active--; }
      }});
    const outcomes = JSON.parse(await readFile(path.join(run, "cohort-outcomes.json"), "utf8"));
    return {result, outcomes, peak};
  }, {ownerRoot: root}); } finally { await rm(root, {recursive: true, force: true}); }
}

test("native dispatch starts all three independent assessments before any finishes", async () => {
  const {result, peak, outcomes} = await runFixture();
  assert.equal(peak, 3);assert.equal(outcomes.actual_overlap, true);assert.equal(outcomes.outcomes.length, 3);
  assert.equal(result.verdict, "APPROVED");
});

test("child crash or changed cohort inputs preserves partial assessment and prevents approval", async () => {
  await assert.rejects(runFixture((area) => { if (area.directory.endsWith("implementation-consumers")) throw new Error("Synthetic transport failure"); }), /execution failed/);
  await assert.rejects(runFixture(async (area) => { if (area.directory.endsWith("verification-recovery")) await writeFile(path.join(area.directory, "evidence.json"), "changed"); }), /inputs changed/);
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
