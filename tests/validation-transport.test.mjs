import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink} from "node:fs/promises";
import {execFile} from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";
import {collectNativeChecks, exportNativeValidation, importNativeValidation, gitBlobHash, historicalInputComparisons, nativeCoverageIntake, requiredCommands, admitRequiredCI, publicGithubRequest, validationRef} from "../scripts/validation-transport.mjs";
import {bindingHash, evidenceBinding} from "../scripts/oracle-inputs.mjs";
import {validateRelease} from "../scripts/release-validation.mjs";
import {readValidationProofs, validationDigest} from "../scripts/oracle-validation.mjs";

const source = "a".repeat(40), tree = "b".repeat(40), repository = "synthetic-owner/my-crm";
const hash = value => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
const checks = () => requiredCommands.map(command => ({command, coverage: "EXACT_INPUT_EXECUTION", executions: [{record_sha256: "c".repeat(64), command_sha256: hash(JSON.stringify(command)),
  input_sha256: "d".repeat(64), executable_sha256: "e".repeat(64), environment_sha256: "f".repeat(64), output_sha256: "1".repeat(64), original_environment: {node: "v22.11.0", platform: "darwin", architecture: "arm64"}}]}));
// Public unauthenticated Actions reads. The watched ref is observed through an
// injected Git ref reader; only an explicitly authenticated writer may POST.
function service({writer = false} = {}) {
  const branch = `codex/validation-ready-${source}`;
  const state = {calls: [], ready: false,
    workflow: {id: 7, name: "ci", path: ".github/workflows/ci.yml", state: "active"},
    runs: [{id: 11, workflow_id: 7, path: ".github/workflows/ci.yml", head_sha: source, head_branch: branch, event: "push", run_attempt: 1, status: "completed", conclusion: "success", repository: {full_name: repository}, head_repository: {full_name: repository}}],
    jobs: [{id: 13, run_id: 11, run_attempt: 1, head_sha: source, head_branch: branch, name: "test", status: "completed", conclusion: "success"}]};
  const api = async (method, endpoint, body) => {
    state.calls.push({method, endpoint, body});
    if (method !== "GET") {
      if (writer && endpoint.endsWith("/rerun-failed-jobs") && method === "POST") {state.runs[0].run_attempt++; state.runs[0].status = "queued"; state.runs[0].conclusion = null; return null;}
      return publicGithubRequest(method, endpoint, body);
    }
    if (endpoint === `repos/${repository}`) return {owner: {id: 17}};
    if (endpoint === `repos/${repository}/actions/workflows/ci.yml`) return state.workflow;
    if (endpoint.includes(`/actions/workflows/${state.workflow.id}/runs?`)) return {total_count: state.runs.length, workflow_runs: state.runs};
    if (endpoint.includes("/actions/runs/") && endpoint.includes("/jobs?")) return {total_count: state.jobs.length, jobs: state.jobs};
    throw new Error(`Unexpected synthetic API call: ${method} ${endpoint}`);
  };
  const lsRemote = async ref => {state.calls.push({method: "GIT_LS_REMOTE", endpoint: ref}); return state.ready && ref === `refs/heads/${branch}` ? source : null;};
  return {state, api, lsRemote};
}
// A real repository and local bare remote stand in for the SSH remote.
async function repositoryFixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-transport-git-")));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, "repo"), remote = path.join(parent, "remote.git"), clone = path.join(parent, "clone");
  await execute("git", ["init", "--bare", "-b", "main", remote]); await execute("git", ["init", "-b", "main", root]);
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim(), bare = async (...args) => (await execute("git", args, {cwd: remote})).stdout.trim();
  await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid"); await git("remote", "add", "origin", remote);
  await writeFile(path.join(root, "source.txt"), "synthetic unpublished source\n"); await git("add", "."); await git("commit", "-m", "Synthetic source");
  const commit = await git("rev-parse", "HEAD"), commitTree = await git("rev-parse", "HEAD^{tree}");
  const api = async (method, endpoint) => {assert.equal(method, "GET"); if (endpoint === `repos/${repository}`) return {owner: {id: 17}}; throw new Error(`Unexpected synthetic API call: ${method} ${endpoint}`);};
  const exported = (collect = async () => checks()) => exportNativeValidation({root, repository, sourceCommit: commit, sourceTree: commitTree, admission: {}, remote: "origin", api, collect});
  const imported = async (options = {}) => {
    try {await execute("git", ["clone", "--quiet", remote, clone]);} catch {}
    return importNativeValidation({root: clone, repository, sourceCommit: commit, sourceTree: commitTree, remote: "origin", ownerId: "17", api: async () => assert.fail("Import used REST"), ...options});
  };
  return {root, remote, git, bare, source: commit, tree: commitTree, exported, imported};
}

