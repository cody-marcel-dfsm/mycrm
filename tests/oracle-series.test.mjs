import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {prepareSeries, reviewSnapshot, assessRound, saveRound, verifySeries, inheritObservedEvidence} from "../scripts/oracle-series.mjs";
import {contentHash} from "../scripts/oracle-inputs.mjs";
import {cohortPlan, aggregateCohorts} from "../scripts/oracle-parallel.mjs";
import {bindingHash} from "../scripts/oracle-inputs.mjs";
import {environmentHash, fullEnvironmentHash, executionEnvironment} from "../scripts/oracle-validation.mjs";

const coverage = (name, dependencies = [name]) => ({path: name, dependencies, dependency_rationale: "Synthetic complete dependency closure.", assessment: "Synthetic behavior and failure paths checked.", criteria: ["Synthetic acceptance and failure criteria."], evidence: ["Synthetic source inspection."], finding_ids: []});
const finding = (id = "F-1", extra = {}) => ({id, severity: "high", code: id, message: "Synthetic defect.", path: "a.mjs", reproduction: "Invoke the synthetic failing input.", required_behavior: "Return the expected synthetic output.", affected_paths: ["a.mjs"], acceptance_checks: ["Exercise the synthetic failure."], origin: "initial", missed_finding_reason: null, ...extra});
const response = (extra = {}) => ({review_status: "COMPLETE", verdict: "APPROVED", coverage: [coverage("a.mjs"), coverage("b.mjs")], reused_coverage: [], validations: [], reused_validations: [], findings: [], resolutions: [], unreviewed: [], scope_dispositions: [], synthesis: null, ...extra});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "my-crm-review-series-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const inputs = {authorities: [{path: "AGENTS.md", sha256: "authority-a"}, {path: "Vault/docs/design.md", sha256: "design-a"}, {path: "Vault/docs/status.md", sha256: "status-a"}], tool_sha256: "tool-a", owner: null, proposal_sha256: "proposal-a", validation: [{kind: "file", value: "@check.log", sha256: "evidence-a"}]};
  const options = {directory, candidate: {base: "base-a", tree: "tree-a", files: ["a.mjs", "b.mjs"]}, inputs, files: {"a.mjs": "a1", "b.mjs": "b1", "test.mjs": "test1", "config.json": "config1"}, environment: "environment-a"};
  const before = reviewSnapshot(options);
  const nativeProofs = [{evidence: "@check.log", eligible: true, record: {record_sha256: "native-proof-a", command: ["node", "--test", "test.mjs"], before, after: before}}];
  options.validationProofs = [];
  const prepare = (changes = {}) => prepareSeries({...options, ...changes});
  const record = async (context, value) => saveRound(context, value, assessRound(context, value, options.inputs.validation));
  return {directory, options, inputs, nativeProofs, prepare, record};
}

test("new-chat bookkeeping preserves source observations and full original environment provenance stays distinct", async t => {
  const {prepare, record} = await fixture(t);
  const first = {PATH: "/synthetic/bin", CODEX_THREAD_ID: "synthetic-first", SHLVL: "1"};
  const next = {...first, CODEX_THREAD_ID: "synthetic-next", SHLVL: "8"};
  assert.notEqual(fullEnvironmentHash(first), fullEnvironmentHash(next)); assert.equal(environmentHash(first), environmentHash(next));
  const functional = {_: "synthetic-execution-context", npm_lifecycle_event: "synthetic-functional-event"};
  assert.deepEqual(executionEnvironment(functional, Object.keys(functional)), functional);
  assert.notEqual(environmentHash(functional, ["_"]), environmentHash({...functional, _: "synthetic-new-context"}, ["_"]));
  await record(await prepare({environment: environmentHash(first), environmentProvenance: fullEnvironmentHash(first)}), response());
  const repeated = await prepare({environment: environmentHash(next), environmentProvenance: fullEnvironmentHash(next)});
  assert.deepEqual(repeated.public.eligible_coverage.map(item => item.path), ["a.mjs", "b.mjs"]);
  assert.equal(repeated.series.rounds[0].snapshot.environment_provenance_sha256, fullEnvironmentHash(first));
  const configured = await prepare({environment: environmentHash({...next, NODE_OPTIONS: "--conditions=synthetic-functional"})});
  assert.equal(configured.public.eligible_coverage.length, 0); assert.match(configured.public.invalidated[0].reason, /environment/);
});

test("three saved rounds retain a command-specific functional environment independently of reviewer dispatch", async t => {
  const {prepare, record, options, nativeProofs} = await fixture(t);
  const before = reviewSnapshot(options), functionalEnvironment = "explicit-command-environment";
  nativeProofs[0].record.before = {...before, scope: "declared-inputs-v2", tree: null, context: {environment: functionalEnvironment}};
  nativeProofs[0].record.after = nativeProofs[0].record.before;
  nativeProofs[0].current_provenance = {environment: functionalEnvironment};
  options.validationProofs = nativeProofs;
  let originalWitness;
  for (let round = 0; round < 3; round++) {
    const prepared = await prepare();
    assert.equal(prepared.public.invalidated.some(item => item.kind === "validation"), false);
    const prior = prepared.public.eligible_validations;
    if (round) assert.equal(prior.length, 1);
    const saved = await record(prepared, response());
    const observation = saved.rounds.at(-1).validations[0];
    assert.equal(observation.execution_environment_sha256, functionalEnvironment);
    originalWitness ??= observation.input_sha256;
    assert.equal(observation.input_sha256, originalWitness);
  }
  nativeProofs[0].current_provenance = {environment: "changed-functional-command-input"};
  const changed = await prepare();
  assert.equal(changed.public.eligible_validations.length, 0);
  assert.match(changed.public.invalidated.find(item => item.kind === "validation").reason, /command environment changed/);
  assert.equal(nativeProofs[0].record.before.context.environment, functionalEnvironment);
});

test("reviewer proof navigation preserves sealed hashes while native admission retains the complete original", async t => {
  const {prepare, options, nativeProofs} = await fixture(t);
  nativeProofs[0].record.before.file_metadata = {"synthetic-retained-native-custody": "x".repeat(1024 * 1024)};
  nativeProofs[0].current_provenance = {environment: options.environment, current_snapshot: "y".repeat(1024 * 1024)};
  options.validationProofs = nativeProofs;
  const prepared = await prepare(), view = prepared.public.validation_proofs[0];
  assert.equal(view.original_inputs_sha256, bindingHash(nativeProofs[0].record.before));
  assert.equal(view.record_sha256, nativeProofs[0].record.record_sha256);
  assert.equal(view.original_record.sha256, "evidence-a");
  assert.equal(view.record, undefined);
  assert.equal(view.current_provenance, undefined);
  assert.equal(view.current_provenance_sha256, bindingHash(nativeProofs[0].current_provenance));
  assert.ok(Buffer.byteLength(JSON.stringify(prepared.public.validation_proofs)) < 4096);
  assert.equal(prepared.validationProofs[0].record, nativeProofs[0].record);
  const validation = {id: "native-original", evidence: "@check.log", command: JSON.stringify(nativeProofs[0].record.command), dependencies: ["a.mjs", "test.mjs", "config.json"], dependency_rationale: "Complete original source/configuration closure remains native.", assessment: "Retained original execution verified."};
  assert.doesNotThrow(() => assessRound(prepared, response({validations: [validation]}), options.inputs.validation));
  nativeProofs[0].eligible = false;
  assert.equal(view.eligible, true, "The wire index remains an observation, never admission authority");
  assert.throws(() => assessRound(prepared, response({validations: [validation]}), options.inputs.validation), /original launcher-recorded/);
});

