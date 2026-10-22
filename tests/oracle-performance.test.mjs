import assert from "node:assert/strict";
import {execFile, spawn} from "node:child_process";
import {mkdir, mkdtemp, readFile, writeFile, rm, chmod, cp, readdir, realpath, rename, symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";
import {captureInputs, assertInputsMatch, withOracleRun, preparedEvidence, observedSourceBindings, bindingHash, pathCustody, evidenceBinding} from "../scripts/oracle-inputs.mjs";
import {receiptSha256, sha256} from "../scripts/oracle-review.mjs";
import {seriesDigest, reviewSnapshot} from "../scripts/oracle-series.mjs";
import {readValidationProofs, inheritNativeEvidence, executableBinding, fileMetadata} from "../scripts/oracle-validation.mjs";
import {admitDeployment} from "../scripts/oracle-deployment.mjs";
import {installReviewed} from "../scripts/codex-maintainer-install.mjs";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url));
async function command(cwd, args, env = {}, options = {}) { return execute(process.execPath, [launcher, ...args], {...options, cwd, env: {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", CODEX_SELECTED_REASONING_EFFORT: "high", ...env}}); }
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
const captureOutput=args[args.indexOf('--output-last-message')+1];
const captureThis=!captureOutput.includes('/cohorts/') || captureOutput.includes('/cohorts/cross-cutting/');
if(process.env.ORACLE_CAPTURE_ARGS && captureThis) fs.writeFileSync(process.env.ORACLE_CAPTURE_ARGS,JSON.stringify(args));
if(process.env.ORACLE_CAPTURE_ENV && captureThis) fs.writeFileSync(process.env.ORACLE_CAPTURE_ENV,JSON.stringify({CODEX_SELECTED_MODEL:process.env.CODEX_SELECTED_MODEL,CODEX_SELECTED_REASONING_EFFORT:process.env.CODEX_SELECTED_REASONING_EFFORT}));
if(args[args.indexOf('--sandbox')+1]!=='danger-full-access') throw new Error('Oracle must execute natively');
if(!args.some(arg=>arg.startsWith('developer_instructions=') && arg.includes('independent My CRM project-local Oracle approver'))) throw new Error('Trusted reviewer role missing');
const out=args[args.indexOf('--output-last-message')+1];
const proposal=!args.includes('--output-schema');
if(!proposal && JSON.stringify(JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]))).includes('"uniqueItems"')) throw new Error('Strict response format does not support uniqueItems');
if(!proposal && process.env.ORACLE_READY) fs.writeFileSync(process.env.ORACLE_READY,'ready');
if(!proposal && process.env.ORACLE_CALLS) fs.appendFileSync(process.env.ORACLE_CALLS,JSON.stringify({out,pid:process.pid})+'\\n');
if(!proposal && process.env.ORACLE_MUTATE) fs.writeFileSync(process.env.ORACLE_MUTATE,'changed during review');
if(captureThis && process.env.ORACLE_MUTATE_SETTINGS) fs.writeFileSync(process.env.ORACLE_MUTATE_SETTINGS,process.env.ORACLE_SETTINGS_CONTENT);
const emit=()=>{
  if(args[args.indexOf('--output-schema')+1]?.endsWith('authorization.schema.json')) {
    const proof=JSON.parse(fs.readFileSync(path.join(path.dirname(out),'authorization.evidence.json')));
    const missing=Boolean(process.env.ORACLE_AUTHORIZATION_MISSING);
    const file=proof.inputs.owner.value.slice(1);
    fs.writeFileSync(out,JSON.stringify({decision:missing?'MISSING':'AUTHORIZED',summary:'Synthetic exact authorization assessment.',approved_effect_keys:missing?[]:proof.pending_protected_effects.map(item=>item.key),authority:missing?null:{evidence:file,quote:fs.readFileSync(file,'utf8').trim()}}));
    return;
  }
  const evidence=proposal?null:JSON.parse(fs.readFileSync(path.join(path.dirname(out),'evidence.json')));
  const response={verdict:process.env.ORACLE_INCOMPLETE?null:'APPROVED',review_status:process.env.ORACLE_INCOMPLETE?'INCOMPLETE':'COMPLETE',api_version_assessment:{impact:'NONE',request_kind:'NOT_REQUIRED',requested_change:null,request_quote:null,request_evidence:null},summary:'Synthetic candidate assessed.',authentication_impact:false,owner_approval_status:'NOT_REQUIRED',warning:null,findings:[],protected_deployment_effects:[],deployment_effect_dispositions:[],unreviewed:process.env.ORACLE_INCOMPLETE?['synthetic remaining scope']:[],reused_coverage:[],reused_validations:[],validations:[],resolutions:[],scope_dispositions:[],synthesis:null,coverage:(evidence?.review_context.required_paths??[]).map(name=>({path:name,dependencies:[name],dependency_rationale:'Synthetic isolated dependency.',assessment:'Synthetic path assessed.',criteria:['Synthetic acceptance criteria.'],evidence:['Synthetic source inspection.'],finding_ids:[]}))};
  if(!proposal && process.env.ORACLE_MISSING_DEPLOYMENT) { response.authentication_impact=true; response.owner_approval_status='MISSING'; response.protected_deployment_effects=[{id:'SYNTHETIC-PERMISSION',category:'PERMISSION_AUTHORITY',description:'Synthetic exact permission authority effect.',affected_paths:[process.env.ORACLE_EFFECT_PATH||'candidate.txt'],authority:null}]; }
  const proof=evidence?.review_context.validation_proofs.find(item=>item.eligible);
  if(!proposal && captureThis && proof && process.env.ORACLE_PROOF_DAMAGE_READY && fs.existsSync(process.env.ORACLE_PROOF_DAMAGE_READY)) {
    fs.unlinkSync(process.env.ORACLE_PROOF_DAMAGE_READY);
    fs.writeFileSync(process.env.ORACLE_PROOF_MOVE_SOURCE,'changed authored source during assessment');
    const record=proof.evidence.slice(1), output=proof.record.output_file, damage=process.env.ORACLE_PROOF_DAMAGE;
    if(damage==='record') fs.appendFileSync(record,' altered');
    if(damage==='output') fs.writeFileSync(output,'altered original output');
    if(damage==='missing-output') fs.unlinkSync(output);
    if(damage==='record-custody') fs.chmodSync(record,fs.statSync(record).mode ^ 0o020);
    if(damage==='output-custody') fs.chmodSync(output,fs.statSync(output).mode ^ 0o020);
    fs.writeFileSync(process.env.ORACLE_PROOF_CHANGED,'applied');
  }
  if(!proposal && process.env.ORACLE_REUSE_COVERAGE) { response.reused_coverage=(evidence.review_context.eligible_coverage??[]).map(item=>item.path); response.coverage=response.coverage.filter(item=>!response.reused_coverage.includes(item.path)); }
  if(proof && !process.env.ORACLE_OMIT_VALIDATION) response.validations=[{id:'native-check',evidence:proof.evidence,command:JSON.stringify(proof.record.command),dependencies:evidence.staged_files,dependency_rationale:'Synthetic complete candidate closure.',assessment:'Native passing execution and output checked.'}];
  if(!proposal && process.env.ORACLE_SOURCE_FINDING) { response.verdict='REJECTED'; response.findings=[{id:'SYNTHETIC-EXIT-1',severity:'medium',code:'SYNTHETIC_EXIT_FINDING',message:'Synthetic source finding.',path:'candidate.txt',reproduction:'Synthetic input.',required_behavior:'Synthetic required behavior.',affected_paths:['candidate.txt'],acceptance_checks:['Synthetic acceptance.'],origin:'initial',missed_finding_reason:null}]; }
  if(!proposal && process.env.ORACLE_OBSERVED_PATH) { response.review_status='INCOMPLETE'; response.verdict=null; response.findings[0].path=process.env.ORACLE_OBSERVED_PATH; response.findings[0].affected_paths=[process.env.ORACLE_OBSERVED_PATH]; response.unreviewed=[process.env.ORACLE_OBSERVED_PATH]; }
  if(!proposal && process.env.ORACLE_RESOLVE_OBSERVED) { const findings=[...evidence.review_context.prior_findings,...evidence.review_context.observed_assessments.flatMap(item=>item.findings)]; response.resolutions=[...new Set(findings.map(item=>item.id))].map(id=>({id,status:'RESOLVED',evidence:'Independently assessed synthetic current source and verified repair.'})); }
  if(!proposal && process.env.ORACLE_DISPOSITION_SCOPE) response.scope_dispositions=evidence.review_context.unavailable_sources.map(item=>({path:item.path,disposition:'UNAVAILABLE',evidence:'Independent current scope disposition; no external source read or invented original facts.'}));
  if(!proposal && captureThis && process.env.ORACLE_RETARGET_MIDDLE) { fs.unlinkSync(process.env.ORACLE_RETARGET_MIDDLE); fs.symlinkSync(process.env.ORACLE_MIDDLE_TARGET,process.env.ORACLE_RETARGET_MIDDLE); }
  if(!proposal && process.env.ORACLE_TAMPER_PROOF_OUTPUT && proof) fs.writeFileSync(proof.record.output_file,'changed nested output during review');
  if(!proposal && process.env.ORACLE_CHMOD_PROOF_SOURCE) fs.chmodSync(path.join(process.cwd(),'candidate.txt'),0o755);
  if(proposal || !process.env.ORACLE_NO_OUTPUT) fs.writeFileSync(out,proposal?'Synthetic proposal.\\nAPI_VERSION_ASSESSMENT={"impact":"NONE","request_kind":"NOT_REQUIRED","requested_change":null,"request_quote":null,"request_evidence":null}\\nAUTHENTICATION_IMPACT=NONE\\nOWNER_APPROVAL_STATUS=NOT_REQUIRED\\nORACLE_VERDICT=APPROVED\\n':process.env.ORACLE_MALFORMED?'{}':JSON.stringify(evidence?.cohort?{cohort_id:evidence.cohort.id,candidate_commit:evidence.cohort.candidate_commit,candidate_tree:evidence.cohort.candidate_tree,input_binding_sha256:evidence.cohort.input_binding_sha256,plan_sha256:evidence.cohort.plan_sha256,reviewer_settings_sha256:evidence.cohort.reviewer_settings_sha256,cross_area_assessment:'Synthetic cross-area entrypoint, consumer, dependency, publication and recovery trace.',response}:response));
  if(!proposal && process.env.ORACLE_BREAK_DIAGNOSTICS) fs.mkdirSync(path.join(path.dirname(out),'reviewer.stdout.log'));
  if(!proposal && process.env.ORACLE_EXIT_AFTER_OUTPUT) process.exit(9);
};
if(!proposal && process.env.ORACLE_DELAY) setTimeout(emit,Number(process.env.ORACLE_DELAY)); else emit();
`);
  await chmod(fake, 0o700);
  const git = async (...args) => (await execute("git", args, {cwd: repo})).stdout.trim();
  await git("init", "-q"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture");
  await git("update-ref", "refs/remotes/origin/main", await git("rev-parse", "HEAD"));
  const env = {PATH: `${bin}${path.delimiter}${process.env.PATH}`};
  const prepare = async (cwd = repo) => {
    await command(cwd, ["proposal", "Problem: synthetic. Cause: synthetic. Recommended change: synthetic."], env);
    await writeFile(path.join(cwd, "candidate.txt"), "after\n");
    await execute("git", ["add", "candidate.txt"], {cwd});
  };
  return {repo, root, env, git, prepare};
}

async function waitFor(filename) {
  for (let count = 0; count < 1000; count++) {
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
    assert.ok(argv.includes('model_reasoning_effort="high"'), `${index}: selected reasoning effort was dropped`);
    for (const clause of ["initial assessment completes the full relevant scope", "actual source/control delta", "Mechanical guard invalidation", "new re-attestation of sealed unchanged facts", "FAILED or ERROR", "strict-ineligible native records", "current green aggregate", "outside the preverified subset", "Before any command", "concrete changed consumed dependency", "include that reason in the result", "stable IDs", "origin missed", "INCOMPLETE", "fresh independent whole-candidate verdict", "Source work by every implementation and author continues", "every arrived change", "path_dispositions", "observed_assessments", "no eligible coverage"]) assert.ok(developer.includes(clause), `${index}: missing trusted clause ${clause}`);
    if (index !== "proposal") assert.ok(!argv.at(-1).includes("Read AGENTS.md, Vault/docs/CONSTITUTION.md, and .agents/skills/oracle/SKILL.md completely"));
    const record = JSON.parse(await readFile(path.join(repo, '.git/oracle', index === 'proposal' ? 'proposal.json' : 'approval.json')));
    assert.equal(record.reviewer.reasoning_effort, 'high');
    assert.equal(record.reviewer_metadata_sha256, sha256(`${JSON.stringify(record.reviewer, null, 2)}\n`));
  }
});

test("complete bindings reject base, tree, canonical authority, evidence, owner, and proposal drift", async (t) => {
  const {repo} = await fixture(t);
  await writeFile(path.join(repo, "Vault/tmp/check.log"), "passed");
  await writeFile(path.join(repo, "Vault/docs/status.md"), "original status authority");
  const options = {root: repo, base: "base-a", tree: "tree-a", complete: true, validationEvidence: ["@Vault/tmp/check.log"], ownerApprovalEvidence: "exact synthetic approval", proposal: {approved: true}, reviewerSettings: {model: 'synthetic-model', reasoning_effort: 'high'}};
  const before = await captureInputs(options);
  for (const change of [{base: "base-b"}, {tree: "tree-b"}, {ownerApprovalEvidence: "other approval"}, {proposal: {approved: false}}, {reviewerSettings: {model: 'other-model', reasoning_effort: 'high'}}, {reviewerSettings: {model: 'synthetic-model', reasoning_effort: 'low'}}]) {
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

test("observed source binding rejects lexical and symlink escapes and binds current absence, content and mode", async (t) => {
  const {repo, root} = await fixture(t);
  for (const name of ["../outside.mjs", path.join(root, "outside.mjs"), "a/../helper.mjs", ".git/config", "helper\\escape.mjs"]) await assert.rejects(observedSourceBindings(repo, [name]), /safe project-local path/);
  const absent = await observedSourceBindings(repo, ["ignored/helper.mjs"]);
  assert.equal(absent[0].sha256, null);
  await mkdir(path.join(repo, "ignored")); await writeFile(path.join(repo, "ignored/helper.mjs"), "first");
  const present = await observedSourceBindings(repo, ["ignored/helper.mjs"]);
  assert.notEqual(bindingHash(absent), bindingHash(present));
  await writeFile(path.join(repo, "ignored/helper.mjs"), "changed");
  assert.notEqual(bindingHash(present), bindingHash(await observedSourceBindings(repo, ["ignored/helper.mjs"])));
  await writeFile(path.join(repo, "ignored/helper.mjs"), "first"); await chmod(path.join(repo, "ignored/helper.mjs"), 0o755);
  assert.notEqual(bindingHash(present), bindingHash(await observedSourceBindings(repo, ["ignored/helper.mjs"])));
  await symlink(root, path.join(repo, "escape"));
  await assert.rejects(observedSourceBindings(repo, ["escape/outside.mjs"]), /symbolic link/);
  await symlink(path.join(repo, "candidate.txt"), path.join(repo, "alias.mjs"));
  await assert.rejects(observedSourceBindings(repo, ["alias.mjs"]), /symbolic link/);
});

test("transitive custody preserves safe aliases and binds middle links before any target content", async (t) => {
  const {repo, root} = await fixture(t);
  await mkdir(path.join(repo, "final")); await writeFile(path.join(repo, "final/result.log"), "unchanged final bytes");
  await symlink("middle", path.join(repo, "outer")); await symlink("final", path.join(repo, "middle"));
  const first = await evidenceBinding(repo, "@outer/result.log");
  await symlink("final", path.join(repo, "other-middle"));
  await rm(path.join(repo, "middle")); await symlink("other-middle", path.join(repo, "middle"));
  const second = await evidenceBinding(repo, "@outer/result.log");
  assert.equal(first.sha256, second.sha256); assert.notEqual(bindingHash(first.custody), bindingHash(second.custody));
  assert.equal(second.custody.entries.filter((item) => item.type === "symlink").length, 3);
  assert.throws(() => assertInputsMatch({evidence: first}, {evidence: second}), /drifted/);
  const external = path.join(root, "external-bridge"); await symlink(path.join(repo, "final"), external);
  await rm(path.join(repo, "middle")); await symlink(external, path.join(repo, "middle"));
  await assert.rejects(evidenceBinding(repo, "@outer/result.log"), /crosses owning source scope/);
  assert.equal((await observedSourceBindings(repo, ["outer/result.log"], {allowUnavailable: ["outer/result.log"]}))[0].availability, "UNAVAILABLE");
  await assert.rejects(observedSourceBindings(repo, ["outer/result.log"]), /symbolic link/);
  await rm(path.join(repo, "middle")); await symlink("outer", path.join(repo, "middle"));
  await assert.rejects(pathCustody(repo, "outer/result.log"), /cycle/);
  await rm(path.join(repo, "middle")); await symlink(`${repo}/other-middle/../../external-bridge`, path.join(repo, "middle"));
  await assert.rejects(evidenceBinding(repo, "@outer/result.log"), /crosses owning source scope/);
});

test("transitive declared-authority custody binds safe middle movement and rejects returning external chains", async (t) => {
  const {repo, root} = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "my-crm-authority-external-")); t.after(() => rm(external, {recursive: true, force: true}));
  const final = path.join(root, "authority-final"); await mkdir(path.join(final, "docs/architecture"), {recursive: true});
  await writeFile(path.join(final, "docs/architecture/oracle-validation.md"), "same declared authority");
  await symlink("authority-middle", path.join(root, "Vault")); await symlink("authority-final", path.join(root, "authority-middle"));
  const declared = path.join(root, "Vault/docs/architecture/oracle-validation.md");
  await writeFile(path.join(repo, "AGENTS.md"), `Synthetic declared coordination: ${declared}`);
  const options = {root: repo, base: "synthetic-base", complete: true};
  const before = await captureInputs(options);
  await symlink("authority-final", path.join(root, "authority-other")); await rm(path.join(root, "authority-middle")); await symlink("authority-other", path.join(root, "authority-middle"));
  const after = await captureInputs(options);
  assert.equal(before.authorities.find((item) => item.path === declared).sha256, after.authorities.find((item) => item.path === declared).sha256);
  assert.throws(() => assertInputsMatch(before, after), /drifted/);
  const snapshot = (inputs) => reviewSnapshot({candidate: {tree: "synthetic-tree", base: "synthetic-base", files: []}, inputs, files: {}, environment: "synthetic-environment"});
  assert.notEqual(bindingHash(snapshot(before).file_facts[declared]), bindingHash(snapshot(after).file_facts[declared]));
  await symlink(final, path.join(external, "bridge")); await rm(path.join(root, "authority-middle")); await symlink(path.join(external, "bridge"), path.join(root, "authority-middle"));
  await assert.rejects(captureInputs(options), /crosses owning source scope/);
});

test("native transitive witness custody rejects source crossings and middle movement at publication", async (t) => {
  const {repo, root, env, prepare, git} = await fixture(t); await prepare();
  const source = "Vault/tmp/dep/helper.mjs", directory = path.join(repo, "Vault/tmp");
  await mkdir(path.join(directory, "dep")); await writeFile(path.join(repo, source), "same selected dependency");
  const executed = await command(repo, ["validate", "--input", source, "--", process.execPath, "-e", "process.stdout.write('synthetic pass')"], env);
  const evidence = executed.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const original = JSON.parse(await readFile(evidence.slice(1), "utf8")); assert.equal(original.outcome, "PASSED");
  await rename(path.join(directory, "dep"), path.join(directory, "final"));
  await symlink("middle", path.join(directory, "dep")); await symlink("final", path.join(directory, "middle"));
  await symlink("final", path.join(directory, "other-middle"));
  const external = path.join(root, "external-bridge"); await symlink(path.join(directory, "final"), external);
  const binding = await evidenceBinding(repo, evidence), nativeDirectory = path.join(repo, ".git/oracle");
  const safe = await readValidationProofs({root: repo, directory: nativeDirectory, validation: [binding]});
  assert.equal(safe[0].eligible, false);
  await assert.rejects(command(repo, ["review", "--validation", evidence], {...env, ORACLE_RETARGET_MIDDLE: path.join(directory, "middle"), ORACLE_MIDDLE_TARGET: "other-middle"}), /provenance changed/);
  await rm(path.join(directory, "middle")); await symlink("final", path.join(directory, "middle"));
  await assert.rejects(command(repo, ["review", "--validation", evidence], {...env, ORACLE_RETARGET_MIDDLE: path.join(directory, "middle"), ORACLE_MIDDLE_TARGET: external}), /crosses owning source scope/);
  await assert.rejects(readValidationProofs({root: repo, directory: nativeDirectory, validation: [binding]}), /crosses owning source scope/);
  const history = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`), "utf8"));
  for (const round of history.rounds) {
    assert.equal(round.execution_status, "ERROR"); assert.equal(round.verdict, null);
    assert.equal(round.coverage.length, 0); assert.equal(round.observed_assessment.response.verdict, "APPROVED");
  }
  assert.equal(JSON.parse(await readFile(evidence.slice(1), "utf8")).outcome, "PASSED");
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  await rm(path.join(directory, "middle")); await symlink("final", path.join(directory, "middle"));
  const outputDirectory = path.dirname(original.output_file), movedOutput = `${outputDirectory}-retained`;
  await rename(outputDirectory, movedOutput);
  const outputBridge = path.join(root, "output-external-bridge"); await symlink(movedOutput, outputBridge);
  await symlink(outputBridge, outputDirectory);
  await assert.rejects(readValidationProofs({root: repo, directory: nativeDirectory, validation: [binding], checkCurrentExecutable: false}), /crosses owning source scope/);
});