test("first CI consumes git-native original checks and repeats zero validations", async t => {
  const f = await repositoryFixture(t); await f.exported();
  const prior = await f.imported(), executed = [];
  assert.equal(prior.covered.length, 3); assert.deepEqual(prior.invalidated, []);
  await validateRelease({nativeEvidence: false, priorCoverage: prior, execute: async args => executed.push(args)});
  assert.deepEqual(executed, []);
  assert.equal(prior.provenance, "ORIGINAL_NATIVE_EXECUTION");
  assert.equal(prior.covered[1].original_executions[0].original_environment.platform, "darwin");
  const publicBytes = (await execute("git", ["cat-file", "blob", `${validationRef(f.source)}:validation.json`], {cwd: f.remote})).stdout;
  const publicRecord = JSON.parse(publicBytes);
  assert.deepEqual(publicRecord.checks.map(check => check.command), requiredCommands);
  // Exact public command names may contain "review"; private review evidence may not.
  const withoutCommands = {...publicRecord, checks: publicRecord.checks.map(({command, ...check}) => check)};
  assert.doesNotMatch(JSON.stringify(withoutCommands), /Vault|\/Users\/|\/home\/|token|stderr|review|CODEX_|PATH|execution_cwd/i);
});

test("unpublished source travels with the leased evidence push and no side branch or status is created", async t => {
  const f = await repositoryFixture(t);
  await assert.rejects(execute("git", ["cat-file", "-e", `${f.source}^{commit}`], {cwd: f.remote}));
  const result = await f.exported();
  await execute("git", ["cat-file", "-e", `${f.source}^{commit}`], {cwd: f.remote});
  assert.equal(result.evidence_ref, validationRef(f.source)); assert.equal(await f.bare("rev-parse", validationRef(f.source)), result.evidence_commit);
  assert.equal(await f.bare("for-each-ref", "refs/heads"), "", "Evidence export created a branch");
  // A changed envelope for the same source replaces the evidence under a lease.
  const replaced = await f.exported(async () => checks().map((check, index) => index ? check : {...check, executions: [{...check.executions[0], output_sha256: "2".repeat(64)}]}));
  assert.notEqual(replaced.evidence_commit, result.evidence_commit);
  assert.equal(await f.bare("rev-parse", validationRef(f.source)), replaced.evidence_commit);
});

test("required CI watches the exact source after native evidence and reuses the existing test job without command replay", async t => {
  const g = await repositoryFixture(t); await g.exported();
  const f = service(), pushes = [], completed = f.state.runs; f.state.runs = [];
  const admit = () => admitRequiredCI({repository, sourceCommit: source, sourceTree: tree, api: f.api, lsRemote: f.lsRemote, pushSource: async args => {
    assert.ok(await g.bare("rev-parse", validationRef(g.source)), "Watched ref appeared before native evidence");
    assert.deepEqual(args, ["push", "--porcelain", `--force-with-lease=refs/heads/codex/validation-ready-${source}:`, "origin", `${source}:refs/heads/codex/validation-ready-${source}`]);
    pushes.push(args); f.state.ready = true; f.state.runs = completed;
  }});
  const admitted = await admit(); assert.equal(admitted.status, "SUCCEEDED"); assert.equal(admitted.source_commit, source); assert.equal(admitted.required_job, "test");
  assert.deepEqual(await admit(), admitted); assert.equal(pushes.length, 1);
  assert.ok(f.state.calls.every(item => item.method === "GET" || item.method === "GIT_LS_REMOTE"), "Required CI admission attempted a GitHub write");
});

