import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, writeFile, rm, chmod, cp, readdir, realpath, rename} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";
import {captureInputs, assertInputsMatch, withOracleRun, preparedEvidence} from "../scripts/oracle-inputs.mjs";
import {receiptSha256, sha256} from "../scripts/oracle-review.mjs";
import {seriesDigest} from "../scripts/oracle-series.mjs";
import {readValidationProofs, inheritNativeEvidence} from "../scripts/oracle-validation.mjs";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url));
async function command(cwd, args, env = {}) { return execute(process.execPath, [launcher, ...args], {cwd, env: {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", ...env}}); }
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-oracle-test-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const bin = path.join(root, "bin");
  const repo = path.join(root, "repo");
  await mkdir(bin); await mkdir(repo);
  await mkdir(path.join(repo, "Vault/docs"), {recursive: true});
  await mkdir(path.join(repo, "Vault/tmp"), {recursive: true});
  await mkdir(path.join(repo, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(repo, "AGENTS.md"), "Synthetic test policy.\n");
  await writeFile(path.join(repo, ".agents/skills/oracle/SKILL.md"), "Synthetic independent approver fixture.\n");
  await writeFile(path.join(repo, "Vault/docs/CONSTITUTION.md"), "Synthetic test constitution.\n");
  await writeFile(path.join(repo, ".gitignore"), "Vault/\n");
  await writeFile(path.join(repo, "candidate.txt"), "before\n");
  const fake = path.join(bin, "codex");
  await writeFile(fake, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args=process.argv.slice(2);
if(process.env.ORACLE_CAPTURE_ARGS) fs.writeFileSync(process.env.ORACLE_CAPTURE_ARGS,JSON.stringify(args));
if(args[args.indexOf('--sandbox')+1]!=='danger-full-access') throw new Error('Oracle must execute natively');
if(!args.some(arg=>arg.startsWith('developer_instructions=') && arg.includes('independent My CRM project-local Oracle approver'))) throw new Error('Trusted reviewer role missing');
const out=args[args.indexOf('--output-last-message')+1];
const proposal=!args.includes('--output-schema');
if(!proposal && JSON.stringify(JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]))).includes('"uniqueItems"')) throw new Error('Strict response format does not support uniqueItems');
if(!proposal && process.env.ORACLE_READY) fs.writeFileSync(process.env.ORACLE_READY,'ready');
if(!proposal && process.env.ORACLE_MUTATE) fs.writeFileSync(process.env.ORACLE_MUTATE,'changed during review');
const emit=()=>{
  const evidence=proposal?null:JSON.parse(fs.readFileSync(path.join(path.dirname(out),'evidence.json')));
  const response={verdict:process.env.ORACLE_INCOMPLETE?null:'APPROVED',review_status:process.env.ORACLE_INCOMPLETE?'INCOMPLETE':'COMPLETE',api_version_assessment:{impact:'NONE',request_kind:'NOT_REQUIRED',requested_change:null,request_quote:null,request_evidence:null},summary:'Synthetic candidate assessed.',authentication_impact:false,owner_approval_status:'NOT_REQUIRED',warning:null,findings:[],unreviewed:process.env.ORACLE_INCOMPLETE?['synthetic remaining scope']:[],reused_coverage:[],reused_validations:[],validations:[],resolutions:[],synthesis:null,coverage:(evidence?.review_context.required_paths??[]).map(name=>({path:name,dependencies:[name],dependency_rationale:'Synthetic isolated dependency.',assessment:'Synthetic path assessed.'}))};
  const proof=evidence?.review_context.validation_proofs.find(item=>item.eligible);
  if(proof && !process.env.ORACLE_OMIT_VALIDATION) response.validations=[{id:'native-check',evidence:proof.evidence,command:JSON.stringify(proof.record.command),dependencies:evidence.staged_files,dependency_rationale:'Synthetic complete candidate closure.',assessment:'Native passing execution and output checked.'}];
  fs.writeFileSync(out,proposal?'Synthetic proposal.\\nAPI_VERSION_ASSESSMENT={"impact":"NONE","request_kind":"NOT_REQUIRED","requested_change":null,"request_quote":null,"request_evidence":null}\\nAUTHENTICATION_IMPACT=NONE\\nOWNER_APPROVAL_STATUS=NOT_REQUIRED\\nORACLE_VERDICT=APPROVED\\n':process.env.ORACLE_MALFORMED?'{}':JSON.stringify(response));
};
if(!proposal && process.env.ORACLE_DELAY) setTimeout(emit,Number(process.env.ORACLE_DELAY)); else emit();
`);
  await chmod(fake, 0o700);
  const git = async (...args) => (await execute("git", args, {cwd: repo})).stdout.trim();
  await git("init", "-q"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture");
  const env = {PATH: `${bin}${path.delimiter}${process.env.PATH}`};
  const prepare = async (cwd = repo) => {
    await command(cwd, ["proposal", "Problem: synthetic. Cause: synthetic. Recommended change: synthetic."], env);
    await writeFile(path.join(cwd, "candidate.txt"), "after\n");
    await execute("git", ["add", "candidate.txt"], {cwd});
  };
  return {repo, root, env, git, prepare};
}

async function waitFor(filename) {
  for (let count = 0; count < 100; count++) {
    try { await readFile(filename); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic reviewer did not start");
}

test("spawned CLI transports complete review execution policy as trusted developer instructions", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  for (const [index, args] of [["proposal", ["proposal", "Synthetic developer transport scope"]], ["initial", ["review"]], ["followup", ["review"]]]) {
    const captured = path.join(root, `developer-${index}.json`);
    await command(repo, args, {...env, ORACLE_CAPTURE_ARGS: captured});
    const argv = JSON.parse(await readFile(captured, "utf8"));
    assert.equal(argv[0], "-c");
    assert.ok(argv[1].startsWith("developer_instructions="));
    const developer = JSON.parse(argv[1].slice("developer_instructions=".length));
    for (const clause of ["initial assessment completes the full relevant scope", "actual source/control delta", "Mechanical guard invalidation", "new re-attestation of sealed unchanged facts", "FAILED or ERROR", "strict-ineligible native records", "current green aggregate", "outside the preverified subset", "Before any command", "concrete changed consumed dependency", "include that reason in the result", "stable IDs", "origin missed", "INCOMPLETE", "fresh independent whole-candidate verdict"]) assert.ok(developer.includes(clause), `${index}: missing trusted clause ${clause}`);
    if (index !== "proposal") assert.ok(!argv.at(-1).includes("Read AGENTS.md, Vault/docs/CONSTITUTION.md, and .agents/skills/oracle/SKILL.md completely"));
  }
});

test("complete bindings reject base, tree, canonical authority, evidence, owner, and proposal drift", async (t) => {
  const {repo} = await fixture(t);
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "passed");
  await writeFile(path.join(repo, "Vault/docs/status.md"), "original status authority");
  const options = {root: repo, base: "base-a", tree: "tree-a", complete: true, validationEvidence: ["@Vault/tmp/check.log"], ownerApprovalEvidence: "exact synthetic approval", proposal: {approved: true}};
  const before = await captureInputs(options);
  for (const change of [{base: "base-b"}, {tree: "tree-b"}, {ownerApprovalEvidence: "other approval"}, {proposal: {approved: false}}]) {
    assert.throws(() => assertInputsMatch(before, {...before, ...Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value]))}), /drifted/);
    await assert.rejects(async () => assertInputsMatch(before, await captureInputs({...options, ...change})), /drifted/);
  }
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "changed evidence");
  await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "passed");
  await writeFile(path.join(repo, "Vault/docs/status.md"), "changed unrelated status authority");
  await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
  await writeFile(path.join(repo, "Vault/docs/status.md"), "original status authority");
  await writeFile(path.join(repo, "Vault/docs/CONSTITUTION.md"), "changed authority");
  await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
});

test("declared external governing inputs bind proposal, review, execution and receipt custody without loading siblings", async (t) => {
  const {repo, root, env, prepare} = await fixture(t);
  const parentPolicy = path.join(root, "AGENTS.md");
  const family = path.join(root, "Vault/docs/architecture/bos-product-family.md");
  const parentOracle = path.join(root, "tools/projects_oracle.py");
  await mkdir(path.dirname(family), {recursive: true}); await mkdir(path.dirname(parentOracle), {recursive: true});
  await writeFile(parentPolicy, "Synthetic inherited policy.");
  await writeFile(family, "Synthetic declared family authority.");
  await writeFile(path.join(repo, "AGENTS.md"), `Synthetic local policy. Family: ${family}. Oracle: ${parentOracle}.`);
  const options = {root: repo, base: "synthetic-base", complete: true};
  const initial = await captureInputs(options);
  const external = initial.authorities.filter((item) => item.external);
  assert.deepEqual(external.map((item) => item.path), [parentPolicy, family, parentOracle]);
  assert.equal(external.find((item) => item.path === parentOracle).sha256, null);
  assert.deepEqual(initial.owner, null); assert.deepEqual(initial.validation, []);
  const proposalInputs = await captureInputs({...options, complete: false});
  assert.deepEqual(proposalInputs.authorities.filter((item) => item.external), external);
  await writeFile(parentOracle, "Synthetic declared parent tool; never executed.");
  await assert.rejects(async () => assertInputsMatch(initial, await captureInputs(options)), /drifted/);
  for (const filename of [parentPolicy, family, parentOracle]) {
    const original = await readFile(filename);
    const before = await captureInputs(options);
    await writeFile(filename, "Changed governing input.");
    await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
    await rm(filename);
    assert.equal((await captureInputs(options)).authorities.find((item) => item.path === filename).sha256, null);
    await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
    await writeFile(filename, original);
    assertInputsMatch(before, await captureInputs(options));
  }
  await execute("git", ["add", "AGENTS.md"], {cwd: repo});
  await prepare();
  const drift = await command(repo, ["validate", "--", process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(family)}, 'Changed during native execution.')`], env).catch((error) => error);
  assert.match(drift.stdout, /ORACLE_VALIDATION=INPUT_DRIFT/);
  assert.equal(drift.code, 1);
  await writeFile(family, "Synthetic declared family authority.");
  await command(repo, ["review"], env); await command(repo, ["verify-index"], env);
  await writeFile(family, "Changed after approval.");
  await assert.rejects(command(repo, ["verify-proposal"], env), /drifted/);
  await assert.rejects(command(repo, ["verify-index"], env), /drifted/);
  await writeFile(family, "Synthetic declared family authority.");
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_MUTATE: family}), /drifted/);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
});