test("complete first scan consolidates findings and repair review carries only verified unaffected coverage", async (t) => {
  const {prepare, record, options} = await fixture(t);
  const initial = await prepare();
  assert.equal(initial.public.mode, "initial");
  await record(initial, response({verdict: "REJECTED", findings: [finding(), finding("F-2", {path: "b.mjs", affected_paths: ["b.mjs"]})]}));
  const repaired = await prepare({candidate: {...options.candidate, tree: "tree-b"}, files: {...options.files, "a.mjs": "a2"}});
  assert.deepEqual(repaired.public.changed_since_previous, ["a.mjs"]);
  assert.deepEqual(repaired.public.eligible_coverage.map((item) => item.path), ["b.mjs"]);
  assert.match(repaired.public.invalidated[0].reason, /dependency changed/);
  const approved = response({coverage: [coverage("a.mjs")], reused_coverage: ["b.mjs"], resolutions: ["F-1", "F-2"].map((id) => ({id, status: "RESOLVED", evidence: "Synthetic regression passed and behavior inspected."}))});
  const series = await record(repaired, approved);
  assert.equal(series.rounds.at(-1).coverage.length, 2);
  assert.equal(series.rounds.at(-1).verdict, "APPROVED");
  const next = await prepare({candidate: {...options.candidate, tree: "tree-b"}, files: {...options.files, "a.mjs": "a2"}});
  assert.equal(next.public.finding_history.length, 2);
  assert.ok(next.public.finding_history.every((item) => item.last_status === "RESOLVED"));
  assert.throws(() => assessRound(repaired, {...approved, resolutions: []}, []), /resolution evidence/);
  assert.throws(() => assessRound(repaired, {...approved, coverage: [], reused_coverage: ["a.mjs", "b.mjs"]}, []), /reused coverage is invalid/);
});

test("explicit reviewed source is canonically bound through save and reuse without weakening dependency admission", async t => {
  const {prepare, record, options} = await fixture(t);
  const context = await prepare(), raw = response({coverage: [coverage("a.mjs", ["config.json"]), coverage("b.mjs")]});
  const original = JSON.stringify(raw), assessed = assessRound(context, raw, []);
  assert.deepEqual(assessed.coverage[0].dependencies, ["a.mjs", "config.json"]);
  assert.equal(JSON.stringify(raw), original, "Independent raw output remains immutable");
  const saved = await saveRound(context, raw, assessed);
  assert.doesNotThrow(() => verifySeries(saved, options.candidate.base));
  assert.deepEqual(saved.rounds[0].response.coverage[0].dependencies, ["config.json"]);
  const reusable = await prepare(); assert.ok(reusable.public.eligible_coverage.some(item => item.path === "a.mjs"));
  for (const changed of [{files: {...options.files, "a.mjs": "changed-self"}},
    {fileFacts: {"a.mjs": {mode: "100755", type: "blob", custody: {synthetic: "changed"}}}},
    {files: {...options.files, "config.json": "changed-dependency"}}]) {
    const next = await prepare(changed);
    assert.ok(!next.public.eligible_coverage.some(item => item.path === "a.mjs"));
  }
  for (const bad of [{dependencies: []}, {dependencies: ["config.json", "config.json"]}, {dependencies: ["../escape"]},
    {dependencies: ["unknown.mjs"]}, {dependencies: ["/outside.mjs"]}, {dependency_rationale: " "},
    {path: "unknown.mjs"}, {criteria: []}, {evidence: []}, {finding_ids: ["unknown"]}]) {
    const invalid = structuredClone(raw); Object.assign(invalid.coverage[0], bad);
    assert.throws(() => assessRound(context, invalid, []), /dependency|candidate|requires|unknown/);
  }
  const navigation = reusable.public.navigation_coverage.find(item => item.path === "a.mjs");
  assert.equal(navigation.assessment, raw.coverage[0].assessment);
  assert.equal(navigation.dependency_rationale, raw.coverage[0].dependency_rationale);
  assert.deepEqual(navigation.criteria, raw.coverage[0].criteria);
  assert.ok(navigation.dependency_comparisons.every(item => item.equal));
  assert.equal(navigation.coverage_eligibility, "NONE");
});

test("raw moved-input assessments retain custody and findings without promoting coverage or approval", async (t) => {
  const {prepare, options, inputs, record, directory} = await fixture(t);
  const initial = await prepare(), raw = response({verdict: "REJECTED", findings: [finding()]});
  const assessed = assessRound(initial, raw, inputs.validation);
  const run = path.join(directory, "runs", "observed"); await mkdir(run, {recursive: true});
  const filename = path.join(run, "response.json"), bytes = JSON.stringify(raw);
  await writeFile(filename, bytes);
  const reference = {value: `@${filename}`, sha256: contentHash(bytes)};
  const saved = await saveRound(initial, null, null, {error: {message: "Inputs moved after assessment."}, observed: {response: raw, assessed, response_evidence: reference}});
  const error = saved.rounds.at(-1);
  assert.equal(error.execution_status, "ERROR"); assert.equal(error.review_status, "INCOMPLETE"); assert.equal(error.verdict, null);
  assert.equal(error.coverage.length, 0); assert.equal(error.findings.length, 0);
  assert.equal(error.observed_assessment.response.verdict, "REJECTED"); assert.equal(error.observed_assessment.findings[0].id, "F-1");
  const inherited = await inheritObservedEvidence({directory, base: options.candidate.base});
  assert.deepEqual(inherited.evidence, [reference.value]); assert.deepEqual(inherited.invalidated, []);
  const nextInputs = {...inputs, validation: [...inputs.validation, {...reference, kind: "file"}]};
  const nextOptions = {inputs: nextInputs, files: {...options.files, "a.mjs": "a2", "arrived.mjs": "third-party"}, candidate: {...options.candidate, tree: "tree-arrived", files: [...options.candidate.files, "arrived.mjs"]}};
  const current = await prepare(nextOptions);
  assert.equal(current.public.eligible_coverage.length, 0); assert.equal(current.public.observed_assessments[0].custody_intact, true);
  assert.deepEqual(current.public.observed_assessments[0].coverage.find((item) => item.path === "b.mjs").changed_dependencies, []);
  assert.deepEqual(current.public.observed_assessments[0].coverage.find((item) => item.path === "a.mjs").changed_dependencies, ["a.mjs"]);
  assert.deepEqual(current.public.changed_since_previous, ["a.mjs", "arrived.mjs"]);
  assert.deepEqual(current.public.pending_changed_paths, ["a.mjs", "arrived.mjs", "b.mjs"]);
  assert.equal(current.public.path_dispositions.find((item) => item.path === "arrived.mjs").disposition, "new");
  assert.equal(current.public.path_dispositions.find((item) => item.path === "b.mjs").disposition, "unreviewed");
  const fresh = response({coverage: current.public.required_paths.map((name) => coverage(name)), resolutions: [{id: "F-1", status: "RESOLVED", evidence: "Independent current-source inspection verifies the original reported issue is repaired."}]});
  assert.throws(() => assessRound(current, {...fresh, resolutions: []}, nextInputs.validation), /explicit resolution evidence/);
  await record(current, fresh);
  const later = await prepare(nextOptions);
  assert.doesNotThrow(() => assessRound(later, response({coverage: [], reused_coverage: later.public.required_paths}), nextInputs.validation));
  await writeFile(filename, "changed raw response");
  const changed = await inheritObservedEvidence({directory, base: options.candidate.base});
  assert.deepEqual(changed.evidence, []); assert.match(changed.invalidated[0].reason, /content changed/);
  await rm(filename);
  assert.match((await inheritObservedEvidence({directory, base: options.candidate.base})).invalidated[0].reason, /missing/);
});