test("required CI reuses prior PR and main successes and pending runs before ref lookup or mutation", async () => {
  for (const event of ["pull_request", "push"]) for (const status of ["success", "pending"]) {
    const f = service(), branch = event === "push" ? "main" : "synthetic-feature";
    Object.assign(f.state.runs[0], {event, head_branch: branch, ...(status === "pending" ? {status: "queued", conclusion: null} : {})});
    f.state.jobs[0].head_branch = branch;
    const invoke = () => admitRequiredCI({repository, sourceCommit: source, sourceTree: tree, api: f.api, lsRemote: f.lsRemote, pushSource: async () => {throw Error("Compatible CI triggered duplicate work");}});
    assert.equal((await invoke()).status, status === "success" ? "SUCCEEDED" : "PENDING");
    assert.equal((await invoke()).status, status === "success" ? "SUCCEEDED" : "PENDING");
    assert.ok(!f.state.calls.some(item => item.method === "GIT_LS_REMOTE"), "Existing CI admission looked up a new watched ref");
  }
  const f = service(); f.state.runs.unshift({...f.state.runs[0], id: 12, status: "completed", conclusion: "failure"});
  const admitted = await admitRequiredCI({repository, sourceCommit: source, sourceTree: tree, api: f.api, lsRemote: f.lsRemote});
  assert.equal(admitted.status, "SUCCEEDED"); assert.equal(admitted.run_id, 11); assert.equal(admitted.prior_failed_runs[0].run_id, 12);
});

test("failed CI preserves its original observation and permits one exact reason-bound recovery retry", async () => {
  const f = service({writer: true}); f.state.runs[0].conclusion = "failure";
  const options = {repository, sourceCommit: source, sourceTree: tree, api: f.api, lsRemote: f.lsRemote, pushSource: async () => {throw Error("Failed CI created another watched ref");}};
  const failed = await admitRequiredCI(options); assert.equal(failed.status, "FAILED");
  assert.ok(!f.state.calls.some(item => item.method === "POST"));
  for (const retryFailed of [{run_id: 12, run_attempt: 1, reason: "Synthetic recovered input"}, {run_id: 11, run_attempt: 1, reason: ""}]) await assert.rejects(admitRequiredCI({...options, retryFailed}), /exact first failed attempt/);
  // Without an authenticated writer the retry stays FAILED with manual recovery.
  const publicOnly = service(); publicOnly.state.runs[0].conclusion = "failure";
  const unavailable = await admitRequiredCI({...options, api: publicOnly.api, retryFailed: {run_id: 11, run_attempt: 1, reason: "Synthetic external input recovered"}});
  assert.equal(unavailable.status, "FAILED"); assert.equal(unavailable.retry_requested, false);
  assert.match(unavailable.reason, new RegExp(`github\\.com/${repository}/actions/runs/11`)); assert.equal(unavailable.prior_failed_runs[0].reason, "failure");
  assert.equal(publicOnly.state.runs[0].run_attempt, 1);
  const retried = await admitRequiredCI({...options, retryFailed: {run_id: 11, run_attempt: 1, reason: "Synthetic external input recovered"}});
  assert.equal(retried.status, "PENDING"); assert.equal(retried.prior_failed_runs[0].status, "FAILED"); assert.equal(retried.prior_failed_runs[0].reason, "failure");
  assert.equal((await admitRequiredCI(options)).run_attempt, 2); assert.equal(f.state.calls.filter(item => item.method === "POST").length, 1);
  Object.assign(f.state.runs[0], {status: "completed", conclusion: "failure"});
  await assert.rejects(admitRequiredCI({...options, retryFailed: {run_id: 11, run_attempt: 2, reason: "Another synthetic reason"}}), /exact first failed attempt/);
});