test("same checkout runs serialize while separate checkout runs proceed independently", async (t) => {
  const {root} = await fixture(t);
  const directory = path.join(root, "state-a");
  let release; const blocker = new Promise((resolve) => { release = resolve; });
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const first = withOracleRun(directory, async () => { started(); await blocker; });
  await ready;
  await assert.rejects(withOracleRun(directory, async () => {}), /busy/);
  await withOracleRun(path.join(root, "state-b"), async () => {});
  release(); await first;
  await withOracleRun(directory, async () => {});
});

test("deterministic preparation reuses identical content and rejects corrupt cached payload", async (t) => {
  const {root} = await fixture(t); let calls = 0;
  const prepare = async () => ({diff: `generated-${++calls}`});
  assert.equal((await preparedEvidence(root, {input: "a"}, prepare)).reused, false);
  assert.equal((await preparedEvidence(root, {input: "a"}, prepare)).reused, true);
  assert.equal((await preparedEvidence(root, {input: "b"}, prepare)).reused, false);
  const cached = (await readdir(path.join(root, "preparation")))[0];
  const filename = path.join(root, "preparation", cached);
  const payload = JSON.parse(await readFile(filename)); payload.payload.diff = "corrupt";
  await writeFile(filename, JSON.stringify(payload));
  const input = payload.key; // Only the matching content-key entry can be reused.
  assert.ok(input);
  const a = await preparedEvidence(root, {input: "a"}, prepare);
  const b = await preparedEvidence(root, {input: "b"}, prepare);
  assert.equal(Number(!a.reused) + Number(!b.reused), 1);
  const missingPayload = JSON.parse(await readFile(filename)); delete missingPayload.payload;
  await writeFile(filename, JSON.stringify(missingPayload));
  const recoveredA = await preparedEvidence(root, {input: "a"}, prepare);
  const recoveredB = await preparedEvidence(root, {input: "b"}, prepare);
  assert.equal(Number(!recoveredA.reused) + Number(!recoveredB.reused), 1);
});