test("fresh resolution of known historical findings is idempotent while unknown and duplicate IDs fail closed", async (t) => {
  const {prepare, record, options} = await fixture(t);
  await record(await prepare(), response({verdict: "REJECTED", findings: [finding(), finding("F-2")]}));
  await record(await prepare(), response({verdict: "REJECTED", findings: [finding("F-2")], resolutions: [
    {id: "F-1", status: "RESOLVED", evidence: "Independent first repair verification."},
    {id: "F-2", status: "OPEN", evidence: "Independent remaining finding verification."}
  ]}));
  const current = await prepare();
  assert.deepEqual(current.public.prior_findings.map((item) => item.id), ["F-2"]);
  const resolutions = ["F-1", "F-2"].map((id) => ({id, status: "RESOLVED", evidence: "Fresh exact-candidate repair and historical applicability verification."}));
  assert.doesNotThrow(() => assessRound(current, response({resolutions}), []));
  assert.throws(() => assessRound(current, response({resolutions: [...resolutions, resolutions[0]]}), []), /duplicated or unknown/);
  assert.throws(() => assessRound(current, response({resolutions: [...resolutions, {id: "UNKNOWN", status: "RESOLVED", evidence: "Unbound claim."}]}), []), /duplicated or unknown/);
  assert.throws(() => assessRound(current, response({resolutions: [{...resolutions[0], status: "OPEN"}, resolutions[1]]}), []), /duplicated or unknown/);
  assert.throws(() => assessRound(current, response({resolutions: [{...resolutions[0], evidence: ""}, resolutions[1]]}), []), /duplicated or unknown/);
  assert.throws(() => assessRound(current, response({resolutions: [resolutions[0]]}), []), /explicit resolution evidence/);
  await record(current, response({resolutions}));
  const repeated = await prepare();
  assert.deepEqual(repeated.public.prior_findings, []);
  assert.ok(repeated.public.finding_history.every((item) => item.last_status === "RESOLVED"));
  const regression = await prepare({candidate: {...options.candidate, tree: "tree-regression"}, files: {...options.files, "a.mjs": "a-regression"}});
  await record(regression, response({verdict: "REJECTED", findings: [finding("F-1", {origin: "repair"})]}));
  assert.deepEqual((await prepare()).public.prior_findings.map((item) => item.id), ["F-1"]);
});

test("candidate mode and type changes selectively invalidate consumers and classify membership movement", async (t) => {
  const {prepare, options, record} = await fixture(t);
  const fileFacts = Object.fromEntries(Object.keys(options.files).map((name) => [name, {mode: "100644", type: "blob"}]));
  const original = {fileFacts};
  await record(await prepare(original), response({coverage: [coverage("a.mjs"), coverage("b.mjs", ["b.mjs", "a.mjs"])]}));
  const current = await prepare({fileFacts: {...fileFacts, "a.mjs": {mode: "100755", type: "blob"}}});
  assert.deepEqual(current.public.changed_since_previous, ["a.mjs"]); assert.equal(current.public.eligible_coverage.length, 0);
  assert.equal(current.public.path_dispositions.find((item) => item.path === "a.mjs").disposition, "changed");
  assert.equal(current.public.path_dispositions.find((item) => item.path === "b.mjs").disposition, "dependent");
  assert.ok(current.public.invalidated.every((item) => item.reason.includes("a.mjs")));
  const typed = await prepare({fileFacts: {...fileFacts, "a.mjs": {mode: "120000", type: "blob"}}});
  assert.deepEqual(typed.public.changed_since_previous, ["a.mjs"]);
  const renamed = await prepare({fileFacts, candidate: {...options.candidate, files: ["b.mjs", "renamed.mjs"]}, files: {...options.files, "a.mjs": null, "renamed.mjs": "a1"}});
  assert.deepEqual(renamed.public.changed_since_previous, ["a.mjs", "renamed.mjs"]);
  assert.equal(renamed.public.path_dispositions.find((item) => item.path === "renamed.mjs").disposition, "new");
});

test("fresh coverage records criteria and result evidence and rejects unknown finding identities", async (t) => {
  const {prepare} = await fixture(t), current = await prepare();
  assert.throws(() => assessRound(current, response({coverage: [{...coverage("a.mjs"), criteria: []}, coverage("b.mjs")]}), []), /explicit criteria/);
  assert.throws(() => assessRound(current, response({coverage: [{...coverage("a.mjs"), finding_ids: ["unknown"]}, coverage("b.mjs")]}), []), /unknown finding identity/);
});

test("raw unfinished scope survives movement and supersedes older path coverage until independent assessment", async (t) => {
  const {prepare, record, options} = await fixture(t);
  await record(await prepare(), response());
  const attempted = await prepare();
  const raw = response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("a.mjs")], unreviewed: ["b.mjs", "test.mjs", "final semantic interaction"]});
  await saveRound(attempted, null, null, {error: {message: "Input movement."}, observed: {response: raw, assessed: assessRound(attempted, raw, []), response_evidence: {value: "@missing-response.json", sha256: "synthetic"}}});
  const current = await prepare({files: {...options.files, "config.json": "changed-independent-config"}});
  assert.deepEqual(current.public.unfinished_scope, raw.unreviewed);
  assert.ok(!current.public.eligible_coverage.some((item) => item.path === "b.mjs"));
  assert.ok(current.public.required_paths.includes("test.mjs"));
  const repaired = response({coverage: current.public.required_paths.map((name) => coverage(name))});
  await record(current, repaired);
  assert.deepEqual((await prepare({files: {...options.files, "config.json": "changed-independent-config"}})).public.unfinished_scope, []);
});

test("actual cohort missing-coverage diagnostics resume as semantic scope and concrete source obligations", async t => {
  const {prepare, options, inputs, directory} = await fixture(t), attempted = await prepare();
  const plan = cohortPlan({candidate: {...options.candidate, commit: "1".repeat(40)}, inputs,
    context: {...attempted.public, required_paths: ["a.mjs", "b.mjs", "test.mjs"]}});
  const outcomes = plan.cohorts.map(cohort => ({id: cohort.id, envelope: {
    cohort_id: cohort.id, candidate_commit: plan.candidate_commit, candidate_tree: plan.candidate_tree,
    input_binding_sha256: plan.input_binding_sha256, plan_sha256: plan.plan_sha256,
    reviewer_settings_sha256: bindingHash(plan.reviewer_settings), cross_area_assessment: "Synthetic reducer/series recovery path.",
    response: response({coverage: cohort.required_paths.filter(name => name === "a.mjs").map(name => coverage(name))})}}));
  const raw = aggregateCohorts(plan, outcomes).response;
  const diagnostics = raw.unreviewed.filter(name => name.startsWith("Cohort "));
  assert.ok(diagnostics.some(name => name.includes("omitted required coverage:")));
  assert.ok(raw.unreviewed.includes("b.mjs")); assert.ok(raw.unreviewed.includes("test.mjs"));
  const filename = path.join(directory, "cohort-response.json"), bytes = JSON.stringify(raw); await writeFile(filename, bytes);
  await saveRound(attempted, null, null, {error: {message: "Synthetic interrupted aggregate."},
    observed: {response: raw, assessed: assessRound(attempted, raw, inputs.validation),
      response_evidence: {value: `@${filename}`, sha256: contentHash(bytes)}}});
  const current = await prepare();
  assert.ok(current.public.required_paths.includes("b.mjs")); assert.ok(current.public.required_paths.includes("test.mjs"));
  for (const diagnostic of diagnostics) {
    assert.ok(current.public.unfinished_scope.includes(diagnostic));
    assert.ok(!current.public.required_paths.includes(diagnostic));
    assert.ok(!Object.hasOwn(current.snapshot.files, diagnostic));
  }
});