test("native raw outside-manifest finding requires current absence coverage and rejects late ignored source drift", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare();
  const base = await git("rev-parse", "HEAD");
  await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Commit observed-source candidate before validation");
  await writeFile(path.join(repo, ".git/info/exclude"), "ignored-helper.mjs\n");
  const helper = path.join(repo, "ignored-helper.mjs");
  await writeFile(helper, "original unmanifested bytes");
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_SOURCE_FINDING: "1", ORACLE_OBSERVED_PATH: "ignored-helper.mjs", ORACLE_EXIT_AFTER_OUTPUT: "1"}), /exited with status 9/);
  const seriesPath = path.join(repo, ".git/oracle/series", `${base}.json`);
  const original = JSON.parse(await readFile(seriesPath, "utf8")).rounds[0];
  assert.equal(Object.hasOwn(original.snapshot.files, "ignored-helper.mjs"), false);
  assert.equal(original.coverage.length, 0); assert.equal(original.findings.length, 0);
  assert.equal(original.observed_assessment.findings[0].id, "SYNTHETIC-EXIT-1");
  await rm(helper);
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_RESOLVE_OBSERVED: "1", ORACLE_MUTATE: helper}, {timeout: 30_000}), /inputs drifted/);
  const error = JSON.parse(await readFile(seriesPath, "utf8")).rounds.at(-1);
  assert.equal(error.execution_status, "ERROR"); assert.equal(error.verdict, null);
  assert.equal(error.snapshot.files["ignored-helper.mjs"], null);
  assert.ok(error.observed_assessment.coverage.some((item) => item.path === "ignored-helper.mjs"));
  await rm(helper);
  await command(repo, ["review"], {...env, ORACLE_RESOLVE_OBSERVED: "1"});
  await command(repo, ["verify-index"], env);
  const approved = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"), "utf8"));
  assert.equal(approved.input_binding.observed_sources.find((item) => item.path === "ignored-helper.mjs").sha256, null);
  await writeFile(helper, "new current source");
  await assert.rejects(command(repo, ["verify-index"], env), /inputs drifted/);
  await command(repo, ["review"], env);
  await command(repo, ["verify-index"], env);
  await writeFile(helper, "changed after independent approval");
  await assert.rejects(command(repo, ["verify-index"], env), /inputs drifted/);
});