test("live gates bind all inputs, emit owner verifier JSON, and retain phase diagnostics", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  const proposal = JSON.parse((await command(repo, ["verify-proposal"], env)).stdout);
  assert.equal(proposal.verdict, "APPROVED"); assert.match(proposal.proposal_sha256, /^[a-f0-9]{64}$/);
  await writeFile(path.join(repo, "Vault/tmp/validation.log"), "synthetic pass");
  await command(repo, ["review", "--validation", "@Vault/tmp/validation.log"], env);
  await command(repo, ["verify-index"], env);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.equal(receipt.schema, "my-crm.oracle-approval/v2");
  assert.equal(receipt.reviewer.model, "synthetic-test-model");
  assert.equal(receipt.reviewer.sandbox, "danger-full-access");
  assert.equal(receipt.reviewer.ephemeral, true);
  assert.equal(receipt.reviewer.ignore_user_config, true);
  assert.match(receipt.reviewer.response_schema_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.reviewer.model_helper_sha256, /^[a-f0-9]{64}$/);
  await command(repo, ["verify-index"], {...env, CODEX_SELECTED_MODEL: "another-synthetic-task-model"});
  const runs = await readdir(path.join(repo, ".git/oracle/runs"));
  const contents = await Promise.all(runs.map(async (run) => JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "timings.json")))));
  assert.ok(contents.some((times) => times.precheck_ms >= 0 && times.preparation_ms >= 0 && times.reviewer_ms >= 0 && times.postcheck_ms >= 0));
  for (const run of runs) {
    let evidence;
    try { evidence = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "evidence.json"))); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    assert.equal(evidence.reviewer.model, receipt.reviewer.model);
    assert.equal(evidence.reviewer_metadata_sha256, receipt.reviewer_metadata_sha256);
    assert.deepEqual(JSON.parse(await readFile(evidence.reviewer_metadata_file)), receipt.reviewer);
  }
  const approvalFile = path.join(repo, ".git/oracle/approval.json");
  const changedMode = {...receipt, reviewer: {...receipt.reviewer, sandbox: "read-only"}};
  await writeFile(approvalFile, JSON.stringify(changedMode));
  await assert.rejects(command(repo, ["verify-index"], env), /digest/);
  // Existing content-bound read-only receipts retain their historical meaning.
  changedMode.reviewer_metadata_sha256 = sha256(`${JSON.stringify(changedMode.reviewer, null, 2)}\n`);
  changedMode.receipt_sha256 = receiptSha256(changedMode);
  await writeFile(approvalFile, JSON.stringify(changedMode));
  await command(repo, ["verify-index"], env);
  const unsupportedMode = {...changedMode, reviewer: {...changedMode.reviewer, sandbox: "workspace-write"}};
  unsupportedMode.reviewer_metadata_sha256 = sha256(`${JSON.stringify(unsupportedMode.reviewer, null, 2)}\n`);
  unsupportedMode.receipt_sha256 = receiptSha256(unsupportedMode);
  await writeFile(approvalFile, JSON.stringify(unsupportedMode));
  await assert.rejects(command(repo, ["verify-index"], env), /provenance/);
  await writeFile(approvalFile, JSON.stringify(receipt));
  await writeFile(path.join(repo, "Vault/tmp/validation.log"), "changed evidence");
  await assert.rejects(command(repo, ["verify-index"], env), /drifted/);
});