test("raw finding-only and explicit file scope require fresh absence coverage outside original membership", async (t) => {
  const {prepare, record, options} = await fixture(t);
  for (const kind of ["prior-required", "dependency-only", "outside-finding", "outside-affected", "outside-unreviewed"]) {
    const directory = path.join(options.directory, kind), root = path.join(directory, "source");
    await mkdir(root, {recursive: true});
    const name = kind === "prior-required" ? "a.mjs" : kind === "dependency-only" ? "test.mjs" : "ignored-helper.mjs";
    const attempted = await prepare({directory, root});
    const raw = response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("b.mjs")],
      findings: kind === "outside-unreviewed" ? [] : [finding("OBS-ABSENT", {path: kind === "outside-affected" ? "a.mjs" : name, affected_paths: [name]})], unreviewed: kind === "outside-affected" ? [] : [name]});
    await saveRound(attempted, null, null, {error: {message: "Synthetic movement before adoption."}, observed: {response: raw, assessed: assessRound(attempted, raw, []), response_evidence: {value: "@synthetic.json", sha256: "synthetic"}}});
    const files = {...options.files}; delete files[name];
    const next = {directory, root, files, candidate: {...options.candidate, tree: "renamed-tree", files: kind === "prior-required" ? ["b.mjs", "renamed.mjs"] : options.candidate.files}};
    if (kind === "prior-required") files["renamed.mjs"] = "a1";
    const current = await prepare(next);
    assert.ok(current.public.required_paths.includes(name), kind);
    assert.equal(current.snapshot.files[name], null);
    assert.ok(!current.public.eligible_coverage.some((item) => item.path === name));
    const disposition = current.public.path_dispositions.find((item) => item.path === name);
    assert.deepEqual(disposition.supporting_observations, ["round-1"]);
    assert.equal(disposition.previous.known, !kind.startsWith("outside"));
    const resolutions = raw.findings.map(({id}) => ({id, status: "RESOLVED", evidence: "Independent current absence, rename and caller inspection resolves the observed issue."}));
    const fresh = response({coverage: current.public.required_paths.map((item) => coverage(item)), resolutions});
    assert.throws(() => assessRound(current, {...fresh, coverage: fresh.coverage.filter((item) => item.path !== name)}, []), /lacks coverage/);
    if (resolutions.length) assert.throws(() => assessRound(current, {...fresh, resolutions: []}, []), /resolution evidence/);
    await record(current, fresh);
    const later = await prepare(next);
    assert.equal(later.snapshot.files[name], null);
    assert.doesNotThrow(() => assessRound(later, response({coverage: later.public.required_paths.map((item) => coverage(item))}), []));
  }
});

test("unknown unsafe claims retain stable observations and require independent unavailable-scope disposition", async (t) => {
  const {prepare, record, options} = await fixture(t);
  const root = path.join(options.directory, "source"); await mkdir(root);
  await symlink(options.directory, path.join(root, "escape"));
  const claims = ["../outside.mjs", "/synthetic-external/helper.mjs", "escape/helper.mjs"];
  const initial = await prepare({root});
  const raw = response({review_status: "INCOMPLETE", verdict: null, findings: claims.map((name, index) => finding(`UNBOUND-${index}`, {path: name, affected_paths: [name]})), unreviewed: claims});
  await saveRound(initial, null, null, {error: {message: "Synthetic reviewer execution failure."}, observed: {response: raw, assessed: assessRound(initial, raw, []), response_evidence: {value: "@synthetic.json", sha256: "synthetic"}}});
  const current = await prepare({root});
  assert.equal(current.public.unavailable_sources.length, 3);
  for (const name of claims) {
    assert.ok(!Object.hasOwn(current.snapshot.files, name));
    assert.ok(!current.public.required_paths.includes(name));
    assert.equal(current.public.path_dispositions.find((item) => item.path === name).current.availability, "UNAVAILABLE");
  }
  assert.equal(current.public.observed_assessments[0].findings.length, 3);
  const resolutions = raw.findings.map(({id}) => ({id, status: "RESOLVED", evidence: "Independently confirmed initial claim has no authorized owner-local source scope; original source facts remain unavailable."}));
  const fresh = response({coverage: current.public.required_paths.map((name) => coverage(name)), resolutions});
  assert.throws(() => assessRound(current, fresh, []), /unavailable scope requires independent disposition/);
  fresh.scope_dispositions = claims.map((name) => ({path: name, disposition: "UNAVAILABLE", evidence: "Independent current scope assessment confirms an unbindable claim without external reads or invented source coverage."}));
  assert.throws(() => assessRound(current, {...fresh, resolutions: []}, []), /resolution evidence/);
  assert.throws(() => assessRound(current, {...fresh, coverage: [...fresh.coverage, coverage(claims[0])]}, []), /complete dependency paths/);
  await record(current, fresh);
  assert.equal((await prepare({root})).public.finding_history.filter((item) => item.last_status === "RESOLVED").length, 3);
});

test("coverage and validation witnesses invalidate dependency, authority, tool, configuration and environment changes", async (t) => {
  const {prepare, record, options, inputs, nativeProofs} = await fixture(t);
  options.validationProofs = nativeProofs;
  const validation = {id: "check-a", evidence: "@check.log", command: JSON.stringify(["node", "--test", "test.mjs"]), dependencies: ["a.mjs", "test.mjs", "config.json"], dependency_rationale: "Synthetic source, test and configuration closure.", assessment: "Passed in bound environment."};
  await record(await prepare(), response({coverage: [coverage("a.mjs", validation.dependencies), coverage("b.mjs")], validations: [validation]}));
  const unchanged = await prepare();
  assert.equal(unchanged.public.eligible_validations.length, 1);
  assert.equal(unchanged.public.eligible_coverage.length, 2);
  const automatic = assessRound(unchanged, response(), inputs.validation);
  assert.equal(automatic.validations.length, 1);
  assert.equal(automatic.validations[0].execution_record_sha256, "native-proof-a");
  for (const change of [
    {files: {...options.files, "test.mjs": "test2"}},
    {files: {...options.files, "config.json": "config2"}},
    {environment: "environment-b"},
    {inputs: {...inputs, tool_sha256: "tool-b"}},
    {inputs: {...inputs, authorities: [{path: "AGENTS.md", sha256: "authority-b"}]}},
    {inputs: {...inputs, validation: [{kind: "file", value: "@check.log", sha256: "evidence-b"}]}},
  ]) {
    const context = await prepare(change);
    assert.equal(context.public.eligible_validations.length, 0);
    assert.ok(context.public.invalidated.some((item) => item.kind === "validation" && item.reason));
  }
  assert.throws(() => assessRound(unchanged, response({validations: [{...validation, evidence: "asserted pass"}]}), []), /hash-bound file evidence/);
  const rawOnly = await prepare({validationProofs: []});
  assert.throws(() => assessRound(rawOnly, response({validations: [validation]}), inputs.validation), /raw logs cannot be relabeled/);
  const oldProof = structuredClone(options.validationProofs);
  oldProof[0].record.before.files["a.mjs"] = "original-old-input";
  const oldInputs = await prepare({validationProofs: oldProof});
  assert.throws(() => assessRound(oldInputs, response({validations: [validation]}), inputs.validation), /original command, input/);
  assert.throws(() => assessRound(unchanged, response({coverage: [coverage("a.mjs", ["a.mjs", "missing.mjs"]), coverage("b.mjs")]}), []), /dependency is absent/);
  const scoped = await prepare({inputs: {...inputs, proposal_sha256: "repair-proposal"}});
  assert.equal(scoped.public.series_id, unchanged.public.series_id);
  assert.equal(scoped.public.proposal_scope_changed, true);
});