test("required exact-source CI preserves missing pending and failure states and rejects wrong native GitHub identities", async () => {
  for (const mutation of ["missing", "pending", "failure", "missing-job", "duplicate-job", "pending-job", "failed-job", "wrong-head", "wrong-repository", "wrong-head-repository", "wrong-workflow", "wrong-workflow-path", "disabled-workflow", "wrong-job-head", "wrong-job-run", "wrong-job-attempt", "wrong-job-branch", "malformed-job-state", "wrong-watched-ref"]) {
    const f = service(); f.state.ready = true;
    if (mutation === "missing") f.state.runs = [];
    if (mutation === "pending") Object.assign(f.state.runs[0], {status: "in_progress", conclusion: null});
    if (mutation === "failure") f.state.runs[0].conclusion = "failure";
    if (mutation === "missing-job") f.state.jobs = [];
    if (mutation === "duplicate-job") f.state.jobs.push({...f.state.jobs[0], id: 14});
    if (mutation === "pending-job") Object.assign(f.state.jobs[0], {status: "in_progress", conclusion: null});
    if (mutation === "failed-job") f.state.jobs[0].conclusion = "cancelled";
    if (mutation === "wrong-head") f.state.runs[0].head_sha = "9".repeat(40);
    if (mutation === "wrong-repository") f.state.runs[0].repository = {full_name: "synthetic-other/my-crm"};
    if (mutation === "wrong-head-repository") f.state.runs[0].head_repository = {full_name: "synthetic-other/my-crm"};
    if (mutation === "wrong-workflow") f.state.runs[0].workflow_id = 8;
    if (mutation === "wrong-workflow-path") f.state.workflow.path = ".github/workflows/other.yml";
    if (mutation === "disabled-workflow") f.state.workflow.state = "disabled_manually";
    if (mutation === "wrong-job-head") f.state.jobs[0].head_sha = "9".repeat(40);
    if (mutation === "wrong-job-run") f.state.jobs[0].run_id = 12;
    if (mutation === "wrong-job-attempt") f.state.jobs[0].run_attempt = 2;
    if (mutation === "wrong-job-branch") f.state.jobs[0].head_branch = "main";
    if (mutation === "malformed-job-state") Object.assign(f.state.jobs[0], {status: "unexpected", conclusion: null});
    if (mutation === "wrong-watched-ref") {f.state.runs = []; f.lsRemote = async () => "9".repeat(40);}
    const invoke = () => admitRequiredCI({repository, sourceCommit: source, sourceTree: tree, api: f.api, lsRemote: f.lsRemote, pushSource: async () => {throw Error("Existing fixed validation ref was pushed again");}});
    const expected = {missing: "MISSING", pending: "PENDING", failure: "FAILED", "missing-job": "MISSING", "duplicate-job": "MISSING", "pending-job": "PENDING", "failed-job": "FAILED"}[mutation];
    if (expected) assert.equal((await invoke()).status, expected, mutation);
    else await assert.rejects(invoke(), /identity|different|differs|malformed/, mutation);
  }
});

test("different owner, tree, source and absent evidence invalidate coverage", async t => {
  const f = await repositoryFixture(t); await f.exported();
  for (const [name, options] of Object.entries({owner: {ownerId: "18"}, tree: {sourceTree: "4".repeat(40)}, source: {sourceCommit: "5".repeat(40)}, "malformed owner": {ownerId: "not-a-number"}})) {
    const prior = await f.imported(options);
    assert.deepEqual(prior.covered, [], name); assert.equal(prior.invalidated.length, 1, name);
  }
  assert.equal((await f.imported()).covered.length, 3);
});

test("PR source head coverage is accepted and a different synthetic merge SHA is explicitly uncovered", async t => {
  const f = await repositoryFixture(t); await f.exported();
  assert.equal((await f.imported()).covered.length, 3);
  assert.equal((await f.imported({sourceCommit: "5".repeat(40)})).covered.length, 0);
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow, /permissions:\n  contents: read/);
});