test("malformed responses and mid-review authority drift fail closed and invalidate prior receipt", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  await command(repo, ["review"], env);
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_MALFORMED: "1"}), /invalid verdict/);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_MUTATE: path.join(repo, "Vault/docs/CONSTITUTION.md")}), /drifted/);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
});

test("admitted malformed review arguments invalidate active completion before parsing", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  await command(repo, ["review"], env);
  const approval = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const history = path.join(repo, ".git/oracle/series", `${approval.base_commit}.json`);
  const original = await readFile(history);
  await assert.rejects(command(repo, ["review", "--validation"], env), /ORACLE_PROCESS=ERROR --validation requires/);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  await assert.rejects(command(repo, ["verify-index"], env), /ORACLE_PROCESS=ERROR/);
  assert.deepEqual(await readFile(history), original);
  const runs = await readdir(path.join(repo, ".git/oracle/runs"));
  const outcomes = await Promise.all(runs.map(async (run) => JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "outcome.json")))));
  assert.ok(outcomes.some((outcome) => outcome.outcome === "ERROR" && !outcome.reviewer_invoked && outcome.error.message.includes("--validation requires")));
});

test("admitted diagnostic setup failure invalidates active completion and preserves history", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  await command(repo, ["review"], env);
  const approval = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const history = path.join(repo, ".git/oracle/series", `${approval.base_commit}.json`);
  const original = await readFile(history);
  const runs = path.join(repo, ".git/oracle/runs");
  await rename(runs, `${runs}-retained`);
  await writeFile(runs, "Synthetic unavailable diagnostic directory.\n");
  await assert.rejects(command(repo, ["review"], env), /ORACLE_PROCESS=ERROR/);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  await assert.rejects(command(repo, ["verify-index"], env), /ORACLE_PROCESS=ERROR/);
  assert.deepEqual(await readFile(history), original);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/run.lock/owner.json")), {code: "ENOENT"});
});

test("incomplete assessment retains a resumable round and never publishes approval", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_INCOMPLETE: "1"}), (error) => {
    assert.match(error.stdout, /ORACLE_REVIEW_STATUS=INCOMPLETE/);
    assert.doesNotMatch(error.stdout, /ORACLE_VERDICT=REJECTED/);
    return true;
  });
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  const base = await git("rev-parse", "HEAD");
  const filename = path.join(repo, ".git/oracle/series", `${base}.json`);
  const partial = JSON.parse(await readFile(filename));
  assert.equal(partial.rounds.at(-1).review_status, "INCOMPLETE");
  assert.equal(partial.rounds.at(-1).verdict, null);
  const resumed = await command(repo, ["review"], env);
  assert.match(resumed.stdout, /ORACLE_REVIEW_STATUS=COMPLETE/);
  const completed = JSON.parse(await readFile(filename));
  assert.equal(completed.rounds.at(-1).mode, "resume");
  await command(repo, ["verify-index"], env);
  completed.rounds[0].response.summary = "tampered";
  await writeFile(filename, JSON.stringify(completed));
  await assert.rejects(command(repo, ["verify-index"], env), /history is malformed or changed/);
});