test("original full validation scope rejects added paths and bound authority changes in every reuse consumer", async (t) => {
  const {prepare, record, options, inputs, nativeProofs} = await fixture(t);
  options.validationProofs = nativeProofs;
  const validation = {id: "whole-check", evidence: "@check.log", command: JSON.stringify(nativeProofs[0].record.command), dependencies: ["a.mjs", "test.mjs", "config.json"], dependency_rationale: "Synthetic declared subset still belongs to an original full-candidate execution.", assessment: "Original full-candidate check passed."};
  await record(await prepare(), response({validations: [validation]}));
  const changed = await prepare({candidate: {...options.candidate, tree: "tree-with-added-path", files: [...options.candidate.files, "unlisted.mjs"]}, files: {...options.files, "unlisted.mjs": "added-source"}});
  assert.equal(changed.public.eligible_validations.length, 0);
  assert.equal(changed.public.preverified_validations.length, 0);
  assert.ok(changed.public.invalidated.some((item) => item.id === validation.id && /full-candidate validation tree changed/.test(item.reason)));
  assert.throws(() => assessRound(changed, response({coverage: [coverage("a.mjs"), coverage("b.mjs"), coverage("unlisted.mjs")], validations: [validation]}), inputs.validation), /recorded scope.*full-candidate validation tree changed/);
  const authorityChange = await prepare({inputs: {...inputs, authorities: inputs.authorities.map((item) => item.path === "Vault/docs/status.md" ? {...item, sha256: "changed-status"} : item)}});
  assert.equal(authorityChange.public.eligible_validations.length, 0);
  assert.equal(authorityChange.public.preverified_validations.length, 0);
  assert.throws(() => assessRound(authorityChange, response({coverage: [...response().coverage, coverage("Vault/docs/status.md")], validations: [validation]}), inputs.validation), /recorded scope.*input facts changed/);
});

test("prior assessment projection preserves genuine classifications across errors and reports changed guards", async (t) => {
  const {prepare, record, options} = await fixture(t);
  const initial = await prepare(); assert.equal(initial.public.prior_assessment, null);
  await record(initial, response({summary: "Synthetic native assessment.", authentication_impact: false, owner_approval_status: "NOT_REQUIRED", api_version_assessment: {impact: "NONE", request_kind: "NOT_REQUIRED"}}));
  const unchanged = await prepare(), prior = unchanged.public.prior_assessment;
  assert.equal(prior.round, 1); assert.equal(prior.candidate_equal, true); assert.equal(prior.guard_equal, true);
  assert.equal(prior.classifications.authentication_impact, false); assert.equal(prior.classifications_available, true);
  assert.match(prior.origin.round_sha256, /^[a-f0-9]{64}$/);
  await saveRound(unchanged, null, null, {error: {message: "Synthetic interrupted assessment"}});
  const changed = await prepare({candidate: {...options.candidate, tree: "changed-tree"}, files: {...options.files, "a.mjs": "changed-source"}, inputs: {...options.inputs, owner: "Changed owner provenance"}});
  assert.equal(changed.public.prior_assessment.round, 1);
  assert.equal(changed.public.prior_assessment.origin.round_sha256, prior.origin.round_sha256);
  assert.equal(changed.public.prior_assessment.candidate_equal, false); assert.equal(changed.public.prior_assessment.guard_equal, false);
  assert.equal(changed.public.fresh_protected_authority_assessment_required, true);
  assert.ok(!Object.hasOwn(changed.public.prior_assessment, "coverage")); assert.ok(!Object.hasOwn(changed.public.prior_assessment, "validations"));
});

test("partial assessments and process errors resume coverage without manufacturing source rejection", async (t) => {
  const {prepare, record} = await fixture(t);
  await record(await prepare(), response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("a.mjs")], findings: [finding()], unreviewed: ["b.mjs"]}));
  const resume = await prepare();
  assert.equal(resume.public.mode, "resume");
  assert.deepEqual(resume.public.eligible_coverage.map((item) => item.path), ["a.mjs"]);
  assert.equal(resume.public.prior_findings[0].id, "F-1");
  await saveRound(resume, null, null, {error: {message: "synthetic reviewer interruption"}});
  const next = await prepare();
  assert.equal(next.public.mode, "resume");
  assert.equal(next.public.prior_findings[0].id, "F-1");
  assert.equal(next.public.eligible_coverage.length, 1);
  assert.deepEqual(next.public.unfinished_scope, ["b.mjs"]);
  assert.equal(next.public.initial_assessment_complete, false);
  assert.deepEqual(next.public.pending_changed_paths, ["a.mjs", "b.mjs"]);
  assert.doesNotThrow(() => assessRound(next, response({verdict: "REJECTED", findings: [finding(), finding("F-2")], resolutions: [{id: "F-1", status: "OPEN", evidence: "Initial finding remains open."}]}), []));
  assert.throws(() => assessRound(next, response({coverage: [coverage("a.mjs")]}), []), /lacks coverage/);
  assert.throws(() => assessRound(next, response({review_status: "INCOMPLETE"}), []), /completion state/);
});

test("late findings distinguish repair defects from missed unchanged-code coverage and retain IDs", async (t) => {
  const {prepare, record, options} = await fixture(t);
  await record(await prepare(), response({verdict: "REJECTED", findings: [finding()]}));
  const followup = await prepare({files: {...options.files, "a.mjs": "a2"}});
  const resolution = [{id: "F-1", status: "RESOLVED", evidence: "Synthetic repair verified."}];
  assert.throws(() => assessRound(followup, response({verdict: "REJECTED", findings: [finding("F-2")], resolutions: resolution}), []), /identify repair impact/);
  const introduced = finding("F-2", {origin: "repair", affected_paths: ["a.mjs", "b.mjs"]});
  assert.doesNotThrow(() => assessRound(followup, response({verdict: "REJECTED", findings: [introduced], resolutions: resolution}), []));
  // The primary finding path is part of its affected scope even when omitted from affected_paths.
  assert.doesNotThrow(() => assessRound(followup, response({verdict: "REJECTED", findings: [{...introduced, affected_paths: ["b.mjs"]}], resolutions: resolution}), []));
  assert.throws(() => assessRound(followup, response({verdict: "REJECTED", findings: [{...introduced, path: "b.mjs", affected_paths: ["b.mjs"]}], resolutions: resolution}), []), /missed-finding attribution/);
  const missed = finding("F-2", {origin: "missed", path: "b.mjs", affected_paths: ["b.mjs"]});
  assert.throws(() => assessRound(followup, response({verdict: "REJECTED", findings: [missed], resolutions: resolution}), []), /first-pass coverage explanation/);
  assert.doesNotThrow(() => assessRound(followup, response({verdict: "REJECTED", findings: [{...missed, missed_finding_reason: "The initial failure-path scan missed this unchanged input."}], resolutions: resolution}), []));
  assert.throws(() => assessRound(followup, response({verdict: "REJECTED", findings: [finding("F-1", {code: "OTHER"})], resolutions: [{id: "F-1", status: "OPEN", evidence: "Still failing."}]}), []), /changed identity/);
});

test("two unsuccessful repairs require synthesis and history corruption fails closed", async (t) => {
  const {prepare, record, options} = await fixture(t);
  const rejected = response({verdict: "REJECTED", findings: [finding()]});
  await record(await prepare(), rejected);
  for (let index = 0; index < 2; index++) await record(await prepare(), {...rejected, resolutions: [{id: "F-1", status: "OPEN", evidence: "Synthetic defect remains."}]});
  const third = await prepare();
  assert.equal(third.public.synthesis_required, true);
  assert.equal(third.public.latest_repair_plan.after_unsuccessful_repair_rounds, 2);
  assert.deepEqual(third.public.latest_repair_plan.findings.map((item) => item.id), ["F-1"]);
  assert.deepEqual(third.public.latest_repair_plan.findings[0].acceptance_checks, rejected.findings[0].acceptance_checks);
  assert.doesNotThrow(() => assessRound(third, {...rejected, resolutions: [{id: "F-1", status: "OPEN", evidence: "Still failing."}]}, []));
  const series = JSON.parse(await readFile(third.filename));
  series.rounds[0].findings[0].message = "tampered";
  await writeFile(third.filename, JSON.stringify(series));
  assert.throws(() => verifySeries(series, options.candidate.base), /malformed or changed/);
  await assert.rejects(prepare(), /malformed or changed/);
  await writeFile(third.filename, "{}");
  await assert.rejects(prepare(), /malformed or changed/);
  const rebased = await prepare({candidate: {...options.candidate, base: "base-b"}});
  assert.equal(rebased.public.mode, "initial");
});

