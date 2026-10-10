import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, writeFile, rm, chmod, cp, readdir} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";
import {captureInputs, assertInputsMatch, withOracleRun, preparedEvidence} from "../scripts/oracle-inputs.mjs";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url));
async function command(cwd, args, env = {}) { return execute(process.execPath, [launcher, ...args], {cwd, env: {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", ...env}}); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-oracle-test-"));
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
  await writeFile(fake, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args=process.argv.slice(2); const out=args[args.indexOf('--output-last-message')+1];\nconst proposal=!args.includes('--output-schema');\nif(!proposal && process.env.ORACLE_READY) fs.writeFileSync(process.env.ORACLE_READY,'ready');\nif(!proposal && process.env.ORACLE_MUTATE) fs.writeFileSync(process.env.ORACLE_MUTATE,'changed during review');\nconst emit=()=>{ fs.writeFileSync(out,proposal?'Synthetic proposal.\\nAPI_VERSION_ASSESSMENT={"impact":"NONE","request_kind":"NOT_REQUIRED","requested_change":null,"request_quote":null,"request_evidence":null}\\nAUTHENTICATION_IMPACT=NONE\\nOWNER_APPROVAL_STATUS=NOT_REQUIRED\\nORACLE_VERDICT=APPROVED\\n':process.env.ORACLE_MALFORMED?'{}':JSON.stringify({verdict:'APPROVED',api_version_assessment:{impact:'NONE',request_kind:'NOT_REQUIRED',requested_change:null,request_quote:null,request_evidence:null},summary:'Synthetic candidate accepted.',authentication_impact:false,owner_approval_status:'NOT_REQUIRED',warning:null,findings:[]})); };\nif(!proposal && process.env.ORACLE_DELAY) setTimeout(emit,Number(process.env.ORACLE_DELAY)); else emit();\n`);
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

test("complete bindings reject base, tree, canonical authority, evidence, owner, and proposal drift", async (t) => {
  const {repo} = await fixture(t);
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "passed");
  const options = {root: repo, base: "base-a", tree: "tree-a", complete: true, validationEvidence: ["@Vault/tmp/check.log"], ownerApprovalEvidence: "exact synthetic approval", proposal: {approved: true}};
  const before = await captureInputs(options);
  for (const change of [{base: "base-b"}, {tree: "tree-b"}, {ownerApprovalEvidence: "other approval"}, {proposal: {approved: false}}]) {
    assert.throws(() => assertInputsMatch(before, {...before, ...Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value]))}), /drifted/);
    await assert.rejects(async () => assertInputsMatch(before, await captureInputs({...options, ...change})), /drifted/);
  }
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "changed evidence");
  await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "passed");
  await writeFile(path.join(repo, "Vault/docs/CONSTITUTION.md"), "changed authority");
  await assert.rejects(async () => assertInputsMatch(before, await captureInputs(options)), /drifted/);
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
  assert.equal(receipt.reviewer.sandbox, "read-only");
  assert.equal(receipt.reviewer.ephemeral, true);
  assert.equal(receipt.reviewer.ignore_user_config, true);
  assert.match(receipt.reviewer.response_schema_sha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.reviewer.model_helper_sha256, /^[a-f0-9]{64}$/);
  await command(repo, ["verify-index"], {...env, CODEX_SELECTED_MODEL: "another-synthetic-task-model"});
  const runs = await readdir(path.join(repo, ".git/oracle/runs"));
  const contents = await Promise.all(runs.map(async (run) => JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "timings.json")))));
  assert.ok(contents.some((times) => times.preparation_ms >= 0 && times.reviewer_ms >= 0 && times.postcheck_ms >= 0));
  for (const run of runs) {
    let evidence;
    try { evidence = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", run, "evidence.json"))); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    assert.equal(evidence.reviewer.model, receipt.reviewer.model);
    assert.equal(evidence.reviewer_metadata_sha256, receipt.reviewer_metadata_sha256);
    assert.deepEqual(JSON.parse(await readFile(evidence.reviewer_metadata_file)), receipt.reviewer);
  }
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

test("cancellation terminates child review and releases lock without approval", async (t) => {
  const {repo, env, prepare, root} = await fixture(t); await prepare();
  const ready = path.join(root, "ready");
  const child = spawn(process.execPath, [launcher, "review"], {cwd: repo, env: {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", ...env, ORACLE_READY: ready, ORACLE_DELAY: "30000"}, stdio: ["ignore", "pipe", "pipe"]});
  const ended = new Promise((resolve) => child.once("close", resolve));
  await waitFor(ready); child.kill("SIGTERM");
  assert.equal(await ended, 1);
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