test("native unavailable claims permit explicit independent disposition without creating source coverage", async (t) => {
  for (const claim of ["../outside.mjs", "/synthetic-external/helper.mjs", "ignored/link/helper.mjs"]) {
    const {repo, root, env, git, prepare} = await fixture(t); await prepare();
    if (claim.startsWith("ignored")) {
      await writeFile(path.join(repo, ".git/info/exclude"), "ignored/\n"); await mkdir(path.join(repo, "ignored"));
      await symlink(root, path.join(repo, "ignored/link"));
    }
    await assert.rejects(command(repo, ["review"], {...env, ORACLE_SOURCE_FINDING: "1", ORACLE_OBSERVED_PATH: claim, ORACLE_EXIT_AFTER_OUTPUT: "1"}), /exited with status 9/);
    await assert.rejects(command(repo, ["review"], {...env, ORACLE_RESOLVE_OBSERVED: "1"}), /unavailable scope requires independent disposition/);
    await command(repo, ["review"], {...env, ORACLE_RESOLVE_OBSERVED: "1", ORACLE_DISPOSITION_SCOPE: "1"});
    await command(repo, ["verify-index"], env);
    const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"), "utf8"));
    const source = receipt.input_binding.observed_sources.find((item) => item.path === claim);
    assert.equal(source.availability, "UNAVAILABLE"); assert.equal(Object.hasOwn(source, "sha256"), false);
    assert.ok(!receipt.coverage.some((item) => item.path === claim));
    assert.equal(receipt.scope_dispositions[0].path, claim);
    const history = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`), "utf8"));
    assert.equal(history.rounds[0].execution_status, "ERROR"); assert.equal(history.rounds[0].verdict, null);
    assert.equal(history.rounds[0].findings.length, 0); assert.equal(history.rounds[0].observed_assessment.findings[0].id, "SYNTHETIC-EXIT-1");
  }
});

test("native current source overrides historical context evidence and preserves overlapping source custody", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare();
  const relative = "ignored/helper.mjs", helper = path.join(repo, relative), parent = path.dirname(helper);
  await writeFile(path.join(repo, ".git/info/exclude"), "ignored/\n"); await mkdir(parent); await writeFile(helper, "current ignored source");
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_SOURCE_FINDING: "1", ORACLE_OBSERVED_PATH: relative, ORACLE_EXIT_AFTER_OUTPUT: "1"}), /exited with status 9/);
  const historical = path.join(repo, ".git/oracle/historical-context.json");
  await writeFile(historical, JSON.stringify({review_context: {required_paths: ["historical-only.mjs"], snapshot: {files: {[relative]: "stale source identity"}}}}));
  await command(repo, ["review", "--validation", `@${helper}`, "--validation", `@${historical}`], {...env, ORACLE_RESOLVE_OBSERVED: "1"});
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"), "utf8"));
  const source = receipt.input_binding.observed_sources.find((item) => item.path === relative);
  assert.equal(source.sha256, sha256(await readFile(helper))); assert.equal(source.availability, "BOUND");
  assert.ok(source.ancestors.some((item) => item.path === "ignored"));
  assert.ok(receipt.coverage.some((item) => item.path === relative)); assert.ok(!receipt.coverage.some((item) => item.path === "historical-only.mjs"));
  await command(repo, ["verify-index"], env);
  const originalMode = source.metadata.mode, parentMode = source.ancestors.find((item) => item.path === "ignored").metadata.mode;
  await chmod(helper, originalMode ^ 0o100);
  await assert.rejects(command(repo, ["verify-index"], env), /inputs drifted/);
  await chmod(helper, originalMode); await chmod(parent, parentMode ^ 0o020);
  await assert.rejects(command(repo, ["verify-index"], env), /inputs drifted/);
  await chmod(parent, parentMode); await command(repo, ["verify-index"], env);
  const seriesFile = path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`);
  const rounds = JSON.parse(await readFile(seriesFile, "utf8")).rounds.length;
  await rename(parent, path.join(repo, "ignored-original")); await writeFile(path.join(repo, ".git/info/exclude"), "ignored\nignored-original/\n");
  await symlink(root, parent);
  await assert.rejects(command(repo, ["review", "--validation", `@${historical}`], env), /symbolic link/);
  assert.equal(JSON.parse(await readFile(seriesFile, "utf8")).rounds.length, rounds);
  const outcomes = await Promise.all((await readdir(path.join(repo, ".git/oracle/runs"))).map(async (name) => {
    try { return JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", name, "outcome.json"), "utf8")); } catch { return null; }
  }));
  assert.ok(outcomes.some((item) => item?.outcome === "ERROR" && item.reviewer_invoked === false && /symbolic link/.test(item.error?.message)));
});

test("declared external governing inputs bind proposal, review, execution and receipt custody without loading siblings", async (t) => {
  const {repo, root, env, prepare} = await fixture(t);
  const parentPolicy = path.join(root, "AGENTS.md");
  const family = path.join(root, "Vault/docs/architecture/bos-product-family.md");
  const coordination = path.join(root, "Vault/docs/architecture/oracle-validation.md");
  const parentOracle = path.join(root, "tools/projects_oracle.py");
  await mkdir(path.dirname(family), {recursive: true}); await mkdir(path.dirname(parentOracle), {recursive: true});
  await writeFile(parentPolicy, "Synthetic inherited policy.");
  await writeFile(family, "Synthetic declared family authority.");
  await writeFile(coordination, "Synthetic declared review coordination.");
  await writeFile(path.join(repo, "AGENTS.md"), `Synthetic local policy. Family: ${family}. Coordination: ${coordination}. Oracle: ${parentOracle}.`);
  const options = {root: repo, base: "synthetic-base", complete: true};
  const initial = await captureInputs(options);
  const external = initial.authorities.filter((item) => item.external);
  assert.deepEqual(external.map((item) => item.path), [parentPolicy, family, coordination]);
  assert.equal(external.find((item) => item.path === parentOracle), undefined);
  assert.deepEqual(initial.owner, null); assert.deepEqual(initial.validation, []);
  const proposalInputs = await captureInputs({...options, complete: false});
  assert.deepEqual(proposalInputs.authorities.filter((item) => item.external), external);
  await writeFile(parentOracle, "Synthetic declared parent tool; never executed.");
  assertInputsMatch(initial, await captureInputs(options));
  const consumed = await captureInputs({...options, validationEvidence: [`@${parentOracle}`]});
  await writeFile(parentOracle, "Synthetic actually consumed controller changed.");
  await assert.rejects(async () => assertInputsMatch(consumed, await captureInputs({...options, validationEvidence: [`@${parentOracle}`]})), /drifted/);
  assertInputsMatch(initial, await captureInputs(options));
  for (const filename of [parentPolicy, family, coordination]) {
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

test("same checkout runs proceed concurrently without a session reservation", async (t) => {
  const {root} = await fixture(t);
  const directory = path.join(root, "state-a");
  let release; const blocker = new Promise((resolve) => { release = resolve; });
  let started; const ready = new Promise((resolve) => { started = resolve; });
  const first = withOracleRun(directory, async () => { started(); await blocker; });
  await ready;
  await withOracleRun(directory, async () => {});
  await withOracleRun(path.join(root, "state-b"), async () => {});
  release(); await first;
  await withOracleRun(directory, async () => {});
});

test("native movement preserves raw assessed paths as bound support and leaves source work free", async (t) => {
  const {repo, env, prepare, git} = await fixture(t);
  const authority = path.join(repo, "Vault/docs/status.md"); await writeFile(authority, "Synthetic original status.");
  await prepare();
  const base = await git("rev-parse", "HEAD"), seriesFile = path.join(repo, ".git/oracle/series", `${base}.json`);
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_MUTATE: authority}), /drifted/);
  const failed = JSON.parse(await readFile(seriesFile, "utf8")), observed = failed.rounds.at(-1);
  assert.equal(observed.execution_status, "ERROR"); assert.equal(observed.verdict, null); assert.equal(observed.coverage.length, 0);
  assert.equal(observed.observed_assessment.response.review_status, "COMPLETE");
  assert.ok(observed.observed_assessment.coverage.some((item) => item.path === "candidate.txt"));
  assert.deepEqual(observed.snapshot.file_facts["candidate.txt"], {mode: "100644", type: "blob"});
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  // Another implementation can arrive; review neither locks nor rejects its origin.
  await writeFile(path.join(repo, "arrived.txt"), "Synthetic concurrent implementation."); await git("add", "arrived.txt");
  await command(repo, ["review"], env); await command(repo, ["verify-index"], env);
  const approved = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"), "utf8"));
  assert.ok(approved.inherited_validation_evidence.includes(observed.observed_assessment.response_evidence.value));
  const history = JSON.parse(await readFile(seriesFile, "utf8"));
  assert.equal(history.rounds.at(-1).verdict, "APPROVED");
  assert.ok(history.rounds.at(-1).coverage.some((item) => item.path === "arrived.txt"));
  assert.equal(history.rounds[0].execution_status, "ERROR");
});

test("native candidate records staged mode/type facts independently of blob content", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  await command(repo, ["review"], env);
  const base = await git("rev-parse", "HEAD"), before = await git("hash-object", "candidate.txt");
  await chmod(path.join(repo, "candidate.txt"), 0o755); await git("add", "candidate.txt");
  assert.equal(await git("hash-object", "candidate.txt"), before);
  await assert.rejects(command(repo, ["verify-index"], env), /stale/);
  await command(repo, ["review"], env); await command(repo, ["verify-index"], env);
  const history = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${base}.json`), "utf8"));
  assert.equal(history.rounds[0].snapshot.file_facts["candidate.txt"].mode, "100644");
  assert.equal(history.rounds[1].snapshot.file_facts["candidate.txt"].mode, "100755");
  assert.deepEqual(history.rounds[1].changed_since_previous, ["candidate.txt"]);
});

test("unsuccessful reviewer completion retains valid output, original process and finding obligations", async (t) => {
  for (const failure of ["ORACLE_EXIT_AFTER_OUTPUT", "ORACLE_BREAK_DIAGNOSTICS"]) {
    const {repo, env, prepare, git} = await fixture(t); await prepare();
    const base = await git("rev-parse", "HEAD"), seriesFile = path.join(repo, ".git/oracle/series", `${base}.json`);
    await assert.rejects(command(repo, ["review"], {...env, ORACLE_SOURCE_FINDING: "1", [failure]: "1"}), /ORACLE_PROCESS=ERROR/);
    const original = JSON.parse(await readFile(seriesFile, "utf8")).rounds.at(-1);
    assert.equal(original.execution_status, "ERROR"); assert.equal(original.verdict, null); assert.equal(original.coverage.length, 0);
    assert.equal(original.observed_assessment.response.verdict, "REJECTED");
    assert.equal(original.observed_assessment.findings[0].id, "SYNTHETIC-EXIT-1");
    assert.ok(original.observed_assessment.coverage.length > 0);
    if (failure === "ORACLE_EXIT_AFTER_OUTPUT") assert.deepEqual(original.observed_assessment.execution.cohort_exit_codes.map((item) => item.exit_code), [9, 9, 9]);
    const responseFile = original.observed_assessment.response_evidence.value.slice(1);
    assert.equal(sha256(await readFile(responseFile)), original.observed_assessment.response_evidence.sha256);
    await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
    await assert.rejects(command(repo, ["review"], env), /explicit resolution evidence/);
    await command(repo, ["review"], {...env, ORACLE_RESOLVE_OBSERVED: "1"});
    await command(repo, ["verify-index"], env);
    const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json"), "utf8"));
    assert.ok(receipt.inherited_validation_evidence.includes(original.observed_assessment.response_evidence.value));
    if (original.observed_assessment.execution_evidence) assert.ok(receipt.inherited_validation_evidence.includes(original.observed_assessment.execution_evidence.value));
  }
  for (const malformed of ["ORACLE_MALFORMED", "ORACLE_NO_OUTPUT"]) {
    const {repo, env, prepare, git} = await fixture(t); await prepare();
    await assert.rejects(command(repo, ["review"], {...env, ORACLE_EXIT_AFTER_OUTPUT: "1", [malformed]: "1"}), /exited with status 9/);
    const round = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`), "utf8")).rounds.at(-1);
    assert.equal(round.execution_status, "ERROR"); assert.equal(round.verdict, null); assert.equal(round.observed_assessment, undefined);
    assert.equal(round.coverage.length, 0); assert.ok(round.error.observation_error);
    await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  }
});

test("final publication rereads nested native output instead of trusting prepared proof descriptors", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  const sameEnvironment = {...env, ORACLE_TAMPER_PROOF_OUTPUT: "1", ORACLE_OMIT_VALIDATION: "1"};
  const captured = await command(repo, ["validate", "--", process.execPath, "-e", "console.log('synthetic pass')"], sameEnvironment);
  const reference = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1].trim();
  await assert.rejects(command(repo, ["review", "--validation", reference], sameEnvironment), /native validation output is missing or changed/);
  const latest = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`), "utf8")).rounds.at(-1);
  assert.equal(latest.execution_status, "ERROR"); assert.equal(latest.verdict, null);
  assert.equal(latest.observed_assessment.response.verdict, "APPROVED");
  assert.equal(latest.coverage.length, 0);
  await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
});

test("final publication rechecks native executable and source modes beyond unchanged staged content", async (t) => {
  for (const kind of ["executable", "source-mode"]) {
    const {repo, root, env, prepare, git} = await fixture(t); await prepare();
    const checker = path.join(root, "bin", "synthetic-check");
    await writeFile(checker, "#!/bin/sh\nexit 0\n"); await chmod(checker, 0o700);
    if (kind === "source-mode") await git("config", "core.filemode", "false");
    const sameEnvironment = {...env, ORACLE_OMIT_VALIDATION: "1", ...(kind === "executable" ? {ORACLE_MUTATE: checker} : {ORACLE_CHMOD_PROOF_SOURCE: "1"})};
    const captured = await command(repo, ["validate", "--", checker], sameEnvironment);
    const reference = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1].trim();
    await assert.rejects(command(repo, ["review", "--validation", reference], sameEnvironment), /native validation source, executable, environment or provenance changed/);
    assert.equal(await git("diff", "--name-only"), "");
    const latest = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`), "utf8")).rounds.at(-1);
    assert.equal(latest.execution_status, "ERROR"); assert.equal(latest.verdict, null); assert.ok(latest.observed_assessment);
    await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
  }
});