test("finding attribution distinguishes mechanical guards and approved requirement deltas", async (t) => {
  const {prepare, record, directory, options, inputs} = await fixture(t);
  for (const kind of ["mechanical", "metadata-only", "approved-requirement", "source", "dependency", "source-primary-omitted", "dependency-primary-only"]) {
    const local = {directory: path.join(directory, kind), proposalRecord: {proposal: "Original approved requirement"}};
    await record(await prepare(local), response({coverage: [coverage("a.mjs", ["a.mjs", "config.json"]), coverage("b.mjs")]}));
    const changes = kind === "mechanical" ? {inputs: {...inputs, tool_sha256: "changed-reviewer-policy"}} :
      kind === "metadata-only" ? {inputs: {...inputs, proposal_sha256: "new-record-same-requirement"}} :
      kind === "approved-requirement" ? {inputs: {...inputs, proposal_sha256: "new-approved-requirement"}, proposalRecord: {proposal: "Approved requirement adds a new accepted invariant"}} :
      {files: {...options.files, [kind.startsWith("source") ? "a.mjs" : "config.json"]: "actual-new-input"}};
    const current = await prepare({...local, ...changes});
    const introduced = finding(`F-${kind}`, {origin: "repair", affected_paths: kind === "dependency" ? ["a.mjs", "config.json"] : kind === "source-primary-omitted" ? ["b.mjs"] : ["a.mjs"]});
    const rejected = response({verdict: "REJECTED", coverage: current.public.required_paths.map((name) => coverage(name)), findings: [introduced]});
    if (["mechanical", "metadata-only"].includes(kind)) {
      if (kind === "mechanical") assert.equal(current.public.eligible_coverage.length, 0);
      assert.throws(() => assessRound(current, {...rejected, synthesis: "A metadata change supplies no new acceptance requirement."}, []), /changed path|approved requirement|missed-finding/);
      const missed = {...introduced, origin: "missed", missed_finding_reason: "The prior complete scan omitted this unchanged failure boundary."};
      const accepted = {...rejected, findings: [missed]};
      assert.doesNotThrow(() => assessRound(current, accepted, []));
      const persisted = await record(current, accepted);
      assert.equal(persisted.rounds.at(-1).review_status, "COMPLETE");
      assert.equal(persisted.rounds.at(-1).findings[0].origin, "missed");
    } else {
      if (kind === "approved-requirement") {
        assert.deepEqual(current.public.pending_changed_paths, []);
        assert.throws(() => assessRound(current, rejected, []), /changed path|approved requirement|missed-finding/);
        rejected.synthesis = "The changed approved requirement introduces the additional invariant; the prior requirement did not contain it.";
      }
      assert.doesNotThrow(() => assessRound(current, rejected, []), kind);
    }
  }
  for (const kind of ["carried-error", "carried-incomplete", "fresh-identical-incomplete"]) {
    const local = {directory: path.join(directory, kind), proposalRecord: {proposal: "Original approved requirement"}};
    const original = response();
    await record(await prepare(local), original);
    const updated = {...local, inputs: {...inputs, proposal_sha256: "new-approved-scope"}, proposalRecord: {proposal: "New approved requirement"}};
    const middle = await prepare(updated);
    if (kind === "carried-error") await saveRound(middle, null, null, {error: {message: "Synthetic interrupted new-scope review"}});
    else await record(middle, response({review_status: "INCOMPLETE", verdict: null, coverage: kind === "fresh-identical-incomplete" ? structuredClone(original.coverage) : [], reused_coverage: kind === "fresh-identical-incomplete" ? [] : ["a.mjs", "b.mjs"], unreviewed: ["config.json"]}));
    const current = await prepare(updated);
    assert.equal(current.public.proposal_scope_changed, false);
    const rejected = response({verdict: "REJECTED", coverage: current.public.required_paths.map((name) => coverage(name)), findings: [finding(`F-${kind}`, {origin: "repair"})], synthesis: "The new approved requirement introduces this accepted invariant."});
    if (kind === "fresh-identical-incomplete") assert.throws(() => assessRound(current, rejected, []), /missed-finding/);
    else assert.doesNotThrow(() => assessRound(current, rejected, []), kind);
  }
});

test("unfinished coverage preserves historical approved scope for finding attribution", async (t) => {
  const {prepare, record, directory, inputs} = await fixture(t);
  for (const kind of ["new-requirement", "same-requirement", "fresh-identical-requirement"]) {
    const local = {directory: path.join(directory, kind), proposalRecord: {proposal: "Approved requirement A"}};
    const original = response();
    await record(await prepare(local), original);
    const updated = kind === "same-requirement" ? local : {...local, inputs: {...inputs, proposal_sha256: "approved-requirement-b"}, proposalRecord: {proposal: "Approved requirement B"}};
    if (kind === "fresh-identical-requirement") {
      const fresh = await record(await prepare(updated), response({review_status: "INCOMPLETE", verdict: null, coverage: structuredClone(original.coverage), unreviewed: ["config.json"]}));
      assert.deepEqual(fresh.rounds.at(-1).response.coverage, original.coverage);
    }
    await record(await prepare(updated), response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("b.mjs")], unreviewed: ["a.mjs"]}));
    const current = await prepare(updated);
    assert.deepEqual(current.public.pending_changed_paths, []);
    assert.equal(current.public.proposal_scope_changed, false);
    assert.ok(current.public.unfinished_scope.includes("a.mjs"));
    assert.ok(!current.public.eligible_coverage.some((item) => item.path === "a.mjs"));
    const introduced = finding(`F-${kind}`, {origin: "repair"});
    const rejected = response({verdict: "REJECTED", coverage: current.public.required_paths.map((name) => coverage(name)), findings: [introduced], synthesis: "Approved requirement B introduces the additional accepted invariant absent from requirement A."});
    if (kind === "new-requirement") {
      const persisted = await record(current, rejected);
      assert.equal(persisted.rounds.at(-1).findings[0].origin, "repair");
    } else {
      assert.throws(() => assessRound(current, rejected, []), /missed-finding/);
      const missed = {...introduced, origin: "missed"};
      assert.throws(() => assessRound(current, {...rejected, findings: [missed]}, []), /first-pass coverage explanation/);
      missed.missed_finding_reason = "The prior completed path assessment omitted this unchanged failure boundary under the same approved requirement.";
      const persisted = await record(current, {...rejected, findings: [missed]});
      assert.equal(persisted.rounds.at(-1).findings[0].origin, "missed");
    }
  }
});

test("approval resets repair count and a path reverted to base remains in follow-up scope", async (t) => {
  const {prepare, record, options} = await fixture(t);
  const rejected = response({verdict: "REJECTED", findings: [finding()]});
  await record(await prepare(), rejected);
  for (let index = 0; index < 2; index++) await record(await prepare(), {...rejected, resolutions: [{id: "F-1", status: "OPEN", evidence: "Synthetic defect remains."}]});
  await record(await prepare(), response({synthesis: "Full findings reconciled and repair acceptance confirmed.", resolutions: [{id: "F-1", status: "RESOLVED", evidence: "Synthetic repair verified."}]}));
  const reverted = await prepare({candidate: {...options.candidate, files: ["b.mjs"]}, files: {...options.files, "a.mjs": "base-value"}});
  assert.equal(reverted.public.unsuccessful_repair_rounds, 0);
  assert.equal(reverted.public.synthesis_required, false);
  assert.ok(reverted.public.required_paths.includes("a.mjs"));
  assert.throws(() => assessRound(reverted, response({coverage: [], reused_coverage: ["b.mjs"]}), []), /lacks coverage: a.mjs/);
  await saveRound(reverted, null, null, {error: {message: "Synthetic interruption."}});
  const resumed = await prepare({candidate: {...options.candidate, files: ["b.mjs"]}, files: {...options.files, "a.mjs": "base-value"}});
  assert.deepEqual(resumed.public.changed_since_previous, []);
  assert.deepEqual(resumed.public.pending_changed_paths, ["a.mjs"]);
  assert.ok(resumed.public.required_paths.includes("a.mjs"));
});