test("native validation captures original command and inputs, supports proof reuse, and rejects changed output", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  const reuseEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
  const captured = await command(repo, ["validate", "--", process.execPath, "-e", "process.stdout.write('synthetic pass')"], reuseEnv);
  assert.match(captured.stdout, /ORACLE_VALIDATION=PASSED/);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const filename = evidence.slice(1);
  const record = JSON.parse(await readFile(filename));
  assert.equal(record.outcome, "PASSED");
  assert.deepEqual(record.before, record.after);
  assert.equal(record.exit_code, 0);
  await writeFile(path.join(repo, "Vault/tmp/legacy.log"), "Synthetic earlier unstructured evidence.");
  await command(repo, ["review", "--validation", evidence, "--validation", "@Vault/tmp/legacy.log"], reuseEnv);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
  assert.equal(series.rounds.at(-1).validations[0].execution_record_sha256, record.record_sha256);
  assert.deepEqual(series.rounds.at(-1).response.validations, []);
  const beforeRecords = await readdir(path.dirname(filename));
  await command(repo, ["review"], reuseEnv);
  const inheritedReceipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.deepEqual(inheritedReceipt.requested_validation_evidence, []);
  assert.deepEqual(inheritedReceipt.inherited_validation_evidence, [evidence]);
  assert.deepEqual(inheritedReceipt.validation_evidence, [evidence]);
  assert.deepEqual(await readdir(path.dirname(filename)), beforeRecords); // The command was not executed again.
  const proofs = await readValidationProofs({root: repo, directory: path.join(repo, ".git/oracle"), validation: [{kind: "file", value: evidence, sha256: sha256(await readFile(filename))}]});
  assert.equal(proofs[0].eligible, true);
  await command(repo, ["verify-index"], {...env, PATH: `${env.PATH}${path.delimiter}/synthetic-extra-bin`, NODE_ENV: "synthetic-hook-context"});
  await writeFile(record.output_file, "tampered output");
  await assert.rejects(readValidationProofs({root: repo, directory: path.join(repo, ".git/oracle"), validation: [{kind: "file", value: evidence, sha256: sha256(await readFile(filename))}]}), /output is missing or changed/);
  await assert.rejects(command(repo, ["verify-index"], env), /output is missing or changed/);
  const invalid = await inheritNativeEvidence({root: repo, directory: path.join(repo, ".git/oracle"), base: receipt.base_commit, requestedEvidence: []});
  assert.deepEqual(invalid.evidence, []);
  assert.match(invalid.invalidated[0].reason, /output is missing or changed/);
});

test("automatic native inheritance reports missing or tampered originals and never fabricates a passing observation", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  const captured = await command(repo, ["validate", "--", process.execPath, "-e", "process.stdout.write('synthetic pass')"], env);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const filename = evidence.slice(1);
  const original = await readFile(filename);
  await command(repo, ["review", "--validation", evidence], env);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const options = {root: repo, directory: path.join(repo, ".git/oracle"), base: receipt.base_commit, requestedEvidence: []};
  const historyFile = path.join(options.directory, "series", `${receipt.base_commit}.json`);
  const history = JSON.parse(await readFile(historyFile));
  history.rounds.push({...history.rounds.at(-1), round: history.rounds.length + 1, review_status: "INCOMPLETE", verdict: null, coverage: [], validations: [], response: null, error: {message: "Synthetic legacy ERROR lost carried observations."}});
  history.sha256 = seriesDigest(history); await writeFile(historyFile, JSON.stringify(history));
  assert.deepEqual((await inheritNativeEvidence(options)).evidence, [evidence]);
  await rm(filename);
  const missing = await inheritNativeEvidence(options);
  assert.deepEqual(missing.evidence, []);
  assert.match(missing.invalidated[0].reason, /missing/);
  await writeFile(filename, `${original.toString("utf8")} altered`);
  const tampered = await inheritNativeEvidence(options);
  assert.deepEqual(tampered.evidence, []);
  assert.match(tampered.invalidated[0].reason, /content hash changed/);
  await writeFile(filename, original);
  const restored = await inheritNativeEvidence(options);
  assert.deepEqual(restored.evidence, [evidence]);
});

test("native validation cannot turn a failed command or input drift into a passing witness", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  for (const script of ["process.exit(3)", "require('node:fs').writeFileSync('candidate.txt','changed during validation')"]) {
    let output;
    await assert.rejects(command(repo, ["validate", "--", process.execPath, "-e", script], env), (error) => { output = error.stdout; return true; });
    const filename = output.match(/ORACLE_VALIDATION_EVIDENCE=@(.+)/)[1];
    const record = JSON.parse(await readFile(filename));
    assert.notEqual(record.outcome, "PASSED");
    if (script.startsWith("process.exit")) assert.equal(record.exit_code, 3);
    else assert.equal(record.outcome, "INPUT_DRIFT");
  }
});