test("source movement cannot conceal explicit or inherited native proof corruption", async (t) => {
  for (const admission of ["explicit", "inherited"]) for (const damage of ["record", "output", "missing-output", "record-custody", "output-custody", "none"]) {
    await t.test(`${admission} ${damage}`, async (context) => {
      const {repo, root, env, prepare, git} = await fixture(context); await prepare();
      await git("branch", "-m", "main");
      await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Commit proof fixture before validation");
      const target = path.join(repo, "arrived-source.mjs"), ready = path.join(root, "damage-ready"), changed = path.join(root, "damage-applied");
      const sameEnvironment = {...env, ORACLE_OMIT_VALIDATION: "1", ORACLE_PROOF_DAMAGE: damage,
        ORACLE_PROOF_DAMAGE_READY: ready, ORACLE_PROOF_CHANGED: changed, ORACLE_PROOF_MOVE_SOURCE: target};
      const captured = await command(repo, ["validate", "--input", "candidate.txt", "--", process.execPath, "-e", "console.log('synthetic scoped proof')"], sameEnvironment);
      const reference = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1].trim();
      const original = JSON.parse(await readFile(reference.slice(1)));
      await command(repo, ["review", "--validation", reference], sameEnvironment);
      const firstReceipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
      await writeFile(target, "new committed source before review\n"); await git("add", "arrived-source.mjs");
      await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Committed delta requires current assessment");
      await writeFile(ready, "Apply one combined source/evidence change.");
      const args = admission === "explicit" ? ["--validation", reference] : [];
      if (damage === "none") {
        const owner = runningReview(repo, sameEnvironment, args); await waitFor(changed);
        const controllers = path.join(repo, ".git/oracle/controllers");
        const latestGeneration = (await readdir(controllers)).filter(name => /^\d{8}\.json$/.test(name)).sort().at(-1);
        const generation = JSON.parse(await readFile(path.join(controllers, latestGeneration)));
        let progress;
        for (let count = 0; count < 1000; count++) {
          progress = JSON.parse(await readFile(path.join(repo, ".git/oracle/controllers", generation.id, "progress.json")));
          if (progress.phase === "WAITING_FOR_COMMIT") break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.equal(progress.phase, "WAITING_FOR_COMMIT");
        await git("add", "arrived-source.mjs");
        await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Commit intact-proof source arrival");
        const done = await owner.done; assert.equal(done.code, 0, done.stderr);
        assert.match(done.stdout, /ORACLE_REVIEW=CONTINUING/);
        const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
        assert.equal(receipt.candidate_commit, await git("rev-parse", "HEAD"));
        assert.ok(receipt.validation_evidence.includes(reference));
      } else {
        await assert.rejects(command(repo, ["review", ...args], sameEnvironment, {timeout: 30_000}), error => {
          assert.equal(Boolean(error.killed), false, "Integrity failure must terminate without the fixture timeout");
          assert.doesNotMatch(error.stdout ?? "", /ORACLE_REVIEW=CONTINUING/);
          return /native validation|JSON|Unexpected|ENOENT/.test(error.message);
        });
        await assert.rejects(readFile(path.join(repo, ".git/oracle/approval.json")), {code: "ENOENT"});
        const series = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${firstReceipt.base_commit}.json`)));
        const latest = series.rounds.at(-1);
        assert.equal(latest.execution_status, "ERROR"); assert.equal(latest.verdict, null);
        assert.equal(latest.observed_assessment.response.verdict, "APPROVED");
        for (const item of latest.coverage) {
          assert.deepEqual(item, series.rounds[0].coverage.find(previous => previous.path === item.path));
        }
        assert.ok(!latest.coverage.some(item => item.path === "arrived-source.mjs"));
        assert.ok(series.rounds[0].validations.some(item => item.execution_record_sha256 === original.record_sha256));
      }
      assert.equal(original.outcome, "PASSED");
      const execution = JSON.parse(await readFile(path.join(path.dirname(original.output_file), "outcome.json")));
      assert.equal(execution.kind, "validation"); assert.equal(execution.outcome, "COMPLETED");
    });
  }
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
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_MALFORMED: "1"}), /invalid verdict|candidate or plan binding differs/);
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

test("pre-admission diagnostic custody failure preserves historical receipt and prevents current readiness", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  await command(repo, ["review"], env);
  const receiptBytes = await readFile(path.join(repo, ".git/oracle/approval.json"));
  const approval = JSON.parse(receiptBytes);
  const history = path.join(repo, ".git/oracle/series", `${approval.base_commit}.json`);
  const original = await readFile(history);
  const runs = path.join(repo, ".git/oracle/runs");
  await rename(runs, `${runs}-retained`);
  await writeFile(runs, "Synthetic unavailable diagnostic directory.\n");
  await assert.rejects(command(repo, ["review"], env), /ORACLE_PROCESS=ERROR/);
  assert.deepEqual(await readFile(path.join(repo, ".git/oracle/approval.json")), receiptBytes);
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
      const message = path.join(repo, ".git/synthetic-reviewed-base-message");
      await writeFile(message, "Synthetic new reviewed base\n");
      await command(repo, ["stamp-message", message], runEnv);
      await command(repo, ["verify-message", message], runEnv);
      await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-q", "-F", message);
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

test("literal link-parent components bind actual OS input and evidence targets and preserve missing lookup", async (t) => {
  const {repo, env} = await fixture(t);
  await mkdir(path.join(repo, 'real/deep'), {recursive: true});
  await writeFile(path.join(repo, 'input.txt'), 'normalized target');
  await writeFile(path.join(repo, 'real/input.txt'), 'actual OS target');
  await symlink('real/deep', path.join(repo, 'alias'));
  const name = 'alias/../input.txt', actual = await readFile(`${repo}/${name}`);
  const custody = await pathCustody(repo, name);
  assert.equal(custody.resolved_path, path.join(repo, 'real/input.txt'));
  assert.equal(sha256(await readFile(custody.resolved_path)), sha256(actual));
  assert.equal((await evidenceBinding(repo, `@${name}`)).sha256, sha256(actual));
  assert.equal((await fileMetadata(repo, [name]))[name].custody.resolved_path, custody.resolved_path);
  assert.ok(custody.entries.some(item => item.path === path.join(repo, 'alias') && item.target === 'real/deep'));
  const missing = 'missing/../input.txt';
  await assert.rejects(readFile(`${repo}/${missing}`), {code: 'ENOENT'});
  const absent = await pathCustody(repo, missing, {allowMissing: true});
  assert.equal(absent.metadata, null);
  assert.equal(absent.resolved_path, `${repo}/${missing}`);
  assert.equal((await fileMetadata(repo, [missing]))[missing].type, 'missing');
  await assert.rejects(evidenceBinding(repo, `@${missing}`), /missing/);
  const marker = path.join(repo, 'executed.txt');
  for (const input of [missing, name]) await assert.rejects(command(repo, ['validate', '--input', input, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`], env), /missing|canonical project files/);
  await assert.rejects(readFile(marker), {code: 'ENOENT'});
  // Addition changes absence into actual OS lookup; no old missing proof survives.
  await mkdir(path.join(repo, 'missing'));
  assert.notEqual(bindingHash(absent), bindingHash(await pathCustody(repo, missing, {allowMissing: true})));
});

test("executable lookup binds declared cwd relative PATH and literal link-parent targets", async (t) => {
  const {repo} = await fixture(t);
  await mkdir(path.join(repo, 'tools/final'), {recursive: true});
  const bytes = '#!/bin/sh\nprintf actual\n';
  await writeFile(path.join(repo, 'tools/final/check'), bytes); await chmod(path.join(repo, 'tools/final/check'), 0o755);
  await symlink('final', path.join(repo, 'tools/middle'));
  await symlink('middle', path.join(repo, 'tools/outer'));
  const environment = {...process.env, PATH: `tools/outer${path.delimiter}${process.env.PATH}`};
  assert.equal((await execute('check', [], {cwd: repo, env: environment})).stdout, 'actual');
  const before = await executableBinding('check', environment, repo);
  assert.equal(before.path, path.join(repo, 'tools/final/check'));
  await symlink('final', path.join(repo, 'tools/other'));
  await rm(path.join(repo, 'tools/middle')); await symlink('other', path.join(repo, 'tools/middle'));
  const after = await executableBinding('check', environment, repo);
  assert.equal(before.sha256, after.sha256); assert.notEqual(bindingHash(before), bindingHash(after));
  await mkdir(path.join(repo, 'real/deep'), {recursive: true});
  await symlink('real/deep', path.join(repo, 'alias'));
  await writeFile(path.join(repo, 'real/check'), bytes); await chmod(path.join(repo, 'real/check'), 0o755);
  await writeFile(path.join(repo, 'check'), '#!/bin/sh\nprintf normalized\n'); await chmod(path.join(repo, 'check'), 0o755);
  const literal = './alias/../check';
  assert.equal((await execute(literal, [], {cwd: repo})).stdout, 'actual');
  const target = await executableBinding(literal, process.env, repo);
  assert.equal(target.path, path.join(repo, 'real/check'));
  assert.equal(target.sha256, sha256(await readFile(`${repo}/${literal}`)));
  await assert.rejects(executableBinding('./missing/../check', process.env, repo), /unavailable/);
  await assert.rejects(execute('./missing/../check', [], {cwd: repo}), {code: 'ENOENT'});
  await writeFile(path.join(repo, 'sh'), '#!/bin/sh\nprintf cwd-shadow\n'); await chmod(path.join(repo, 'sh'), 0o755);
  const withoutPath = {...process.env}; delete withoutPath.PATH;
  assert.equal((await execute('sh', ['-c', 'printf system-default'], {cwd: repo, env: withoutPath})).stdout, 'system-default');
  assert.notEqual((await executableBinding('sh', withoutPath, repo)).path, path.join(repo, 'sh'));
  const emptyPath = {...withoutPath, PATH: ''};
  assert.equal((await execute('sh', [], {cwd: repo, env: emptyPath})).stdout, 'cwd-shadow');
  assert.equal((await executableBinding('sh', emptyPath, repo)).path, path.join(repo, 'sh'));
});

test("native executable aliases bind resolved target index mode and original command cwd", async (t) => {
  const {repo, env, git} = await fixture(t);
  await mkdir(path.join(repo, 'tools'));
  await writeFile(path.join(repo, 'tools/target'), '#!/bin/sh\nprintf executable-pass\n');
  await chmod(path.join(repo, 'tools/target'), 0o755);
  await symlink('target', path.join(repo, 'tools/alias'));
  await git('add', 'tools');
  const captured = await command(repo, ['validate', '--input', 'candidate.txt', '--', './tools/alias'], env);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const original = await readFile(evidence.slice(1)), record = JSON.parse(original);
  assert.equal(record.outcome, 'PASSED'); assert.equal(record.execution_cwd, repo);
  assert.equal(record.executable.target_index.path, 'tools/target');
  assert.match(record.executable.target_index.entry, /^100755 /);
  const readProof = async () => (await readValidationProofs({root: repo, directory: path.join(repo, '.git/oracle'), validation: [{kind: 'file', value: evidence, sha256: sha256(original)}]}))[0];
  assert.equal((await readProof()).eligible, true);
  // Record intake uses the same literal OS semantics as evidence capture.
  await mkdir(path.join(repo, '.git/oracle/validations/deep'));
  await symlink(path.join(repo, '.git/oracle/validations/deep'), path.join(repo, 'Vault/tmp/record-directory'));
  const aliasReference = `@Vault/tmp/record-directory/../${path.basename(evidence.slice(1))}`;
  const aliasEvidence = await evidenceBinding(repo, aliasReference);
  const [aliasProof] = await readValidationProofs({root: repo, directory: path.join(repo, '.git/oracle'), validation: [aliasEvidence]});
  assert.equal(aliasProof.eligible, true);
  assert.equal(aliasProof.record.record_sha256, record.record_sha256);
  await git('update-index', '--chmod=-x', 'tools/target');
  assert.equal((await execute('./tools/alias', [], {cwd: repo})).stdout, 'executable-pass');
  const current = await readProof();
  assert.equal(current.eligible, false); assert.notDeepEqual(current.current_provenance.executable.target_index, record.executable.target_index);
  assert.deepEqual(await readFile(evidence.slice(1)), original);
  assert.equal(record.outcome, 'PASSED');
});

test("native relative PATH executes and rechecks the command's declared cwd and middle links", async (t) => {
  const {repo, env} = await fixture(t);
  await mkdir(path.join(repo, 'tools/final'), {recursive: true});
  await writeFile(path.join(repo, 'tools/final/check'), '#!/bin/sh\nprintf relative-path-pass\n');
  await chmod(path.join(repo, 'tools/final/check'), 0o755);
  await symlink('final', path.join(repo, 'tools/middle')); await symlink('middle', path.join(repo, 'tools/outer'));
  const executionEnv = {...env, PATH: `tools/outer${path.delimiter}${env.PATH}`};
  const captured = await command(repo, ['validate', '--input', 'candidate.txt', '--', 'check'], executionEnv);
  const evidence = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  const original = await readFile(evidence.slice(1)), record = JSON.parse(original);
  assert.equal(record.outcome, 'PASSED'); assert.equal(record.execution_cwd, repo);
  assert.match(await readFile(record.output_file, 'utf8'), /relative-path-pass/);
  const readProof = async () => (await readValidationProofs({root: repo, directory: path.join(repo, '.git/oracle'), validation: [{kind: 'file', value: evidence, sha256: sha256(original)}]}))[0];
  // This caller's PATH has no helper. Intake truthfully reports unavailable;
  // the original successful execution and its declared environment stay intact.
  await assert.rejects(readProof(), /executable is unavailable/);
  const initial = await executableBinding('check', executionEnv, record.execution_cwd);
  assert.deepEqual(initial, record.executable);
  await symlink('final', path.join(repo, 'tools/other'));
  await rm(path.join(repo, 'tools/middle')); await symlink('other', path.join(repo, 'tools/middle'));
  const changed = await executableBinding('check', executionEnv, record.execution_cwd);
  assert.equal(changed.sha256, initial.sha256); assert.notDeepEqual(changed.custody, initial.custody);
  assert.deepEqual(await readFile(evidence.slice(1)), original);
});

test("terminal separators preserve OS directory lookup and reject invalid selected files before execution", async (t) => {
  const {repo, env} = await fixture(t);
  await writeFile(path.join(repo, 'input.txt'), 'regular source');
  for (const name of ['input.txt/', 'input.txt//']) {
    await assert.rejects(readFile(`${repo}/${name}`), {code: 'ENOTDIR'});
    await assert.rejects(pathCustody(repo, name), {code: 'ENOTDIR'});
    await assert.rejects(evidenceBinding(repo, `@${name}`), {code: 'ENOTDIR'});
    const marker = path.join(repo, 'invalid-selector-executed');
    await assert.rejects(command(repo, ['validate', '--input', name, '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`], env), /not a directory/);
    await assert.rejects(readFile(marker), {code: 'ENOENT'});
  }
  for (const target of ['input.txt/', `${repo}/input.txt/`]) {
    const alias = path.join(repo, 'bad-target'); await symlink(target, alias);
    await assert.rejects(readFile(alias), {code: 'ENOTDIR'});
    await assert.rejects(pathCustody(repo, 'bad-target'), {code: 'ENOTDIR'});
    await rm(alias);
  }
  await mkdir(path.join(repo, 'directory')); await symlink('directory/', path.join(repo, 'safe-directory'));
  assert.equal((await pathCustody(repo, 'directory/')).metadata.type, 'directory');
  assert.equal((await pathCustody(repo, 'safe-directory')).resolved_path, path.join(repo, 'directory'));
});

test("native default effort round-trips actual launch environment into sessionless child selection", async (t) => {
  const {repo, root, env, git} = await fixture(t);
  const home = path.join(root, 'task-home'), childHome = path.join(root, 'child-home');
  await mkdir(path.join(home, 'sessions'), {recursive: true}); await mkdir(childHome);
  await writeFile(path.join(home, 'config.toml'), 'model_reasoning_effort = "high"\n');
  await writeFile(path.join(childHome, 'config.toml'), 'model_reasoning_effort = "high"\n');
  await writeFile(path.join(home, 'sessions/rollout-synthetic-task.jsonl'), JSON.stringify({type: 'turn_context', payload: {model: 'synthetic-test-model', effort: null}}) + '\n');
  const capturedArgs = path.join(root, 'default-args.json'), capturedEnv = path.join(root, 'default-env.json');
  const taskEnv = {...env, CODEX_HOME: home, CODEX_THREAD_ID: 'synthetic-task', CODEX_SELECTED_REASONING_EFFORT: 'low', ORACLE_CAPTURE_ARGS: capturedArgs, ORACLE_CAPTURE_ENV: capturedEnv};
  const helper = fileURLToPath(new URL('../scripts/codex-child-model.mjs', import.meta.url));
  for (const mode of ['proposal', 'review']) {
    await command(repo, mode === 'proposal' ? ['proposal', 'Problem: synthetic settings. Cause: synthetic. Recommended change: preserve default.'] : ['review'], taskEnv);
    const argv = JSON.parse(await readFile(capturedArgs)), inherited = JSON.parse(await readFile(capturedEnv));
    assert.equal(argv.some(value => value.startsWith('model_reasoning_effort=')), false);
    assert.equal(inherited.CODEX_SELECTED_REASONING_EFFORT, '');
    const record = JSON.parse(await readFile(path.join(repo, '.git/oracle', mode === 'proposal' ? 'proposal.json' : 'approval.json')));
    assert.equal(record.reviewer.reasoning_effort, null);
    assert.equal(record.reviewer_metadata_sha256, sha256(`${JSON.stringify(record.reviewer, null, 2)}\n`));
    const child = await execute(process.execPath, ['--input-type=module', '-e', `import {selectedSettings} from ${JSON.stringify(helper)}; console.log(JSON.stringify(await selectedSettings()));`], {cwd: repo, env: {...process.env, CODEX_HOME: childHome, CODEX_THREAD_ID: 'sessionless-child', ...inherited}});
    assert.deepEqual(JSON.parse(child.stdout), {model: 'synthetic-test-model', reasoning_effort: null});
    if (mode === 'proposal') { await writeFile(path.join(repo, 'candidate.txt'), 'after settings proposal\n'); await git('add', 'candidate.txt'); }
  }
});

test("native settings movement rejects proposal and completed publication while retaining actual raw assessment", async (t) => {
  for (const mode of ['proposal', 'review']) {
    const {repo, root, env, git} = await fixture(t);
    const home = path.join(root, 'settings-home'); await mkdir(path.join(home, 'sessions'), {recursive: true});
    const session = path.join(home, 'sessions/rollout-settings-task.jsonl');
    const turn = effort => JSON.stringify({type: 'turn_context', payload: {model: 'synthetic-test-model', effort}}) + '\n';
    await writeFile(session, turn('high'));
    const settingsEnv = {...env, CODEX_HOME: home, CODEX_THREAD_ID: 'settings-task'};
    if (mode === 'review') {
      await command(repo, ['proposal', 'Problem: synthetic settings movement. Cause: synthetic. Recommended change: bind current settings.'], settingsEnv);
      await writeFile(path.join(repo, 'candidate.txt'), 'after settings proposal\n'); await git('add', 'candidate.txt');
    }
    const moved = {...settingsEnv, ORACLE_MUTATE_SETTINGS: session, ORACLE_SETTINGS_CONTENT: turn('low')};
    await assert.rejects(command(repo, mode === 'proposal' ? ['proposal', 'Problem: synthetic movement. Cause: synthetic. Recommended change: bind settings.'] : ['review'], moved), /inputs drifted/);
    await assert.rejects(readFile(path.join(repo, '.git/oracle', mode === 'proposal' ? 'proposal.json' : 'approval.json')), {code: 'ENOENT'});
    if (mode === 'review') {
      const series = JSON.parse(await readFile(path.join(repo, '.git/oracle/series', `${await git('rev-parse', 'HEAD')}.json`)));
      const round = series.rounds.at(-1);
      assert.equal(round.execution_status, 'ERROR'); assert.equal(round.verdict, null); assert.deepEqual(round.coverage, []);
      assert.equal(round.observed_assessment.response.verdict, 'APPROVED');
    }
  }
});

test("native technical review and commit finish before separate exact deployment authorization", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  const reviewed = await command(repo, ["review"], {...env, ORACLE_MISSING_DEPLOYMENT: "1"});
  assert.match(reviewed.stdout, /ORACLE_VERDICT=APPROVED/);
  const receiptFile = path.join(repo, ".git/oracle/approval.json"), original = await readFile(receiptFile);
  const receipt = JSON.parse(original);
  assert.equal(receipt.owner_approval_status, "MISSING");
  assert.match((await command(repo, ["verify-index"], env)).stdout, /ORACLE_APPROVAL=APPROVED/);
  const message = path.join(repo, ".git/synthetic-release-message"); await writeFile(message, "Synthetic reviewed protected source\n");
  await command(repo, ["stamp-message", message], env); await command(repo, ["verify-message", message], env);
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-F", message);
  await assert.rejects(admitDeployment({root: repo}), /exact human authority/);
  const owner = path.join(repo, "Vault/tmp/synthetic-owner.txt"); await writeFile(owner, "I authorize exactly the synthetic permission-authority effect.");
  await assert.rejects(command(repo, ["authorize-deployment", "HEAD", "--owner-approval", `@${owner}`], {...env, ORACLE_AUTHORIZATION_MISSING: "1"}), /Command failed/);
  const attempts = await Promise.all((await readdir(path.join(repo, ".git/oracle/runs"))).map(async (name) => JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", name, "outcome.json")))));
  assert.ok(attempts.some((item) => item.kind === "deployment-authorization" && item.outcome === "MISSING" && item.reviewer_invoked));
  assert.deepEqual(await readFile(receiptFile), original);
  const authorized = await command(repo, ["authorize-deployment", "HEAD", "--owner-approval", `@${owner}`], env);
  assert.match(authorized.stdout, /MYCRM_DEPLOYMENT_AUTHORIZATION=AUTHORIZED/);
  assert.equal((await admitDeployment({root: repo})).status, "ADMITTED");
  assert.deepEqual(await readFile(receiptFile), original);
  await command(repo, ["authorize-deployment", "HEAD", "--owner-approval", `@${owner}`], env);
  assert.deepEqual(await readFile(receiptFile), original);
});

test("native complete technical review includes unpublished source lacking private receipts", async (t) => {
  const {repo, env, git} = await fixture(t);
  const published = await git("rev-parse", "HEAD"); await git("update-ref", "refs/remotes/origin/main", published);
  await writeFile(path.join(repo, "earlier-authority.mjs"), "export const syntheticPermission = 'protected';\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic earlier unsealed source");
  const earlier = await git("rev-parse", "HEAD");
  await command(repo, ["proposal", "Problem: synthetic integrated range. Cause: unsealed earlier source. Recommended change: review all current source and preserve deployment authority."], env);
  await writeFile(path.join(repo, "candidate.txt"), "ordinary latest implementation\n"); await git("add", "candidate.txt");
  await command(repo, ["review"], {...env, ORACLE_MISSING_DEPLOYMENT: "1", ORACLE_EFFECT_PATH: "earlier-authority.mjs"});
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.equal(receipt.verdict, "APPROVED"); assert.equal(receipt.recovered_deployment_commits[0].commit, earlier);
  assert.ok(receipt.coverage.some((item) => item.path === "earlier-authority.mjs"));
  await command(repo, ["verify-index"], env);
  const message = path.join(repo, ".git/recovered-range-message"); await writeFile(message, "Synthetic whole integrated source\n"); await command(repo, ["stamp-message", message], env);
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-q", "-F", message);
  await assert.rejects(admitDeployment({root: repo}), /exact human authority/);
});

test("unavailable published history permits technical receipt and commit while deployment stays separate", async (t) => {
  const {repo, env, git} = await fixture(t);
  await git("update-ref", "-d", "refs/remotes/origin/main");
  await writeFile(path.join(repo, "candidate.txt"), "earlier unpublished authority\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic earlier unpublished source");
  await mkdir(path.join(repo, "scripts")); await writeFile(path.join(repo, "scripts/oracle-deployment.mjs"), "// Synthetic first policy staged without published metadata.\n"); await git("add", ".");
  await command(repo, ["proposal", "Problem: synthetic source inspection. Cause: published history unavailable. Recommended change: complete source review with separate deployment readiness."], env);
  await writeFile(path.join(repo, "candidate.txt"), "ordinary candidate still reviewable\n"); await git("add", "candidate.txt");
  await command(repo, ["review"], env);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.equal(receipt.verdict, "APPROVED"); assert.equal(receipt.deployment_history_status, "UNAVAILABLE");
  await command(repo, ["verify-index"], env);
  const message = path.join(repo, ".git/reviewable-source-message"); await writeFile(message, "Synthetic reviewable source\n"); await command(repo, ["stamp-message", message], env);
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-q", "-F", message);
  await assert.rejects(admitDeployment({root: repo}), (error) => /history binding/.test(error.message) && !/human authority/.test(error.message));
});

test("deployment verifies consumed native records and output custody without ambient reruns", async (t) => {
  const {repo, env, prepare, git} = await fixture(t); await prepare();
  const captured = await command(repo, ["validate", "--", process.execPath, "-e", "console.log('synthetic native evidence')"], env);
  const recordFile = captured.stdout.match(/ORACLE_VALIDATION_EVIDENCE=@([^\n]+)/)[1].trim();
  const recordBytes = await readFile(recordFile), proof = JSON.parse(recordBytes), outputBytes = await readFile(proof.output_file);
  await command(repo, ["review", "--validation", `@${recordFile}`], env);
  const receiptFile = path.join(repo, ".git/oracle/approval.json"), receiptBytes = await readFile(receiptFile);
  const message = path.join(repo, ".git/native-output-message"); await writeFile(message, "Synthetic reviewed output custody\n"); await command(repo, ["stamp-message", message], env);
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-q", "-F", message);
  assert.equal((await admitDeployment({root: repo})).status, "ADMITTED");
  await writeFile(proof.output_file, "Synthetic changed original output\n");
  await assert.rejects(admitDeployment({root: repo}), /output.*changed/); await writeFile(proof.output_file, outputBytes);
  await rm(recordFile); await assert.rejects(admitDeployment({root: repo}), /missing|ENOENT/); await writeFile(recordFile, recordBytes, {mode: 0o600});
  const originalRun = path.dirname(proof.output_file), retained = path.join(repo, ".git/oracle/retained-output-run");
  await rename(originalRun, retained); await symlink(retained, originalRun);
  await assert.rejects(admitDeployment({root: repo}), /custody|path|link|changed/i);
  await rm(originalRun); await rename(retained, originalRun);
  const prior = process.env.MYCRM_SYNTHETIC_AMBIENT;
  try { process.env.MYCRM_SYNTHETIC_AMBIENT = "later hook context"; assert.equal((await admitDeployment({root: repo})).status, "ADMITTED"); }
  finally { if (prior === undefined) delete process.env.MYCRM_SYNTHETIC_AMBIENT; else process.env.MYCRM_SYNTHETIC_AMBIENT = prior; }
  assert.deepEqual(await readFile(receiptFile), receiptBytes);
});

test("committed-range review checkpoints exact source and unchanged shipment executes zero callbacks", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare();
  await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic prepared source before validation");
  const first = await git("rev-parse", "HEAD");
  await writeFile(path.join(repo, "newly-arrived.txt"), "Synthetic arrived committed scope\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic new commit before review");
  const head = await git("rev-parse", "HEAD");
  const {shipmentPlan, runShipment, readValidatedCheckpoint, recordDeliveredCommit} = await import("../scripts/shipment-state.mjs");
  assert.equal((await shipmentPlan({root: repo})).action, "VALIDATE");
  await command(repo, ["review"], env);
  const checkpoint = await readValidatedCheckpoint(repo);
  assert.equal(checkpoint.record.last_validated_commit, head);
  assert.equal(checkpoint.receipt.candidate_commit, head);
  assert.equal(checkpoint.receipt.deployment_history_base_commit, first);
  assert.equal((await shipmentPlan({root: repo})).action, "DELIVER");
  const roundsBefore = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${checkpoint.receipt.base_commit}.json`))).rounds.length;
  assert.match((await command(repo, ["review"], env)).stdout, /NO_UNVALIDATED_COMMITS/);
  assert.equal(JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${checkpoint.receipt.base_commit}.json`))).rounds.length, roundsBefore);
  const admission = await admitDeployment({root: repo}); assert.equal(admission.source_commit, head);
  await assert.rejects(recordDeliveredCommit({root: repo, admission, installation: {pluginId: "my-crm@synthetic", release: {content_sha256: "a".repeat(64)}}}), /published main/);
  await git("update-ref", "refs/remotes/origin/main", head);
  await recordDeliveredCommit({root: repo, admission, installation: {pluginId: "my-crm@synthetic", release: {content_sha256: "a".repeat(64)}}});
  const called = [], fail = (step) => async () => { called.push(step); throw new Error(`Unexpected ${step}`); };
  const result = await runShipment({root: repo, prepare: fail("prepare"), validate: fail("validate"), deliver: fail("deliver")});
  assert.equal(result.action, "NO_CHANGES"); assert.deepEqual(called, []);
  await writeFile(path.join(repo, "candidate.txt"), "Synthetic next arrived commit\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic next source");
  const pending = await shipmentPlan({root: repo}); assert.equal(pending.action, "VALIDATE"); assert.equal(pending.validation_base, head); assert.equal(pending.commits.length, 1);
  await assert.rejects(recordDeliveredCommit({root: repo, admission, installation: {pluginId: "my-crm@synthetic", release: {content_sha256: "a".repeat(64)}}}), /exact validated commit|exact validated admission/);
});