test("strict public schema rejects private metadata and missing checks execute only their required commands", async t => {
  const f = await repositoryFixture(t), unsafe = checks(); unsafe[0].executions[0].original_environment.token = "synthetic-forbidden-secret";
  await assert.rejects(f.exported(async () => unsafe), /metadata/);
  assert.equal(await f.bare("for-each-ref"), "", "Rejected envelope reached the remote");
  const executed = [];
  await validateRelease({nativeEvidence: false, priorCoverage: {covered: [{command: requiredCommands[1], coverage: "EXACT_INPUT_EXECUTION"}], invalidated: []}, execute: async args => executed.push(args)});
  assert.deepEqual(executed, [requiredCommands[0], requiredCommands[2]]);
});

test("export verifies actual native originals and composes only independently assessed passing baseline plus repair", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-native-transport-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const execute = promisify(execFile), git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await mkdir(path.join(root, "Vault/docs"), {recursive: true}); await mkdir(path.join(root, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(root, "Vault/docs/CONSTITUTION.md"), "Synthetic constitution.\n"); await writeFile(path.join(root, "AGENTS.md"), "Synthetic policy.\n");
  await writeFile(path.join(root, ".agents/skills/oracle/SKILL.md"), "Synthetic isolated reviewer fixture.\n");
  await writeFile(path.join(root, ".gitignore"), "Vault/\ndist/\n"); await writeFile(path.join(root, "candidate.txt"), "Synthetic source before repair.\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({name: "synthetic-native-transport", type: "module", scripts: {build: "node synthetic-check.mjs build", test: "node synthetic-check.mjs test", "check:release": "node synthetic-check.mjs package"}}));
  await writeFile(path.join(root, "synthetic-check.mjs"), "import{mkdir,writeFile}from'node:fs/promises';if(process.argv[2]==='build'){await mkdir('dist/my-crm',{recursive:true});await writeFile('dist/my-crm/artifact.txt','synthetic artifact');}console.log('Synthetic original command ran');if(process.argv[2]==='test'&&process.env.SYNTHETIC_FAIL_NATIVE_CHECK)process.exitCode=1;\n");
  await mkdir(path.join(root, "tests"));
  // The repository's own required commands decide the fixture: the bootstrap
  // test-file list or a selected contract's category runner.
  if (requiredCommands.some(command => command[1] === "scripts/validation-contract.mjs")) {
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts/validation-contract.mjs"), "console.log('Synthetic original command ran');if(process.env.SYNTHETIC_FAIL_NATIVE_CHECK)process.exitCode=1;\n");
  }
  for (const filename of requiredCommands[1][1] === "--test" ? requiredCommands[1].slice(2) : []) {
    await writeFile(path.join(root, filename), "import test from 'node:test';import assert from 'node:assert/strict';test('synthetic native selected check',()=>assert.equal(Boolean(process.env.SYNTHETIC_FAIL_NATIVE_CHECK),false));\n");
  }
  await git("init", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid"); await git("add", "."); await git("commit", "-m", "Synthetic source baseline");
  const launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url)), env = {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", CODEX_SELECTED_REASONING_EFFORT: "high"};
  delete env.NODE_TEST_CONTEXT; // The fixture owns a real independent Node test runner.
  const capture = async (command, extra = {}) => {
    const names = (await git("ls-files")).split("\n"), args = [launcher, "validate", ...names.flatMap(name => ["--input", name]), "--environment", "SYNTHETIC_FAIL_NATIVE_CHECK", "--", ...command];
    let output; try {output = (await execute(process.execPath, args, {cwd: root, env: {...env, ...extra}})).stdout;} catch (error) {output = error.stdout;}
    const reference = output.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)?.[1]; assert.ok(reference, output);
    return {reference, record: JSON.parse(await readFile(reference.slice(1)))};
  };
  let originals = await Promise.all(requiredCommands.map(command => capture(command)));
  const store = path.join(root, ".git/oracle/technical-receipts"); await mkdir(store, {recursive: true});
  const admission = {technical_receipt_sha256: "9".repeat(64)};
  const receipt = async (proofs, coverage = [], extraEvidence = []) => {
    const sourceCommit = await git("rev-parse", "HEAD"), sourceTree = await git("rev-parse", "HEAD^{tree}");
    await writeFile(path.join(store, `${admission.technical_receipt_sha256}.json`), JSON.stringify({verdict: "APPROVED", review_status: "COMPLETE", candidate_commit: sourceCommit, reviewed_tree: sourceTree, receipt_sha256: admission.technical_receipt_sha256,
      input_binding: {authorities: proofs[0].record.review_provenance.before.inputs.authorities, validation: [...await Promise.all(proofs.map(proof => evidenceBinding(root, proof.reference))), ...extraEvidence]}, coverage}));
    return {root, sourceCommit, sourceTree, admission};
  };
  assert.equal((await collectNativeChecks(await receipt(originals))).length, 3);
  const failed = await capture(requiredCommands[1], {SYNTHETIC_FAIL_NATIVE_CHECK: "true"});
  assert.equal(failed.record.outcome, "FAILED", await readFile(failed.record.output_file, "utf8"));
  await assert.rejects(collectNativeChecks(await receipt([originals[0], failed, originals[2]])), /coverage missing/);
  const baseline = originals[1]; await writeFile(path.join(root, "candidate.txt"), "Synthetic repaired source.\n"); await git("add", "."); await git("commit", "-m", "Synthetic focused repair changelist");
  const focused = await capture([process.execPath, "synthetic-check.mjs", "focused"]);
  originals = [await capture(requiredCommands[0]), baseline, await capture(requiredCommands[2]), focused];
  const candidate = {source_commit: await git("rev-parse", "HEAD"), source_tree: await git("rev-parse", "HEAD^{tree}")};
  const manifestPath = path.join(root, "Vault/tmp/required-command-coverage.json"); await mkdir(path.dirname(manifestPath), {recursive: true});
  await writeFile(manifestPath, JSON.stringify({schema: "my-crm.required-command-coverage/v1", ...candidate, checks: [{command: requiredCommands[1], executions: [baseline.record.record_sha256, focused.record.record_sha256]}]}));
  const manifest = await evidenceBinding(root, `@${manifestPath}`);
  await assert.rejects(collectNativeChecks(await receipt(originals, [], [manifest])), /explicit exact-candidate independent assessment/);
  const coverage = [{path: "package.json", criteria: ["required-command-coverage"], evidence: [manifest.value]}];
  const composed = await collectNativeChecks(await receipt(originals, coverage, [manifest]));
  assert.equal(composed.find(check => JSON.stringify(check.command) === JSON.stringify(requiredCommands[1])).coverage, "BASELINE_PLUS_FOCUSED_REPAIR");
  const original = composed.find(check => check.coverage === "BASELINE_PLUS_FOCUSED_REPAIR").executions[0];
  assert.equal(original.input_sha256, bindingHash(baseline.record.before));
  assert.equal(original.record_sha256, baseline.record.record_sha256);
  assert.equal(original.output_sha256, baseline.record.output_sha256);
  // A synthetic legacy record retains its real original output/input hashes,
  // while deliberately representing unavailable historical custody/cwd facts.
  const privateInput = "Vault/tmp/original-input.txt", generatedGuide = "Vault/tmp/generated-guide.txt";
  await writeFile(path.join(root, privateInput), "Synthetic unchanged original private input.\n");
  await writeFile(path.join(root, generatedGuide), "Synthetic current generated navigation.\n");
  const legacyRecord = structuredClone(baseline.record); delete legacyRecord.execution_cwd; delete legacyRecord.output_custody; delete legacyRecord.recorder_environment;
  legacyRecord.before.files[privateInput] = gitBlobHash(await readFile(path.join(root, privateInput)));
  legacyRecord.before.files[generatedGuide] = gitBlobHash(Buffer.from("Synthetic previous generated navigation.\n"));
  legacyRecord.after = structuredClone(legacyRecord.before);
  legacyRecord.record_sha256 = validationDigest(legacyRecord);
  const legacyPath = path.join(root, ".git/oracle/validations", `${legacyRecord.record_sha256}.json`);
  await writeFile(legacyPath, `${JSON.stringify(legacyRecord)}\n`);
  const legacy = {reference: `@${legacyPath}`, record: legacyRecord};
  const [strict] = await readValidationProofs({root, directory: path.join(root, ".git/oracle"), validation: [await evidenceBinding(root, legacy.reference)]});
  assert.equal(strict.eligible, false); assert.equal(strict.original_eligible, false);
  const publicFiles = Object.fromEntries((await git("ls-tree", "-rz", candidate.source_tree)).split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t")).split(" ")[2]]));
  const current = {...publicFiles, ...Object.fromEntries(originals[0].record.review_provenance.before.inputs.authorities.map(item => [item.path, item.sha256]))};
  const comparisons = await historicalInputComparisons({root, record: legacyRecord, current});
  assert.equal(comparisons.find(item => item.path === privateInput).changed, false);
  assert.equal(comparisons.find(item => item.path === privateInput).current_state, "PRIVATE_INPUT_BYTES");
  const changed = comparisons.filter(item => item.changed);
  const qualified = {schema: "my-crm.required-command-coverage/v1", ...candidate, checks: [{command: requiredCommands[1], executions: [legacyRecord.record_sha256, focused.record.record_sha256], qualified_executions: [{record_sha256: legacyRecord.record_sha256,
    original_scope_sha256: bindingHash(legacyRecord.before), original_output_sha256: legacyRecord.output_sha256,
    accepted_facts: ["The original required command passed with retained input and output hashes; current repair closure was independently assessed."],
    limitations: ["Original execution cwd and transitive output custody are unknown and remain unclaimed."],
    affected_dependencies: changed.map(item => ({path: item.path, current_hash: item.current_hash, current_state: item.current_state,
      disposition: item.path === generatedGuide ? "NON_EXECUTION_INPUT" : "EXECUTION_COVERED",
      ...(item.path === generatedGuide ? {reason: "Generated navigation is outside the declared synthetic check command closure.", evidence: ["The check imports only node:fs/promises and reads no guide."]} : {})})), repair_executions: [focused.record.record_sha256]}]}]};
  const qualifiedPath = path.join(root, "Vault/tmp/qualified-historical-coverage.json");
  await writeFile(qualifiedPath, JSON.stringify(qualified)); const qualifiedEvidence = await evidenceBinding(root, `@${qualifiedPath}`);
  const qualifiedProofs = [originals[0], legacy, originals[2], focused];
  const qualificationCoverage = [{path: "package.json", criteria: ["required-command-coverage", "qualified-historical-execution", "qualified-dependency-disposition"], evidence: [qualifiedEvidence.value]}];
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, [{...qualificationCoverage[0], criteria: ["required-command-coverage"]}], [qualifiedEvidence])), /independent qualification/);
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, [{...qualificationCoverage[0], criteria: ["required-command-coverage", "qualified-historical-execution"]}], [qualifiedEvidence])), /complete affected dependency/);
  const qualifiedChecks = await collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [qualifiedEvidence]));
  const historicalExecution = qualifiedChecks.find(check => check.coverage === "BASELINE_PLUS_FOCUSED_REPAIR").executions[0];
  assert.equal(historicalExecution.qualification, "INDEPENDENTLY_QUALIFIED_HISTORICAL_PASS"); assert.equal(historicalExecution.original_environment, null);
  assert.equal(historicalExecution.record_sha256, legacyRecord.record_sha256); assert.equal(strict.eligible, false);
  assert.doesNotMatch(JSON.stringify(qualifiedChecks), /Vault|generated-guide|original-input|Synthetic previous|Synthetic current/);
  await writeFile(path.join(root, privateInput), "Synthetic genuine uncovered command-input change.\n");
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [qualifiedEvidence])), /complete affected dependency/);
  await writeFile(path.join(root, privateInput), "Synthetic unchanged original private input.\n");
  qualified.checks[0].qualified_executions[0].affected_dependencies.pop();
  await writeFile(qualifiedPath, JSON.stringify(qualified));
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [await evidenceBinding(root, `@${qualifiedPath}`)])), /complete affected dependency/);
  qualified.checks[0].executions[0] = failed.record.record_sha256;
  await writeFile(qualifiedPath, JSON.stringify(qualified));
  await assert.rejects(collectNativeChecks(await receipt([originals[0], failed, originals[2], focused], qualificationCoverage, [await evidenceBinding(root, `@${qualifiedPath}`)])), /intact original passing/);
  const historicalPath = path.join(root, "Vault/tmp/required-command-coverage-original.json");
  const source = baseline.record.review_provenance.before.base_commit;
  await writeFile(historicalPath, JSON.stringify({schema: "my-crm.required-command-coverage/v1", source_commit: source, source_tree: await git("rev-parse", `${source}^{tree}`), checks: []}));
  const historical = await evidenceBinding(root, `@${historicalPath}`);
  assert.equal((await collectNativeChecks(await receipt(originals, coverage, [manifest, historical]))).length, 3);
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [historical])), /coverage missing/);
  await writeFile(historicalPath, "{}\n");
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [manifest, historical])), /manifest changed/);
  await writeFile(baseline.record.output_file, "Synthetic altered original output\n");
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [manifest])), /output is missing or changed/);
});