test("cancellation terminates child review and releases lock without approval", async (t) => {
  const {repo, env, prepare, root} = await fixture(t); await prepare();
  const ready = path.join(root, "ready");
  const child = spawn(process.execPath, [launcher, "review"], {cwd: repo, env: {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", ...env, ORACLE_READY: ready, ORACLE_DELAY: "30000"}, stdio: ["ignore", "pipe", "pipe"]});
  const ended = new Promise((resolve) => child.once("close", resolve));
  await waitFor(ready); child.kill("SIGTERM");
  assert.equal(await ended, 1);
  const runsDirectory = path.join(repo, ".git/oracle/runs");
  const runs = await readdir(runsDirectory);
  const cancelled = (await Promise.all(runs.map(async (run) => ({
    outcome: JSON.parse(await readFile(path.join(runsDirectory, run, "outcome.json"))),
    run,
  })))).find(({outcome}) => outcome.error?.message.includes("cancelled"));
  assert.ok(cancelled);
  assert.equal(cancelled.outcome.outcome, "ERROR");
  assert.equal(cancelled.outcome.reviewer_invoked, true);
  const processRecord = JSON.parse(await readFile(path.join(runsDirectory, cancelled.run, "process.json")));
  assert.equal(processRecord.interrupted, true);
  assert.equal(processRecord.signal, "SIGTERM");
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  await command(repo, ["review"], env);
});

test("concurrent independent repository reviews publish separate records and leave primary untouched", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t);
  const linked = path.join(root, "independent"); await execute("git", ["clone", "--local", repo, linked]);
  await cp(path.join(repo, "Vault"), path.join(linked, "Vault"), {recursive: true});
  await Promise.all([prepare(repo), prepare(linked)]);
  await Promise.all([command(repo, ["review"], env), command(linked, ["review"], env)]);
  const localGit = (await execute("git", ["rev-parse", "--absolute-git-dir"], {cwd: linked})).stdout.trim();
  const primary = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const secondary = JSON.parse(await readFile(path.join(localGit, "oracle/approval.json")));
  assert.equal(primary.schema, "my-crm.oracle-approval/v2"); assert.equal(secondary.schema, "my-crm.oracle-approval/v2");
  assert.notEqual(path.join(repo, ".git"), localGit);
  await command(linked, ["review"], env);
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"))), primary);
});


test("run telemetry distinguishes approved, rejected and failed phases without inventing reviewer timing", async (t) => {
  const {root} = await fixture(t);
  const directory = path.join(root, "telemetry");
  for (const scenario of ["APPROVED", "REJECTED", "precheck", "reviewer"]) {
    const action = async ({phase}) => {
      await phase("precheck_ms", async () => { if (scenario === "precheck") throw new Error("synthetic precheck failure"); });
      await phase("reviewer_ms", async () => { if (scenario === "reviewer") throw new Error("synthetic process failure"); });
      return {verdict: scenario};
    };
    if (["precheck", "reviewer"].includes(scenario)) await assert.rejects(withOracleRun(directory, action, {kind: "review"}), /synthetic/);
    else await withOracleRun(directory, action, {kind: "review"});
  }
  const records = await Promise.all((await readdir(path.join(directory, "runs"))).map(async (run) => ({
    timings: JSON.parse(await readFile(path.join(directory, "runs", run, "timings.json"))),
    outcome: JSON.parse(await readFile(path.join(directory, "runs", run, "outcome.json"))),
  })));
  assert.deepEqual(records.map(({outcome}) => outcome.outcome).sort(), ["APPROVED", "ERROR", "ERROR", "REJECTED"]);
  for (const {timings, outcome} of records) {
    assert.ok(timings.total_ms >= timings.precheck_ms);
    assert.ok(Date.parse(outcome.finished_at) >= Date.parse(outcome.started_at));
    assert.equal(outcome.kind, "review");
    if (outcome.error?.message.includes("precheck")) {
      assert.equal(outcome.reviewer_invoked, false);
      assert.equal(timings.reviewer_ms, undefined);
    } else assert.ok(timings.reviewer_ms >= 0);
  }
});

test("actual rejected preflight retains timing and outcome while reviewer stays unstarted", async (t) => {
  const {repo, env} = await fixture(t);
  await assert.rejects(command(repo, ["review"], env));
  const [run] = await readdir(path.join(repo, ".git/oracle/runs"));
  const timings = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "timings.json")));
  const outcome = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "outcome.json")));
  assert.ok(timings.precheck_ms >= 0);
  assert.equal(timings.reviewer_ms, undefined);
  assert.equal(outcome.outcome, "ERROR");
  assert.equal(outcome.reviewer_invoked, false);
});

test("focused native capture retains proof across unrelated staging and source movement", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  const reuseEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
  const script = "require('node:fs').writeFileSync('unrelated.txt','unrelated staging'); require('node:child_process').execFileSync('git',['add','unrelated.txt']); process.stdout.write('selected check passed');";
  const captured = await command(repo, ["validate", "--input", "candidate.txt", "--", process.execPath, "-e", script], reuseEnv);
  assert.match(captured.stdout, /ORACLE_VALIDATION=PASSED/);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const record = JSON.parse(await readFile(evidence.slice(1)));
  assert.equal(record.before.scope, "declared-inputs-v2"); assert.equal(record.before.tree, null);
  assert.equal(record.review_provenance.before.base_commit, await git("rev-parse", "HEAD"));
  assert.deepEqual(record.before, record.after); assert.ok(!Object.hasOwn(record.before.files, "unrelated.txt"));
  await command(repo, ["review", "--validation", evidence], reuseEnv);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
  assert.equal(series.rounds.at(-1).validations[0].execution_record_sha256, record.record_sha256);
  await command(repo, ["review"], reuseEnv);
  const inherited = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
  assert.equal(inherited.rounds.at(-1).validations[0].execution_record_sha256, record.record_sha256);
  await writeFile(path.join(repo, "candidate.txt"), "selected drift"); await git("add", "candidate.txt");
  await command(repo, ["review"], reuseEnv);
  const changed = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
  assert.equal(changed.rounds.at(-1).validations.length, 0);
});