test("new proposals retain committed review lineage while current criteria remain independently assessed", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare();
  const runEnv = {...env, ORACLE_REUSE_COVERAGE: "1"};
  await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic original prepared candidate");
  await command(repo, ["review"], runEnv);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const first = await readValidatedCheckpoint(repo), originalBase = first.record.reviewed_base;
  const seriesFile = path.join(repo, ".git/oracle/series", `${originalBase}.json`);
  const originalSeries = JSON.parse(await readFile(seriesFile));
  await command(repo, ["proposal", "Problem: synthetic new affected area. Cause: new committed change. Recommended change: preserve prior verified lineage and assess current changes."], env);
  const proposal = JSON.parse(await readFile(path.join(repo, ".git/oracle/proposal.json")));
  assert.equal(proposal.base_commit, first.record.last_validated_commit);
  assert.notEqual(proposal.base_commit, originalBase);
  await writeFile(path.join(repo, "new-area.txt"), "Synthetic new committed scope\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic current committed scope");
  await command(repo, ["review"], runEnv);
  const current = await readValidatedCheckpoint(repo), series = JSON.parse(await readFile(seriesFile));
  assert.equal(current.record.last_validated_commit, await git("rev-parse", "HEAD"));
  assert.equal(current.record.reviewed_base, originalBase);
  assert.equal(current.receipt.proposal_record_sha256, proposal.record_sha256);
  assert.equal(series.series_id, originalSeries.series_id);
  assert.equal(series.rounds.length, originalSeries.rounds.length + 1);
  assert.deepEqual(series.rounds.slice(0, -1), originalSeries.rounds);
  assert.ok(series.rounds.at(-1).response.coverage.some((item) => item.path === "new-area.txt"));
  assert.ok(series.rounds.at(-1).response.reused_coverage.includes("candidate.txt"));
});