test("historical identity audit distinguishes source/private absence and refuses unavailable custody", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-historical-inputs-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  await promisify(execFile)("git", ["init", "-b", "main"], {cwd: root});
  await writeFile(path.join(root, ".gitignore"), "Vault/\n"); await mkdir(path.join(root, "Vault"));
  await writeFile(path.join(root, "Vault/actual"), "Synthetic private bytes");
  await symlink("actual", path.join(root, "Vault/link"));
  const record = {before: {files: {"deleted.mjs": "a".repeat(40), "Vault/missing": "b".repeat(40), "Vault/actual": gitBlobHash(Buffer.from("Synthetic private bytes")), "Vault/link": "c".repeat(40), "/outside-owner.txt": "d".repeat(64)}}};
  const compared = await historicalInputComparisons({root, record, current: {}});
  assert.deepEqual(compared.map(item => [item.path, item.current_state]), [["/outside-owner.txt", "UNAVAILABLE"], ["Vault/actual", "PRIVATE_INPUT_BYTES"], ["Vault/link", "UNAVAILABLE"], ["Vault/missing", "PRIVATE_INPUT_ABSENT"], ["deleted.mjs", "SOURCE_TREE_ABSENT"]]);
  assert.equal(compared.find(item => item.path === "Vault/actual").changed, false);
});