test("scoped command observations separate review provenance and bind selected execution facts", async (t) => {
  for (const change of ["parent-authority", "base-and-candidate", "selected-source", "selected-authority", "selected-index", "environment"]) {
    const {repo, root, env, prepare, git} = await fixture(t); await prepare();
    const runEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
    const selected = ["--input", "candidate.txt", ...(change === "selected-authority" ? ["--input", "AGENTS.md"] : [])];
    const captured = await command(repo, ["validate", ...selected, "--", process.execPath, "-e", "process.stdout.write('synthetic scoped pass')"], runEnv);
    const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
    const filename = evidence.slice(1), original = await readFile(filename), record = JSON.parse(original);
    assert.equal(record.before.scope, "declared-inputs-v2");
    assert.deepEqual(Object.keys(record.before.files).sort(), ["candidate.txt", "package-lock.json", "package.json", ...(change === "selected-authority" ? ["AGENTS.md"] : [])].sort());
    await command(repo, ["review", "--validation", evidence], runEnv);
    const firstReceipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
    const firstSeries = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${firstReceipt.base_commit}.json`)));
    assert.equal(firstSeries.rounds.at(-1).validations.length, 1, `Original scoped observation is applicable: ${change}`);
    if (change === "parent-authority") await writeFile(path.join(root, "AGENTS.md"), "Synthetic changed parent review authority.\n");
    if (change === "base-and-candidate") {
      await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "synthetic new base");
      await writeFile(path.join(repo, "unrelated.txt"), "Synthetic unrelated candidate.\n"); await git("add", "unrelated.txt");
      assert.notEqual(record.review_provenance.before.base_commit, await git("rev-parse", "HEAD"));
    }
    if (change === "selected-source") { await writeFile(path.join(repo, "candidate.txt"), "Changed selected source.\n"); await git("add", "candidate.txt"); }
    if (change === "selected-authority") { await writeFile(path.join(repo, "AGENTS.md"), "Changed explicitly selected authority.\n"); await git("add", "AGENTS.md"); }
    if (change === "selected-index") {
      await git("update-index", "--chmod=+x", "candidate.txt");
      const [proof] = await readValidationProofs({root: repo, directory: path.join(repo, ".git/oracle"), validation: [{kind: "file", value: evidence, sha256: sha256(original)}]});
      assert.equal(proof.eligible, false); assert.match(proof.reason, /selected index/);
      assert.deepEqual(await readFile(filename), original);
      continue;
    }
    const currentEnv = change === "environment" ? {...runEnv, NODE_ENV: "synthetic-changed-execution-environment"} : runEnv;
    await command(repo, ["proposal", "Problem: synthetic continuation. Cause: synthetic. Recommended change: retain scoped execution facts."], currentEnv);
    await command(repo, ["review", "--validation", evidence], currentEnv);
    const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
    const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
    const observations = series.rounds.at(-1).validations;
    const retained = ["parent-authority", "base-and-candidate"].includes(change);
    assert.equal(observations.length, retained ? 1 : 0, change);
    if (retained) { assert.equal(observations[0].execution_record_sha256, record.record_sha256); assert.equal(observations[0].binding_kind, "declared-command-inputs-v1"); }
    assert.deepEqual(await readFile(filename), original);
    await command(repo, ["verify-index"], currentEnv);
  }
});

test("selected core and non-core Vault authorities retain their original native identity across review and inheritance", async (t) => {
  for (const selected of ["AGENTS.md", "Vault/docs/CONSTITUTION.md", "Vault/docs/design.md"]) {
    const {repo, env, prepare, git} = await fixture(t);
    await writeFile(path.join(repo, "Vault/docs/design.md"), "Synthetic selected design authority.\n");
    await writeFile(path.join(repo, "Vault/docs/status.md"), "Synthetic unrelated status authority.\n");
    await prepare();
    const runEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
    const captured = await command(repo, ["validate", "--input", "candidate.txt", "--input", selected, "--", process.execPath, "-e", "process.stdout.write('synthetic selected authority pass')"], runEnv);
    const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
    const filename = evidence.slice(1), original = await readFile(filename), proof = JSON.parse(original);
    const output = await readFile(proof.output_file);
    assert.equal(proof.before.files[selected], sha256(await readFile(path.join(repo, selected))), selected);
    const check = async (attached, expected) => {
      await command(repo, ["review", ...(attached ? ["--validation", evidence] : [])], runEnv);
      const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
      const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
      const validations = series.rounds.at(-1).validations;
      assert.equal(validations.length, expected, selected);
      if (expected) assert.equal(validations[0].execution_record_sha256, proof.record_sha256);
      await command(repo, ["verify-index"], runEnv);
    };
    await check(true, 1);
    await check(false, 1);
    await writeFile(path.join(repo, "Vault/docs/status.md"), "Changed unselected status authority.\n");
    await check(false, 1);
    await writeFile(path.join(repo, selected), "Changed selected authority.\n");
    if (await git("ls-files", "--", selected)) await git("add", "--", selected);
    await command(repo, ["proposal", "Problem: synthetic selected authority change. Cause: synthetic. Recommended change: assess current authority."], runEnv);
    await check(true, 0);
    assert.deepEqual(await readFile(filename), original);
    assert.deepEqual(await readFile(proof.output_file), output);
  }
});

test("scoped capture records unselected authority drift as provenance while execution remains stable", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const runEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
  const script = `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "AGENTS.md"))},'Synthetic parent policy changed during command.'); process.stdout.write('selected check passed');`;
  const captured = await command(repo, ["validate", "--input", "candidate.txt", "--", process.execPath, "-e", script], runEnv);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const record = JSON.parse(await readFile(evidence.slice(1)));
  assert.equal(record.outcome, "PASSED"); assert.deepEqual(record.before, record.after);
  assert.notDeepEqual(record.review_provenance.before.inputs.authorities, record.review_provenance.after.inputs.authorities);
  await command(repo, ["proposal", "Problem: synthetic authority refresh. Cause: synthetic. Recommended change: verify current authority."], runEnv);
  await command(repo, ["review", "--validation", evidence], runEnv);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${receipt.base_commit}.json`)));
  assert.equal(series.rounds.at(-1).validations[0].execution_record_sha256, record.record_sha256);
  await command(repo, ["verify-index"], runEnv);
});