test("missing checkpoint never approves a clean published candidate and ordinary hooks need no reviewer", async (t) => {
  const {repo, git} = await fixture(t); await git("branch", "-m", "main");
  const {shipmentPlan, readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const unchanged = await shipmentPlan({root: repo}); assert.equal(unchanged.action, "NO_CHANGES"); assert.equal(unchanged.approval_state, "UNKNOWN"); assert.equal(await readValidatedCheckpoint(repo), null);
  await mkdir(path.join(repo, ".githooks"));
  for (const name of ["prepare-commit-msg", "commit-msg"]) {
    await cp(new URL(`../.githooks/${name}`, import.meta.url), path.join(repo, ".githooks", name)); await chmod(path.join(repo, ".githooks", name), 0o755);
  }
  await git("config", "core.hooksPath", ".githooks");
  await writeFile(path.join(repo, "candidate.txt"), "Synthetic authored unverified code\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic ordinary unreviewed commit");
  assert.doesNotMatch(await git("show", "-s", "--format=%B", "HEAD"), /Oracle-Verdict/);
  assert.equal((await shipmentPlan({root: repo})).action, "VALIDATE");
  await assert.rejects(admitDeployment({root: repo}), /technical review stamp|receipt/);
});

test("checkpoint custody rejects changed receipts, stale source and malformed delivery without promoting readiness", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic candidate for checkpoint custody");
  await command(repo, ["review"], env);
  const {shipmentPlan, readValidatedCheckpoint, recordValidatedCommit, checkpointDigest} = await import("../scripts/shipment-state.mjs");
  const original = await readValidatedCheckpoint(repo), checkpointFile = path.join(repo, ".git/oracle/shipment-validated.json"), checkpointBytes = await readFile(checkpointFile);
  const malformed = {...original.record, last_validated_commit: "f".repeat(40)};
  await writeFile(checkpointFile, JSON.stringify(malformed)); await assert.rejects(shipmentPlan({root: repo}), /malformed or changed/);
  await writeFile(checkpointFile, checkpointBytes);
  const archive = path.join(repo, ".git/oracle/technical-receipts", `${original.record.receipt_sha256}.json`), archiveBytes = await readFile(archive);
  await writeFile(archive, JSON.stringify({...original.receipt, summary: "Synthetic changed observation"})); await assert.rejects(shipmentPlan({root: repo}), /digest/); await writeFile(archive, archiveBytes);
  const delivered = {schema: "my-crm.shipment-delivered/v1", delivered_commit: original.record.last_validated_commit, validated_checkpoint_sha256: original.record.checkpoint_sha256}; delivered.checkpoint_sha256 = "0".repeat(64);
  await writeFile(path.join(repo, ".git/oracle/shipment-delivered.json"), JSON.stringify(delivered)); await assert.rejects(shipmentPlan({root: repo}), /delivery checkpoint/);
  await rm(path.join(repo, ".git/oracle/shipment-delivered.json"));
  await writeFile(path.join(repo, "candidate.txt"), "Synthetic uncommitted new source\n");
  assert.equal((await shipmentPlan({root: repo})).action, "PREPARE");
  await assert.rejects(recordValidatedCommit({root: repo, receipt: original.receipt}), /complete clean canonical/);
  assert.deepEqual(await readFile(checkpointFile), checkpointBytes);
  assert.equal(checkpointDigest(original.record), original.record.checkpoint_sha256);
});