test("native intake binds exact candidate and actual original commands without granting assessment", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-intake-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const filename = path.join(root, "Vault/tmp/command-coverage.json"); await mkdir(path.dirname(filename), {recursive: true});
  const proofs = requiredCommands.map((command,index) => ({record: {record_sha256: String(index+1).repeat(64), command, outcome: "PASSED", exit_code: 0, signal: null, error: null, before: {files: {"source.mjs":"original"}}, after: {files: {"source.mjs":"original"}}}}));
  const manifest = {schema:"my-crm.required-command-coverage/v1", source_commit: source, source_tree:tree, checks:requiredCommands.map((command,index)=>({command,executions:[proofs[index].record.record_sha256]}))};
  const intake = async () => {await writeFile(filename,JSON.stringify(manifest));return nativeCoverageIntake({root,sourceCommit:source,sourceTree:tree,validation:[await evidenceBinding(root,`@${filename}`)],proofs});};
  const ready = await intake(); assert.equal(ready.status,"READY_FOR_INDEPENDENT_ASSESSMENT"); assert.equal(ready.grants_approval,false); assert.equal(ready.grants_command_coverage,false);
  manifest.source_tree="c".repeat(40); const missing=await intake(); assert.equal(missing.status,"INCOMPLETE"); assert.equal((await intake()).identity_sha256,missing.identity_sha256);
  manifest.source_tree=tree; proofs[1].record.outcome="FAILED"; assert.equal((await intake()).status,"INCOMPLETE");
  proofs[1].record.outcome="PASSED"; proofs[1].record.after.files["source.mjs"]="changed"; assert.equal((await intake()).status,"INCOMPLETE");
});