test("unrelated authority docs retain narrow witnesses while relied-on docs and controlling policy invalidate them", async (t) => {
  const {prepare, record, options, inputs, nativeProofs} = await fixture(t);
  const dependencies = ["a.mjs", "test.mjs", "Vault/docs/design.md", "AGENTS.md"];
  // This command originally declared its complete source/test/design/policy
  // scope. The full-candidate proof above remains conservative and untrimmed.
  const before = reviewSnapshot(options);
  nativeProofs[0].record.before = {...before, scope: "declared-inputs-v2", tree: null, context: {environment: options.environment}, files: Object.fromEntries(dependencies.map((name) => [name, before.files[name]]))};
  nativeProofs[0].record.after = nativeProofs[0].record.before;
  options.validationProofs = nativeProofs;
  const validation = {id: "design-check", evidence: "@check.log", command: JSON.stringify(nativeProofs[0].record.command), dependencies, dependency_rationale: "This behavior relies on its source, test and exact design authority.", assessment: "Native execution verified."};
  await record(await prepare(), response({coverage: [coverage("a.mjs", dependencies), coverage("b.mjs")], validations: [validation]}));
  const mutate = (name) => ({inputs: {...inputs, authorities: inputs.authorities.map((item) => item.path === name ? {...item, sha256: `${item.sha256}-changed`} : item)}});
  const unrelated = await prepare(mutate("Vault/docs/status.md"));
  assert.deepEqual(unrelated.public.eligible_coverage.map((item) => item.path), ["a.mjs", "b.mjs"]);
  assert.equal(unrelated.public.eligible_validations[0].id, "design-check");
  assert.ok(unrelated.public.required_paths.includes("Vault/docs/status.md"));
  const reliedOn = await prepare(mutate("Vault/docs/design.md"));
  assert.deepEqual(reliedOn.public.eligible_coverage.map((item) => item.path), ["b.mjs"]);
  assert.equal(reliedOn.public.eligible_validations.length, 0);
  assert.ok(reliedOn.public.invalidated.every((item) => /dependency changed|declared inputs|recorded validation input facts changed/.test(item.reason)));
  const policy = await prepare(mutate("AGENTS.md"));
  assert.equal(policy.public.eligible_coverage.length, 0);
  assert.equal(policy.public.eligible_validations.length, 0);
});

test("allowlisted external dependency additions, changes and removal invalidate dependent proof only", async (t) => {
  const {prepare, record, options, inputs} = await fixture(t);
  const parent = path.join(options.directory, "AGENTS.md");
  const family = path.join(options.directory, "Vault/docs/architecture/bos-product-family.md");
  const tool = path.join(options.directory, "tools/projects_oracle.py");
  const external = [{path: parent, sha256: "parent-a", external: true, controlling: true}, {path: family, sha256: "family-a", external: true, controlling: false}, {path: tool, sha256: null, external: true, controlling: false}];
  options.inputs = {...inputs, authorities: [...inputs.authorities, ...external]};
  const original = reviewSnapshot(options);
  const proof = {evidence: "@check.log", eligible: true, record: {record_sha256: "external-proof", command: ["node", "--test", "test.mjs"], before: original, after: original}};
  options.validationProofs = [proof];
  const dependencies = ["a.mjs", "test.mjs", family, tool];
  const validation = {id: "external-check", evidence: "@check.log", command: JSON.stringify(proof.record.command), dependencies, dependency_rationale: "Behavior depends on exact declared family/tool evidence, including the absent tool.", assessment: "Original passing execution bound."};
  await record(await prepare(), response({coverage: [coverage("a.mjs", dependencies), coverage("b.mjs"), coverage(parent), coverage(family)], validations: [validation]}));
  assert.equal((await prepare()).public.eligible_validations[0].id, "external-check");
  const changed = (filename, hash) => ({inputs: {...options.inputs, authorities: options.inputs.authorities.map((item) => item.path === filename ? {...item, sha256: hash} : item)}});
  for (const change of [changed(family, "family-b"), changed(family, null), changed(tool, "tool-added"), {inputs: {...options.inputs, authorities: options.inputs.authorities.filter((item) => item.path !== family)}}]) {
    const current = await prepare(change);
    assert.ok(!current.public.eligible_coverage.some((item) => item.path === "a.mjs"));
    assert.ok(current.public.eligible_coverage.some((item) => item.path === "b.mjs"));
    assert.equal(current.public.eligible_validations.length, 0);
    assert.ok(current.snapshot.external_paths.includes(family));
  }
  const policy = await prepare(changed(parent, "parent-b"));
  assert.equal(policy.public.eligible_coverage.length, 0); assert.equal(policy.public.eligible_validations.length, 0);
  const current = await prepare();
  assert.throws(() => assessRound(current, response({coverage: [coverage("a.mjs", ["a.mjs", path.join(options.directory, "undeclared.py")]), coverage("b.mjs")]}), inputs.validation), /explicit complete dependency paths/);
  const directory = path.join(options.directory, "unfinished-external");
  await record(await prepare({directory}), response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("a.mjs"), coverage("b.mjs")], unreviewed: [family]}));
  const resumed = await prepare({directory, inputs: {...options.inputs, authorities: options.inputs.authorities.filter((item) => item.path !== family)}});
  assert.equal(resumed.snapshot.files[family], null);
  assert.ok(resumed.snapshot.external_paths.includes(family));
  assert.doesNotThrow(() => assessRound(resumed, response({coverage: resumed.public.required_paths.map((name) => coverage(name))}), inputs.validation));
});

test("removed candidate-only paths retain tombstones across complete, error and validation-witness reuse", async (t) => {
  const {prepare, record, options, inputs} = await fixture(t);
  const added = {...options, candidate: {...options.candidate, tree: "added-tree", files: [...options.candidate.files, "new.mjs"]}, files: {...options.files, "new.mjs": "new-value"}};
  await record(await prepare(added), response({coverage: [...response().coverage, coverage("new.mjs")]}));
  const removedOptions = {candidate: {...options.candidate, tree: "removed-tree"}, files: options.files};
  const removed = await prepare(removedOptions);
  assert.equal(removed.snapshot.files["new.mjs"], null);
  const proof = {evidence: "@check.log", eligible: true, record: {record_sha256: "removed-path-proof", command: ["node", "--test", "test.mjs"], before: removed.snapshot, after: removed.snapshot}};
  const withProof = await prepare({...removedOptions, validationProofs: [proof]});
  const validation = {id: "absent-path-check", evidence: "@check.log", command: JSON.stringify(proof.record.command), dependencies: ["a.mjs", "new.mjs"], dependency_rationale: "The check verifies the source and removed path's continued absence.", assessment: "Native passing absence check verified."};
  await record(withProof, response({coverage: [...response().coverage, coverage("new.mjs")], validations: [validation]}));
  for (const state of ["complete", "partial", "error"]) {
    const current = await prepare({...removedOptions, validationProofs: [proof]});
    assert.ok(Object.hasOwn(current.snapshot.files, "new.mjs"));
    assert.equal(current.snapshot.files["new.mjs"], null);
    if (state === "error") {
      await saveRound(current, null, null, {error: {message: "Synthetic interruption while retaining absent-path witnesses."}});
      continue;
    }
    await record(current, response({coverage: [], reused_coverage: ["a.mjs", "b.mjs", "new.mjs"], reused_validations: ["absent-path-check"], ...(state === "partial" ? {review_status: "INCOMPLETE", verdict: null, unreviewed: ["final cross-path assessment"]} : {})}));
  }
  const resumed = await prepare({...removedOptions, validationProofs: [proof]});
  assert.equal(resumed.public.mode, "resume");
  assert.equal(resumed.public.eligible_validations[0].id, "absent-path-check");
  const final = await record(resumed, response({coverage: [], reused_coverage: ["a.mjs", "b.mjs", "new.mjs"], reused_validations: ["absent-path-check"]}));
  assert.equal(verifySeries(final, options.candidate.base), final);
  await prepare({...removedOptions, validationProofs: [proof]});
});