test("concurrent review requests attach to the live native parent without superseding its area group", async (t) => {
  const {repo, root, env, prepare, git} = await fixture(t); await prepare();
  const ready = path.join(root, "owner-ready"), calls = path.join(root, "calls.jsonl");
  const owner = runningReview(repo, {...env, ORACLE_DELAY: "1000", ORACLE_READY: ready, ORACLE_CALLS: calls});
  await waitFor(ready);
  const pointer = await readFile(path.join(repo, ".git/oracle/active-review.json"));
  const {shipmentPlan} = await import("../scripts/shipment-state.mjs");
  assert.equal((await shipmentPlan({root: repo})).action, "REVIEW_IN_PROGRESS");
  const follower = await command(repo, ["review"], {...env, ORACLE_SOURCE_FINDING: "1", ORACLE_CALLS: calls});
  assert.match(follower.stdout, /ORACLE_REVIEW=ATTACHED/);
  assert.equal((await owner.done).code, 0);
  assert.deepEqual(await readFile(path.join(repo, ".git/oracle/active-review.json")), pointer);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 3);
  const current = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.equal(current.verdict, "APPROVED");
  const history = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${await git("rev-parse", "HEAD")}.json`)));
  assert.equal(history.rounds.length, 1);
  assert.equal(history.rounds[0].verdict, "APPROVED");
});

function runningReview(repo, env, args = [], entrypoint = launcher) {
  const child = spawn(process.execPath, [entrypoint, "review", ...args], {cwd: repo,
    env: {...process.env, ...env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", CODEX_SELECTED_REASONING_EFFORT: "high"}, stdio: ["ignore", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout.on("data", (value) => { stdout += value; }); child.stderr.on("data", (value) => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal, stdout, stderr})); });
  return {child, done, output: () => stdout};
}

async function runningLegacyReview(repo, root, env, {withholdEvidence = false, failure = null, allowMovement = false} = {}) {
  const directory = path.join(root, "legacy"); await mkdir(directory);
  const script = path.join(directory, "oracle-review.mjs"), ready = path.join(root, "legacy-ready");
  await writeFile(script, `import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {withOracleRun,atomicJson} from ${JSON.stringify(new URL("../scripts/oracle-inputs.mjs", import.meta.url).href)};
const git=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const original=git('rev-parse','HEAD');
try { await withOracleRun(path.join(git('rev-parse','--absolute-git-dir'),'oracle'),async({run})=>{
 ${withholdEvidence ? "" : "await atomicJson(path.join(run,'evidence.json'),{inputs:{candidate_commit:original}});"}
 await writeFile(${JSON.stringify(ready)},'Native legacy parent admitted and preparing.');
 await new Promise(resolve=>setTimeout(resolve,1800));
 ${failure ? `throw new Error(${JSON.stringify(failure)});` : ""}
 if(!${allowMovement} && git('rev-parse','HEAD')!==original) throw new Error('Oracle inputs drifted: committed source moved during legacy assessment');
 return {verdict:'APPROVED'};
},{kind:'review'}); } catch(e) { console.error(e.message); process.exitCode=1; }
`);
  const child = spawn(process.execPath, [script, "review"], {cwd: repo, env: {...process.env, ...env}, stdio: ["ignore", "pipe", "pipe"]});
  child.stdout.resume(); let stderr = ""; child.stderr.on("data", (value) => { stderr += value; });
  const done = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve({code, stderr})); });
  await waitFor(ready);
  return {child, done};
}

test("already-running legacy native review is observed through genuine process and invocation custody", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const legacy = await runningLegacyReview(repo, root, env);
  const pointer = await readFile(path.join(repo, ".git/oracle/active-review.json")), calls = path.join(root, "no-duplicate-calls");
  const {shipmentPlan} = await import("../scripts/shipment-state.mjs");
  assert.equal((await shipmentPlan({root: repo})).action, "REVIEW_IN_PROGRESS");
  const observed = await command(repo, ["review"], {...env, ORACLE_CALLS: calls});
  assert.match(observed.stdout, /ATTACHED/); assert.match(observed.stdout, /LEGACY_COMPLETED/);
  assert.equal((await legacy.done).code, 0);
  assert.deepEqual(await readFile(path.join(repo, ".git/oracle/active-review.json")), pointer);
  await assert.rejects(readFile(calls), {code: "ENOENT"});
  const admission = JSON.parse(await readFile(path.join(repo, ".git/oracle/controllers/00000000.json")));
  assert.equal(admission.process.pid, legacy.child.pid); assert.equal(admission.legacy_invocation.id, JSON.parse(pointer).id);
});

test("legacy native failure after an arrived commit retains its outcome before current parent continuation", async (t) => {
  const {repo, root, env, prepare, git} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Initial legacy source");
  const legacy = await runningLegacyReview(repo, root, env), original = JSON.parse(await readFile(path.join(repo, ".git/oracle/active-review.json")));
  const follower = command(repo, ["review"], env);
  await waitFor(path.join(repo, ".git/oracle/controllers/00000000.json"));
  await writeFile(path.join(repo, "candidate.txt"), "Arrived while pre-existing native reviewer was running\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Arrived legacy source");
  const result = await follower; assert.match(result.stdout, /LEGACY_COMPLETED/);
  assert.equal((await legacy.done).code, 1);
  const native = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", original.id, "outcome.json")));
  assert.equal(native.outcome, "ERROR"); assert.match(native.error.message, /committed source moved/);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit, await git("rev-parse", "HEAD"));
});

for (const oldSuccess of [false, true]) test(`PREPARING legacy ${oldSuccess ? "success" : "drift failure"} with unknown candidate continues exact committed scope`, async (t) => {
  const {repo, root, env, prepare, git} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Initial preparing source");
  const legacy = await runningLegacyReview(repo, root, env, {withholdEvidence: true, allowMovement: oldSuccess});
  const original = JSON.parse(await readFile(path.join(repo, ".git/oracle/active-review.json")));
  const calls = path.join(root, "current-calls"), follower = command(repo, ["review"], {...env, ORACLE_CALLS: calls});
  await waitFor(path.join(repo, ".git/oracle/controllers/00000000.json"));
  const admitted = JSON.parse(await readFile(path.join(repo, ".git/oracle/controllers/00000000.json")));
  assert.equal(admitted.legacy_phase, "PREPARING"); assert.equal(admitted.candidate_commit, null);
  await writeFile(path.join(repo, "candidate.txt"), "Committed after legacy admission before candidate capture\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Arrived preparing source");
  await follower; await legacy.done;
  const native = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", original.id, "outcome.json")));
  assert.equal(native.outcome, oldSuccess ? "APPROVED" : "ERROR");
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit, await git("rev-parse", "HEAD"));
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 3);
});

test("unknown PREPARING legacy execution failure retains its literal ERROR without new models", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const legacy = await runningLegacyReview(repo, root, env, {withholdEvidence: true, failure: "Synthetic provider execution failure"});
  const calls = path.join(root, "unexpected-calls");
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_CALLS: calls}), /Synthetic provider execution failure/);
  assert.equal((await legacy.done).code, 1);
  await assert.rejects(readFile(calls), {code: "ENOENT"});
});

test("fresh native workers retain producer custody and rejected or incomplete CLI status", async (t) => {
  for (const setting of ["ORACLE_SOURCE_FINDING", "ORACLE_INCOMPLETE"]) {
    const {repo, env, prepare} = await fixture(t); await prepare();
    await assert.rejects(command(repo, ["review"], {...env, [setting]: "1"}), (error) => {
      assert.equal(error.code, 1); assert.match(error.stdout, setting === "ORACLE_SOURCE_FINDING" ? /ORACLE_VERDICT=REJECTED/ : /ORACLE_REVIEW_STATUS=INCOMPLETE/); return true;
    });
    const pointer = JSON.parse(await readFile(path.join(repo, ".git/oracle/active-review.json")));
    const evidence = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", pointer.id, "evidence.json")));
    assert.equal(evidence.producer_origin.fresh_module_graph, true);
    assert.equal(evidence.producer_origin.source_sha256["oracle-review.mjs"], sha256(await readFile(launcher)));
    const cohort = JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", pointer.id, "cohorts/implementation-consumers/evidence.json")));
    const packet = JSON.parse(await readFile(cohort.source_packet.path));
    const body = packet.items.find(item => item.path === "candidate.txt").versions.find(version => version.revision === packet.candidate_tree);
    assert.equal((await Promise.all(body.pages.map(page => readFile(page.path, "utf8")))).join(""), "after\n");
    assert.ok(body.pages.every(page => page.bytes <= 8192));
  }
});

test("simultaneous native starters elect one immutable live parent and observer cancellation leaves it running", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const calls = path.join(root, "calls.jsonl"), ready = path.join(root, "ready");
  const settings = {...env, ORACLE_DELAY: "1600", ORACLE_CALLS: calls, ORACLE_READY: ready};
  const first = runningReview(repo, settings), second = runningReview(repo, settings);
  await waitFor(ready);
  for (let count = 0; count < 200 && ![first, second].some((item) => /ATTACHED/.test(item.output())); count++) await new Promise((resolve) => setTimeout(resolve, 20));
  const follower = [first, second].find((item) => /ATTACHED/.test(item.output()));
  assert.ok(follower, "One simultaneous starter must attach before any second area group");
  const owner = follower === first ? second : first;
  follower.child.kill("SIGTERM");
  assert.equal((await follower.done).signal, "SIGTERM");
  const completed = await owner.done;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 3);
});

test("a live native attempt after parent loss is observed without launching another area group", async (t) => {
  const {repo, root, env, prepare, git} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Committed recovery candidate");
  const calls = path.join(root, "orphan-calls"), ready = path.join(root, "orphan-ready");
  const owner = runningReview(repo, {...env, ORACLE_DELAY: "1800", ORACLE_CALLS: calls, ORACLE_READY: ready});
  await waitFor(ready);
  const pointer = await readFile(path.join(repo, ".git/oracle/active-review.json"));
  owner.child.kill("SIGKILL"); assert.equal((await owner.done).signal, "SIGKILL");
  const {shipmentPlan,readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const plan = await shipmentPlan({root: repo}); assert.equal(plan.action, "REVIEW_IN_PROGRESS");
  assert.match(plan.controller.process.command.join?.(" ") ?? plan.controller.process.command, /oracle-bootstrap\.mjs/);
  const completed = await command(repo, ["review"], {...env, ORACLE_CALLS: calls});
  assert.match(completed.stdout, /LEGACY_COMPLETED/);
  assert.deepEqual(await readFile(path.join(repo, ".git/oracle/active-review.json")), pointer);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 3);
  assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit, await git("rev-parse", "HEAD"));
});

test("precommit source arrival waits in the same parent before assessing the committed delta", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Initial precommit candidate");
  const head = await git("rev-parse", "HEAD"), ready = path.join(root, "precommit-ready"), calls = path.join(root, "precommit-calls");
  const owner = runningReview(repo, {...env, ORACLE_DELAY: "400", ORACLE_READY: ready, ORACLE_CALLS: calls});
  await waitFor(ready);
  const generation = JSON.parse(await readFile(path.join(repo, ".git/oracle/controllers/00000000.json")));
  const original = JSON.parse(await readFile(path.join(repo, ".git/oracle/active-review.json")));
  await writeFile(path.join(repo, "candidate.txt"), "Arrived edit intentionally remains unstaged across postcheck\n");
  const directory = path.join(repo, ".git/oracle/controllers", generation.id); let progress;
  for (let count = 0; count < 1000; count++) {
    progress = JSON.parse(await readFile(path.join(directory, "progress.json")));
    if (progress.phase === "WAITING_FOR_COMMIT") break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(progress.phase, "WAITING_FOR_COMMIT"); assert.equal(await git("rev-parse", "HEAD"), head);
  await assert.rejects(readFile(path.join(directory, "outcome.json")), {code: "ENOENT"});
  assert.equal(JSON.parse(await readFile(path.join(repo, ".git/oracle/runs", original.id, "outcome.json"))).outcome, "ERROR");
  await git("add", "candidate.txt"); await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Commit arrived precommit source");
  assert.equal((await owner.done).code, 0);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit, await git("rev-parse", "HEAD"));
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 6);
});

test("tracked producer disappearance waits for its committed restoration in the same native owner", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await cp(new URL("../scripts", import.meta.url), path.join(repo,"scripts"), {recursive:true});
  await cp(new URL("../package.json", import.meta.url), path.join(repo,"package.json"));
  await cp(new URL("../node_modules", import.meta.url), path.join(repo,"node_modules"), {recursive:true,dereference:true});
  await writeFile(path.join(repo,".gitignore"),"Vault/\nnode_modules/\n");await git("add",".");
  await git("-c","user.name=Synthetic","-c","user.email=synthetic@example.invalid","commit","-qm","Tracked native producer fixture");
  const ready=path.join(root,"producer-ready"),calls=path.join(root,"producer-calls"),filename=path.join(repo,"scripts/oracle-source-packet.mjs"),originalBytes=await readFile(filename);
  const owner=runningReview(repo,{...env,ORACLE_DELAY:"400",ORACLE_READY:ready,ORACLE_CALLS:calls},[],path.join(repo,"scripts/oracle-review.mjs"));
  await waitFor(ready);const head=await git("rev-parse","HEAD"),pointer=JSON.parse(await readFile(path.join(repo,".git/oracle/active-review.json"))),generation=JSON.parse(await readFile(path.join(repo,".git/oracle/controllers/00000000.json")));
  await rm(filename);let phase;
  for(let count=0;count<1000;count++){phase=JSON.parse(await readFile(path.join(repo,".git/oracle/controllers",generation.id,"progress.json"))).phase;if(phase==="WAITING_FOR_COMMIT")break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(phase,"WAITING_FOR_COMMIT");assert.equal(await git("rev-parse","HEAD"),head);
  const failed=JSON.parse(await readFile(path.join(repo,".git/oracle/runs",pointer.id,"outcome.json")));
  assert.equal(failed.outcome,"ERROR");assert.equal(failed.error.code,"ORACLE_CANDIDATE_MOVED");assert.equal(failed.error.original_code,"ENOENT");
  await writeFile(filename,Buffer.concat([originalBytes,Buffer.from("\n// Synthetic committed source continuation.\n")]));await git("add","scripts/oracle-source-packet.mjs");await git("-c","user.name=Synthetic","-c","user.email=synthetic@example.invalid","commit","-qm","Restore and commit native producer");
  const done=await owner.done;assert.equal(done.code,0,done.stderr);
  const {readValidatedCheckpoint}=await import("../scripts/shipment-state.mjs");assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit,await git("rev-parse","HEAD"));
  assert.equal((await readFile(calls,"utf8")).trim().split("\n").length,6);
});

test("live parent catches batched committed movement and preserves actual ERROR observations", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Initial candidate");
  const first = await git("rev-parse", "HEAD"), ready = path.join(root, "ready"), calls = path.join(root, "calls.jsonl");
  const owner = runningReview(repo, {...env, ORACLE_DELAY: "800", ORACLE_READY: ready, ORACLE_CALLS: calls, ORACLE_REUSE_COVERAGE: "1"});
  await waitFor(ready);
  await writeFile(path.join(repo, "candidate.txt"), "Arrived production change\n"); await git("add", ".");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Arrived candidate");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", "Ordinary unchanged-content commit");
  const head = await git("rev-parse", "HEAD"), completed = await owner.done;
  assert.equal(completed.code, 0, completed.stderr); assert.match(completed.stdout, /ORACLE_REVIEW=CONTINUING/);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const checkpoint = await readValidatedCheckpoint(repo);
  assert.equal(checkpoint.record.last_validated_commit, head); assert.notEqual(head, first);
  const history = JSON.parse(await readFile(path.join(repo, ".git/oracle/series", `${checkpoint.record.reviewed_base}.json`)));
  assert.equal(history.rounds[0].execution_status, "ERROR");
  assert.equal(history.rounds[0].observed_assessment.response.verdict, "APPROVED");
  assert.equal(history.rounds.at(-1).verdict, "APPROVED");
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 6);
});

test("unchanged-content commits retain valid coverage while the parent approves the exact new commit", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Initial current source");
  const ready = path.join(root, "ready"), runEnv = {...env, ORACLE_DELAY: "700", ORACLE_READY: ready, ORACLE_REUSE_COVERAGE: "1"};
  await command(repo, ["review"], runEnv); await rm(ready);
  const tree = await git("rev-parse", "HEAD^{tree}");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", "First history-only commit");
  const owner = runningReview(repo, runEnv);
  await waitFor(ready);
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", "Arrived history-only commit");
  const result = await owner.done; assert.equal(result.code, 0, result.stderr);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const current = await readValidatedCheckpoint(repo);
  assert.equal(current.record.last_validated_commit, await git("rev-parse", "HEAD"));
  assert.equal(current.record.tree, tree); assert.ok(current.receipt.reused_coverage.includes("candidate.txt"));
});

test("late commit during native checkpoint finalization continues before reporting current readiness", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Prepared source before finalization");
  const original = await git("rev-parse", "HEAD"), trigger = path.join(root, "late-commit");
  const actualGit = (await execute("which", ["git"])).stdout.trim(), shim = path.join(root, "bin/git");
  await writeFile(shim, `#!${process.execPath}
const fs=require('node:fs'), cp=require('node:child_process'), path=require('node:path');
const trigger=${JSON.stringify(trigger)}, actual=${JSON.stringify(actualGit)};
if(fs.existsSync(trigger) && fs.existsSync(path.join(process.cwd(),'.git/oracle/approval.json')) && process.argv.slice(2).join(' ')==='status --porcelain=v1 --untracked-files=all') {
 fs.unlinkSync(trigger);
 cp.execFileSync(actual,['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','Commit during actual checkpoint finalization'],{cwd:process.cwd()});
}
try { process.stdout.write(cp.execFileSync(actual,process.argv.slice(2),{cwd:process.cwd()})); }
catch(e) { if(e.stderr) process.stderr.write(e.stderr); process.exitCode=e.status??1; }
`); await chmod(shim, 0o700);
  const ready = path.join(root, "ready"), owner = runningReview(repo, {...env, ORACLE_DELAY: "600", ORACLE_READY: ready});
  await waitFor(ready); await writeFile(trigger, "Commit on the actual checkpoint source check.\n");
  const result = await owner.done; assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /CONTINUING/);
  const {readValidatedCheckpoint, shipmentPlan} = await import("../scripts/shipment-state.mjs");
  const checkpoint = await readValidatedCheckpoint(repo), head = await git("rev-parse", "HEAD");
  assert.notEqual(head, original); assert.equal(checkpoint.record.last_validated_commit, head);
  assert.equal((await shipmentPlan({root: repo})).action, "DELIVER");
});

test("attached evidence is independently consumed by the same parent before current completion", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const ready = path.join(root, "ready"), calls = path.join(root, "calls.jsonl"), evidence = path.join(repo, "Vault/tmp/arrived.txt");
  await writeFile(evidence, "New bound validation explanation.\n");
  const owner = runningReview(repo, {...env, ORACLE_DELAY: "650", ORACLE_READY: ready, ORACLE_CALLS: calls});
  await waitFor(ready);
  const follower = await command(repo, ["review", "--validation", `@${evidence}`], env);
  assert.match(follower.stdout, /ATTACHED/);
  const result = await owner.done; assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.ok(receipt.requested_validation_evidence.includes(`@${evidence}`));
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 6);
});

test("stale PID identity is preserved and foreign controller metadata prevents new admission", async (t) => {
  const {repo, root, env, prepare} = await fixture(t); await prepare();
  const directory = path.join(repo, ".git/oracle/controllers"); await mkdir(directory, {recursive: true});
  const value = {schema: "my-crm.review-controller/v1", id: ["00000000", "0000", "4000", "8000", "000000000000"].join("-"), generation: 0,
    kind: "review", scope: "completed-source", root: repo,
    process: {pid: process.pid, birth: "reused-pid-original-birth", root: repo, command: `node ${launcher} review`},
    started_at: "2026-10-21T02:47:36.376299Z", review_started_at: "2026-10-21T02:47:36.376299Z", release_started_at: "2026-10-21T07:48:57Z"};
  const filename = path.join(directory, "00000000.json"), original = JSON.stringify({...value, sha256: bindingHash(value)});
  await writeFile(filename, original);
  await command(repo, ["review"], env);
  assert.equal(await readFile(filename, "utf8"), original);
  const successor = JSON.parse(await readFile(path.join(directory, "00000001.json")));
  assert.equal(successor.predecessor_observation.observed_state, "STALE");
  assert.equal(successor.predecessor_observation.source_verdict, null);
  assert.equal(successor.review_started_at, value.review_started_at);
  assert.equal(successor.release_started_at, value.release_started_at);
  const foreign = {...value, root: path.join(root, "foreign")};
  await writeFile(filename, JSON.stringify({...foreign, sha256: bindingHash(foreign)}));
  const pointer = await readFile(path.join(repo, ".git/oracle/active-review.json"));
  await assert.rejects(command(repo, ["review"], env), /foreign or malformed/);
  assert.deepEqual(await readFile(path.join(repo, ".git/oracle/active-review.json")), pointer);
});

test("native original-clock context binds lifecycle timing while execution environment stays unchanged", async (t) => {
  const {repo, env, prepare} = await fixture(t); await prepare();
  const context = {schema: "my-crm.shipment-context/v1", review_started_at: "2026-10-21T02:47:36.376299Z", release_started_at: "2026-10-21T07:48:57Z",
    provenance: {source: "Synthetic original owner instruction"}};
  await writeFile(path.join(repo, ".git/oracle/shipment-context.json"), JSON.stringify({...context, sha256: bindingHash(context)}));
  await command(repo, ["review"], env);
  const owner = JSON.parse(await readFile(path.join(repo, ".git/oracle/controllers/00000000.json")));
  assert.equal(owner.review_started_at, context.review_started_at); assert.equal(owner.release_started_at, context.release_started_at);
  assert.equal(owner.clock_context.sha256, bindingHash(context));
  const record = JSON.parse(await readFile(path.join(repo, ".git/oracle/approval.json")));
  assert.equal(record.input_binding.reviewer_settings.model, "synthetic-test-model");
});

test("detached reviewed source survives identical-tree publication merge and delivery", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  const baseline = await git("rev-parse", "HEAD");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic reviewed source");
  const source = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
  await command(repo, ["review"], env);
  const merge = await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit-tree", tree, "-p", baseline, "-p", source, "-m", "Synthetic exact-tree publication");
  await git("update-ref", "refs/heads/main", merge); await git("update-ref", "refs/remotes/origin/main", merge);
  const {shipmentPlan, recordDeliveredCommit, runShipment, readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const admitted = await admitDeployment({root: repo});
  assert.equal(admitted.source_commit, merge); assert.equal(admitted.reviewed_source_commit, source);
  assert.equal((await shipmentPlan({root: repo})).action, "DELIVER");
  assert.match((await command(repo, ["verify-commit", merge], env)).stdout, /ORACLE_COMMIT=APPROVED/);
  await recordDeliveredCommit({root: repo, admission: admitted, installation: {pluginId: "my-crm@synthetic", release: {content_sha256: "a".repeat(64)}}});
  assert.equal((await readValidatedCheckpoint(repo)).record.last_validated_commit, source);
  const fail = async () => { throw new Error("Unexpected repeated release callback"); };
  assert.equal((await runShipment({root: repo, prepare: fail, validate: fail, deliver: fail})).action, "NO_CHANGES");
  const wrongTree = await git("rev-parse", `${baseline}^{tree}`);
  const wrong = await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit-tree", wrongTree, "-p", baseline, "-p", source, "-m", "Synthetic changed-tree merge");
  await assert.rejects(admitDeployment({root: repo, reference: wrong}), /exact-tree|reviewed|matching/);
});

test("same committed source reopens changed governing criteria and failed invocation", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic governed source");
  const source = await git("rev-parse", "HEAD"); await command(repo, ["review"], env);
  const {shipmentPlan, readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const first = await readValidatedCheckpoint(repo);
  const authority = path.join(repo, "Vault/docs/CONSTITUTION.md"), original = await readFile(authority);
  await writeFile(authority, Buffer.concat([original, Buffer.from("\nSynthetic changed criterion.\n")]));
  assert.equal((await shipmentPlan({root: repo})).action, "VALIDATE");
  await command(repo, ["review"], env);
  assert.equal(await git("rev-parse", "HEAD"), source);
  assert.notEqual((await readValidatedCheckpoint(repo)).receipt.receipt_sha256, first.receipt.receipt_sha256);
  const current = await readFile(authority); await writeFile(authority, Buffer.concat([current, Buffer.from("\nSynthetic failed-attempt criterion.\n")]));
  await assert.rejects(command(repo, ["review"], {...env, ORACLE_NO_OUTPUT: "1"}), /ORACLE_PROCESS=ERROR/);
  await writeFile(authority, current);
  assert.equal((await shipmentPlan({root: repo})).action, "VALIDATE");
  await command(repo, ["review"], env);
  assert.equal((await shipmentPlan({root: repo})).action, "DELIVER");
  assert.equal(await git("rev-parse", "HEAD"), source);
});

test("current applicability guards publication and every maintainer installation mutation", async (t) => {
  const {repo, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic governed publication");
  const source = await git("rev-parse", "HEAD"); await command(repo, ["review"], env);
  const {shipmentPlan, recordDeliveredCommit} = await import("../scripts/shipment-state.mjs");
  const authority = path.join(repo, "Vault/docs/CONSTITUTION.md"), original = await readFile(authority);
  const installation = {pluginId: "my-crm@synthetic", release: {content_sha256: "a".repeat(64)}};
  const plan = () => shipmentPlan({root: repo}), admit = () => admitDeployment({root: repo});
  let installers = 0, mutations = 0;
  const install = async () => { installers++; return installation; };
  const recordDelivery = (options) => recordDeliveredCommit({...options, root: repo});
  await writeFile(authority, Buffer.concat([original, Buffer.from("\nSynthetic changed publication criterion.\n")]));
  assert.equal((await plan()).action, "VALIDATE");
  await assert.rejects(admit(), /changed/);
  await assert.rejects(installReviewed({plan, admit, install, recordDelivery}), /changed|applicable/);
  assert.equal(installers, 0); assert.equal(mutations, 0);
  await command(repo, ["review"], env);
  const current = await readFile(authority);
  assert.equal((await admit()).status, "ADMITTED");
  await assert.rejects(installReviewed({plan, admit, recordDelivery,
    runCommand: async () => { mutations++; },
    install: async ({runCommand}) => {
      installers++;
      await writeFile(authority, Buffer.concat([current, Buffer.from("\nSynthetic late criterion drift.\n")]));
      await runCommand(["plugin", "add", "my-crm@synthetic"]);
      return installation;
    }}), /applicable/);
  assert.equal(mutations, 0);
  await writeFile(authority, current); await git("update-ref", "refs/remotes/origin/main", source);
  assert.equal((await installReviewed({plan, admit, install, recordDelivery})).pluginId, installation.pluginId);
  assert.equal((await plan()).action, "NO_CHANGES");
  const unexpected = async () => { throw new Error("Unexpected repeated installation callback"); };
  assert.equal((await installReviewed({plan, admit: unexpected, install: unexpected, recordDelivery: unexpected})).action, "NO_CHANGES");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-qm", "Synthetic unvalidated current commit");
  await assert.rejects(admitDeployment({root: repo}), /exact-tree|stamp|reviewed/);
  assert.equal((await admitDeployment({root: repo, reference: source})).source_commit, source);
});

test("maintainer selection rejects pending technical approval before installer callbacks", async () => {
  for (const action of ["PREPARE", "VALIDATE", "NO_CHANGES"]) {
    let callbacks = 0;
    await assert.rejects(installReviewed({
      plan: async () => ({action, approval_state: "PENDING", candidate_commit: "a".repeat(40)}),
      admit: async () => ({status: "ADMITTED", technical_mode: "COMMITTED_CHECKPOINT", source_commit: "a".repeat(40)}),
      install: async () => { callbacks++; }
    }), /applicable|clean canonical/);
    assert.equal(callbacks, 0);
  }
});

test("checkpoint applicability rejects current drift before history and retains final custody", async (t) => {
  const {repo, root, env, git, prepare} = await fixture(t); await prepare(); await git("branch", "-m", "main");
  await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic current status");
  await command(repo, ["review"], env);
  const {readValidatedCheckpoint} = await import("../scripts/shipment-state.mjs");
  const originalCheckpoint = await readValidatedCheckpoint(repo);
  const archive = path.join(repo, ".git/oracle/technical-receipts", `${originalCheckpoint.receipt.receipt_sha256}.json`);
  const archiveBytes = await readFile(archive);
  const authority = path.join(repo, "Vault/docs/CONSTITUTION.md"), authorityBytes = await readFile(authority);
  const historyFile = path.join(repo, ".git/oracle/deployment-baseline.json"), historyBytes = await readFile(historyFile);
  const calls = path.join(repo, ".git/history-calls.jsonl"), mutation = path.join(repo, ".git/history-mutation-applied");
  const gitBinary = (await executableBinding("git", process.env, repo)).path;
  await writeFile(path.join(root, "bin/git"), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'rev-list' && args.includes('--topo-order')) {
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
  if (process.env.SHIPMENT_TEST_MUTATE_HISTORY && !fs.existsSync(${JSON.stringify(mutation)})) {
    fs.writeFileSync(${JSON.stringify(mutation)}, 'applied');
    fs.appendFileSync(${JSON.stringify(authority)}, '\\nSynthetic authority arrived during history.\\n');
  }
}
const result = require('node:child_process').spawnSync(${JSON.stringify(gitBinary)}, args, {stdio: 'inherit'});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`, {mode: 0o700});
  const statusScript = fileURLToPath(new URL("../scripts/shipment-state.mjs", import.meta.url));
  const plan = async (extra = {}) => {
    await writeFile(calls, "");
    const result = await execute(process.execPath, [statusScript], {cwd: repo, env: {...process.env, ...env, ...extra}});
    return {selection: JSON.parse(result.stdout), historyCalls: (await readFile(calls, "utf8")).trim()};
  };

  await writeFile(authority, Buffer.concat([authorityBytes, Buffer.from("\nSynthetic current authority drift.\n")]));
  const drifted = await plan();
  assert.equal(drifted.selection.action, "VALIDATE"); assert.equal(drifted.selection.approval_state, "PENDING");
  assert.match(drifted.selection.reason, /inputs drifted/); assert.equal(drifted.historyCalls, "");

  await writeFile(authority, authorityBytes);
  const matching = await plan();
  assert.equal(matching.selection.action, "DELIVER"); assert.match(matching.historyCalls, /rev-list/);

  await writeFile(historyFile, JSON.stringify({...JSON.parse(historyBytes), first_receipt_sha256: "f".repeat(64)}));
  const brokenHistory = await plan();
  assert.equal(brokenHistory.selection.action, "VALIDATE"); assert.equal(brokenHistory.selection.approval_state, "PENDING");
  assert.match(brokenHistory.historyCalls, /rev-list/); assert.match(brokenHistory.selection.reason, /inputs drifted/);

  await writeFile(historyFile, historyBytes);
  const late = await plan({SHIPMENT_TEST_MUTATE_HISTORY: "1"});
  assert.equal(late.selection.action, "VALIDATE"); assert.equal(late.selection.approval_state, "PENDING");
  assert.match(late.historyCalls, /rev-list/); assert.match(late.selection.reason, /inputs drifted/);
  await writeFile(authority, authorityBytes);
  assert.equal((await plan()).selection.action, "DELIVER");
  assert.deepEqual(await readFile(archive), archiveBytes);
  assert.deepEqual((await readValidatedCheckpoint(repo)).record, originalCheckpoint.record);
});