test("focused native capture retains output and rejects selected source, config, index or policy drift", async (t) => {
  for (const [name, script] of [
    ["source", "require('node:fs').writeFileSync('candidate.txt','selected change')"],
    ["index", "require('node:child_process').execFileSync('git',['reset','-q','HEAD','--','candidate.txt'])"],
    ["config", "require('node:fs').writeFileSync('package.json','{}')"],
    ["policy", "require('node:fs').writeFileSync('AGENTS.md','changed controlling policy')"],
    ["mode", "require('node:fs').chmodSync('candidate.txt',0o755)"],
    ["type", "require('node:fs').unlinkSync('candidate.txt'); require('node:fs').mkdirSync('candidate.txt')"],
  ]) {
    const {repo, env, prepare} = await fixture(t); await prepare();
    let output;
    await assert.rejects(command(repo, ["validate", "--input", "candidate.txt", ...(name === "policy" ? ["--input", "AGENTS.md"] : []), "--", process.execPath, "-e", `${script}; process.stdout.write('retained diagnostic');`], env), (error) => {output = error.stdout; return true;});
    assert.match(output, /ORACLE_VALIDATION=INPUT_DRIFT/);
    const evidence = output.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
    const record = JSON.parse(await readFile(evidence.slice(1)));
    assert.equal(record.outcome, "INPUT_DRIFT", name);
    assert.match(await readFile(record.output_file, "utf8"), /retained diagnostic/);
  }
});

test("focused native proof binds live executable/link facts and selected staged modes", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  const script = path.join(repo, "check.sh"); const bytes = "#!/bin/sh\nexit 0\n";
  await writeFile(script, bytes); await chmod(script, 0o755); await git("add", "check.sh");
  const reuseEnv = {...env, ORACLE_OMIT_VALIDATION: "1"};
  const invocation = "require('node:child_process').execFileSync('./check.sh',{stdio:'inherit'})";
  const captured = await command(repo, ["validate", "--input", "check.sh", "--", process.execPath, "-e", invocation], reuseEnv);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1]; const filename = evidence.slice(1);
  const original = await readFile(filename); const digest = sha256(original); const record = JSON.parse(original);
  const readProof = async () => (await readValidationProofs({root: repo, directory: path.join(repo, ".git/oracle"), validation: [{kind: "file", value: evidence, sha256: digest}]}))[0];
  assert.equal((await readProof()).eligible, true);
  await command(repo, ["review", "--validation", evidence], reuseEnv);
  await chmod(script, 0o644); await git("add", "check.sh");
  assert.equal((await readProof()).eligible, false);
  assert.match((await readProof()).reason, /mode\/type/);
  await assert.rejects(execute(process.execPath, ["-e", invocation], {cwd: repo}), /EACCES/);
  await command(repo, ["review", "--validation", evidence], reuseEnv);
  const base = await git("rev-parse", "HEAD"); const seriesFile = path.join(repo, ".git/oracle/series", `${base}.json`);
  assert.equal(JSON.parse(await readFile(seriesFile)).rounds.at(-1).validations.length, 0);
  await command(repo, ["review"], reuseEnv);
  assert.equal(JSON.parse(await readFile(seriesFile)).rounds.at(-1).validations.length, 0);
  await chmod(script, 0o755); await git("add", "check.sh");
  assert.equal((await readProof()).eligible, true);
  await git("update-index", "--chmod=-x", "check.sh");
  assert.equal((await readProof()).eligible, false);
  assert.match((await readProof()).reason, /index mode\/type/);
  await git("add", "check.sh");
  await rm(script); await writeFile(path.join(repo, "same.sh"), bytes); await chmod(path.join(repo, "same.sh"), 0o755);
  const {symlink} = await import("node:fs/promises"); await symlink("same.sh", script);
  assert.equal((await readProof()).eligible, false);
  assert.match((await readProof()).reason, /mode\/type/);
  assert.deepEqual(await readFile(filename), original);
  assert.equal(record.before.file_metadata["check.sh"].mode, 0o755);
});