test("additive owner metadata preserves source observations and execution facts while permission stays fresh", async (t) => {
  const {prepare, record, options, inputs, nativeProofs} = await fixture(t);
  options.validationProofs = nativeProofs;
  const validation = {id: "owner-independent-check", evidence: "@check.log", command: JSON.stringify(nativeProofs[0].record.command), dependencies: ["a.mjs", "test.mjs", "config.json"], dependency_rationale: "Complete execution source/configuration closure; approval metadata is not a command input.", assessment: "Original command passed."};
  await record(await prepare(), response({validations: [validation]}));
  options.inputs = {...inputs, owner: {kind: "file", value: "owner-evidence.json", sha256: "owner-a"}};
  const added = await prepare();
  assert.equal(added.public.eligible_coverage.length, 2); assert.equal(added.public.eligible_validations.length, 1);
  assert.equal(added.public.fresh_protected_authority_assessment_required, true);
  assert.equal(added.public.owner_evidence_changed, true);
  assert.ok(added.public.recovered_coverage.every((item) => item.additive_owner_evidence));
  const approved = response({coverage: [], reused_coverage: ["a.mjs", "b.mjs"], reused_validations: [validation.id]});
  const saved = await record(added, approved); verifySeries(saved, options.candidate.base);
  for (const owner of [null, {...options.inputs.owner, sha256: "owner-b"}]) {
    const changed = await prepare({inputs: {...options.inputs, owner}});
    assert.equal(changed.public.eligible_coverage.length, 0);
    assert.equal(changed.public.eligible_validations.length, 1);
  }
  // A real declared owner file remains an execution input, with its bytes bound.
  options.files = {...options.files, "owner-evidence.json": "owner-source-a"};
  const withOwnerFile = await prepare();
  const proof = {evidence: "@check.log", eligible: true, record: {record_sha256: "owner-file-proof", command: nativeProofs[0].record.command, before: withOwnerFile.snapshot, after: withOwnerFile.snapshot}};
  options.validationProofs = [proof];
  await record(await prepare(), response({coverage: [...response().coverage, coverage("owner-evidence.json")], validations: [{...validation, dependencies: [...validation.dependencies, "owner-evidence.json"]}]}));
  const drift = await prepare({files: {...options.files, "owner-evidence.json": "owner-source-b"}});
  assert.equal(drift.public.eligible_validations.length, 0);
});

test("immutable earlier observations recover after ERROR dropped coverage and explicit unread scope stays blocked", async (t) => {
  const {prepare, record, options, inputs, nativeProofs} = await fixture(t);
  options.validationProofs = nativeProofs;
  const validation = {id: "historical-pass", evidence: "@check.log", command: JSON.stringify(nativeProofs[0].record.command), dependencies: ["a.mjs", "test.mjs"], dependency_rationale: "Original complete check closure.", assessment: "Passed."};
  await record(await prepare(), response({validations: [validation]}));
  const interrupted = await prepare({inputs: {...inputs, owner: {kind: "file", value: "owner.json", sha256: "new-owner"}}});
  // Model the older blanket guard dropping every observation before ERROR.
  interrupted.public.eligible_coverage = []; interrupted.public.eligible_validations = []; interrupted.public.preverified_validations = [];
  await saveRound(interrupted, null, null, {error: {message: "Synthetic old-process interruption"}});
  options.inputs = {...inputs, owner: {kind: "file", value: "owner.json", sha256: "new-owner"}};
  const resumed = await prepare();
  assert.equal(resumed.public.eligible_coverage.length, 2); assert.equal(resumed.public.eligible_validations.length, 1);
  assert.ok(resumed.public.recovered_coverage.every((item) => item.from_round === 1));
  await record(resumed, response({review_status: "INCOMPLETE", verdict: null, coverage: [coverage("a.mjs")], unreviewed: ["b.mjs"]}));
  const explicitUnread = await prepare();
  assert.deepEqual(explicitUnread.public.eligible_coverage.map((item) => item.path), ["a.mjs"]);
  const changed = await prepare({files: {...options.files, "test.mjs": "changed dependency"}});
  assert.equal(changed.public.eligible_validations.length, 0);
});

test("instruction changes retain sealed complete supporting coverage while requiring current criteria and new files", async (t) => {
  const {prepare, record, options, inputs} = await fixture(t);
  await record(await prepare(), response());
  const current = await prepare({inputs: {...inputs, authorities: inputs.authorities.map((item) => item.path === "AGENTS.md" ? {...item, sha256: "changed-criteria"} : item)}, candidate: {...options.candidate, tree: "next-tree", files: [...options.candidate.files, "new.mjs"]}, files: {...options.files, "new.mjs": "new-source"}});
  assert.equal(current.public.eligible_coverage.length, 0);
  assert.deepEqual(current.public.supporting_coverage.map((item) => item.path).sort(), ["a.mjs", "b.mjs"]);
  assert.ok(current.public.supporting_coverage.every((item) => item.coverage_eligibility === "NONE" && item.independent_applicability_required && item.changed_context.includes("authorities")));
  assert.ok(current.public.required_paths.includes("new.mjs"));
  assert.throws(() => assessRound(current, response({coverage: [], reused_coverage: ["a.mjs", "b.mjs"]}), []), /reused coverage is invalid/);
  await record(current, response({coverage: current.public.required_paths.map((name) => coverage(name))}));
});

test("exclusive round publication retains the first result when optimistic publishers collide", async (t) => {
  const {prepare, record, inputs, directory} = await fixture(t);
  const older = await prepare(), newer = await prepare();
  const first = response({verdict: "REJECTED", findings: [finding()]});
  await assert.rejects(saveRound(older, response(), assessRound(older, response(), inputs.validation), {beforePublish: () => record(newer, first)}), /EEXIST/);
  const current = JSON.parse(await readFile(older.filename));
  assert.equal(current.rounds.length, 1); assert.equal(current.rounds[0].verdict, "REJECTED");
  const replay = await prepare(); assert.equal(replay.public.round, 2);
  const journal = path.join(directory, "series", "rounds", "base-a", "1.json");
  assert.equal(JSON.parse(await readFile(journal)).series.sha256, current.sha256);
  await rm(older.filename);
  const recovered = await prepare();
  assert.equal(recovered.series.sha256, current.sha256); assert.equal(recovered.public.round, 2);
});

test("losing assessment retains raw findings outside active publication and resumes them", async (t) => {
  const {prepare, record, inputs} = await fixture(t);
  const older = await prepare(), newer = await prepare();
  await record(newer, response());
  const raw = response({verdict: "REJECTED", findings: [finding("F-LOST")]});
  await assert.rejects(saveRound(older, null, null, {error: {message: "Synthetic superseded attempt"}, observed: {
    response: raw, assessed: assessRound(older, raw, inputs.validation),
    response_evidence: {value: "@synthetic-losing-response.json", sha256: "a".repeat(64)}, execution: {exit_code: 0}, execution_evidence: null
  }}), /history changed/);
  const resumed = await prepare();
  assert.equal(resumed.public.observed_assessments.at(-1).source_verdict, null);
  assert.equal(resumed.public.observed_assessments.at(-1).execution_status, "ERROR");
  assert.ok(resumed.public.observed_assessments.some((item) => item.findings.some((entry) => entry.id === "F-LOST")));
  assert.throws(() => assessRound(resumed, response(), inputs.validation), /explicit resolution evidence/);
});
