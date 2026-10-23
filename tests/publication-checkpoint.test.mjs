import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import {admitPreparedPush, preparePublication, publishPrepared, readPreparedPublication, recordPublicationDecision} from "../scripts/publication-checkpoint.mjs";
import {validateRelease} from "../scripts/release-validation.mjs";
import {bindingHash} from "../scripts/oracle-inputs.mjs";

const execute = promisify(execFile), zeros = "0".repeat(40);
async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-publication-")));
  t.after(() => rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, "repo"), remote = path.join(parent, "remote.git");
  await execute("git", ["init", "--bare", remote]); await execute("git", ["clone", remote, root]);
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await git("checkout", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(root, "source.txt"), "synthetic published base\n"); await git("add", "."); await git("commit", "-m", "Synthetic base"); await git("push", "origin", "main");
  const before = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "synthetic validated source\n"); await git("add", "."); await git("commit", "-m", "Synthetic candidate");
  const source = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}"); let admissions = 0;
  const admit = async options => {admissions++; assert.equal(options.reference, source); return {status: "ADMITTED", source_commit: source, target_tree: tree, technical_receipt_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), protected_effects: []};};
  return {root, remote, git, before, source, tree, admit, admissions: () => admissions};
}

test("prepared publication admits once, binds changelist hashes and permits concurrent HEAD/source work", async t => {
  const f = await fixture(t), prepared = await preparePublication({root: f.root, remoteBefore: f.before, admit: f.admit});
  assert.equal(f.admissions(), 1); assert.equal(prepared.source_commit, f.source); assert.equal(prepared.source_tree, f.tree);
  assert.deepEqual(prepared.command_tracking.changelists, [{commit_sha: f.source, tree_sha: f.tree, validated_in_candidate: f.source}]);
  await writeFile(path.join(f.root, "source.txt"), "synthetic concurrent authored work\n"); await f.git("add", "."); await f.git("commit", "-m", "Synthetic later work");
  await writeFile(path.join(f.root, "unstaged.txt"), "synthetic concurrent unfinished work\n");
  const tuple = `fixed-source ${f.source} refs/heads/main ${f.before}\n`;
  const started = performance.now();
  await admitPreparedPush(tuple, {root: f.root, remote: "origin", remoteUrl: f.remote});
  assert.ok(performance.now() - started < 1000, "Bounded native publication admission exceeds one second");
  const calls = [];
  await publishPrepared(prepared.prepared_record, {root: f.root, run: async (args, cwd) => calls.push({args, cwd})});
  assert.deepEqual(calls, [{args: ["push", "origin", `${f.source}:refs/heads/main`], cwd: f.root}]);
  assert.equal(f.admissions(), 1, "Publishing reran validation/effect admission");
});

test("prepared publication rejects missing/altered proof and source/remote/destination/baseline mismatch", async t => {
  const f = await fixture(t), options = {root: f.root, remote: "origin", remoteUrl: f.remote};
  await assert.rejects(admitPreparedPush(`main ${f.source} refs/heads/main ${f.before}\n`, options), /ENOENT/);
  const prepared = await preparePublication({root: f.root, admit: f.admit});
  for (const [source, target, before, remote, remoteUrl] of [
    [f.before, "refs/heads/main", f.before, "origin", f.remote], [f.source, "refs/heads/main", zeros, "origin", f.remote],
    [f.source, "refs/heads/main", f.before, "different", f.remote], [f.source, "refs/heads/main", f.before, "origin", `${f.remote}-other`],
    [f.source, "refs/tags/v0.0.1", f.before, "origin", f.remote]
  ]) await assert.rejects(admitPreparedPush(`main ${source} ${target} ${before}\n`, {...options, remote, remoteUrl}), /ENOENT/);
  await assert.rejects(admitPreparedPush(`main ${zeros} refs/heads/main ${f.before}\n`, options), /deletion/);
  const original = JSON.parse(await readFile(prepared.prepared_record)); original.source_commit = f.before;
  await writeFile(prepared.prepared_record, JSON.stringify(original));
  await assert.rejects(readPreparedPublication(prepared.prepared_record, {root: f.root}), /malformed|changed/);
});

test("preparation rejects moved remote and publication preserves ordinary fast-forward rejection", async t => {
  const f = await fixture(t);
  await assert.rejects(preparePublication({root: f.root, remoteBefore: zeros, admit: f.admit}), /baseline changed/);
  assert.equal(f.admissions(), 0);
  const prepared = await preparePublication({root: f.root, admit: f.admit});
  await f.git("push", "origin", `${f.source}:refs/heads/main`);
  await assert.rejects(admitPreparedPush(`main ${f.source} refs/heads/main ${f.source}\n`, {root: f.root, remote: "origin", remoteUrl: f.remote}), /ENOENT/);
  await assert.rejects(publishPrepared(prepared.prepared_record, {root: f.root, run: async () => {throw new Error("Synthetic non-fast-forward rejected by Git");}}), /non-fast-forward/);
});

test("ordinary review refs need no private publication proof", async t => {
  const f = await fixture(t);
  await admitPreparedPush(`main ${f.source} refs/heads/codex/review ${zeros}\n`, {root: f.root, remote: "origin", remoteUrl: f.remote});
});

test("applicable complete coverage survives raw attempts; explicit rejection and criteria invalidation revoke publication", async t => {
  const f = await fixture(t); let prepared = await preparePublication({root: f.root, admit: f.admit});
  const binding = {root: f.root, sourceCommit: f.source, sourceTree: f.tree};
  const tuple = `fixed-source ${f.source} refs/heads/main ${f.before}\n`;
  for (const status of ["IN_PROGRESS", "INCOMPLETE", "ERROR"]) {
    const original = await recordPublicationDecision({...binding, status});
    assert.equal(original.status, status);
    await readPreparedPublication(prepared.prepared_record, {root: f.root});
    await admitPreparedPush(tuple, {root: f.root, remote: "origin", remoteUrl: f.remote});
  }
  for (const status of ["REJECTED", "INVALIDATED_CRITERIA"]) {
    await recordPublicationDecision({...binding, status});
    let calls = 0;
    await assert.rejects(publishPrepared(prepared.prepared_record, {root: f.root, run: async () => {calls++;}}), /later native candidate decision/);
    await assert.rejects(admitPreparedPush(tuple, {root: f.root, remote: "origin", remoteUrl: f.remote}), /later native candidate decision/);
    assert.equal(calls, 0, `${status} allowed mutation`);
    await assert.rejects(preparePublication({root: f.root, admit: f.admit}), /latest native candidate approval/);
    await recordPublicationDecision({...binding, status: "APPROVED", receipt: "a".repeat(64)});
    const renewed = await preparePublication({root: f.root, admit: f.admit});
    assert.notEqual(renewed.prepared_record, prepared.prepared_record);
    await assert.rejects(readPreparedPublication(prepared.prepared_record, {root: f.root}), /later native candidate decision/);
    prepared = renewed;
  }
  await admitPreparedPush(tuple, {root: f.root, remote: "origin", remoteUrl: f.remote});
  await readPreparedPublication(prepared.prepared_record, {root: f.root});
});

test("same-CL preparation consumes sealed validation without repeating deep admission", async t => {
  const f = await fixture(t), first = await preparePublication({root: f.root, admit: f.admit});
  const repeated = await preparePublication({root: f.root, admit: async () => {throw new Error("Repeated original-proof audit is forbidden");}});
  assert.equal(repeated.prepared_record, first.prepared_record); assert.equal(f.admissions(), 1);
});

test("legacy complete approval imports its validation seal once and repeated GitHub preparation reuses its attestation", async t => {
  const f = await fixture(t);
  await recordPublicationDecision({root: f.root, sourceCommit: f.source, sourceTree: f.tree, status: "APPROVED", receipt: "a".repeat(64)});
  await f.git("remote", "set-url", "--push", "origin", "https://github.com/synthetic-owner/synthetic-repository.git");
  let exports = 0;
  const attest = async () => {exports++; return {source_commit: f.source, source_tree: f.tree, envelope_sha256: "c".repeat(64), blob_sha: "d".repeat(40), status_context: "my-crm/native-validation"};};
  const first = await preparePublication({root: f.root, admit: f.admit, attest});
  const repeated = await preparePublication({root: f.root, admit: async () => {throw new Error("Legacy proof was audited twice");}, attest: async () => {throw new Error("Completed attestation was exported twice");}});
  assert.equal(repeated.prepared_record, first.prepared_record); assert.equal(f.admissions(), 1); assert.equal(exports, 1);
});

test("equivalent later complete approval preserves the original prepared decision and receipt", async t => {
  const f = await fixture(t), first = await preparePublication({root: f.root, admit: f.admit});
  const prior = (await readPreparedPublication(first.prepared_record, {root: f.root})).record;
  await recordPublicationDecision({root: f.root, sourceCommit: f.source, sourceTree: f.tree, status: "APPROVED", receipt: prior.admission.technical_receipt_sha256, decisionId: "synthetic-later-equivalent-decision"});
  const repeated = await preparePublication({root: f.root, admit: async () => {throw new Error("Equivalent complete coverage was audited twice");}});
  assert.equal(repeated.prepared_record, first.prepared_record);
  assert.equal((await readPreparedPublication(first.prepared_record, {root: f.root})).record.decision_sha256, prior.decision_sha256);
});

test("complete review bookkeeping preserves native prepared coverage while a changed consumed proof invalidates it", async t => {
  const f = await fixture(t), binding = {root: f.root, sourceCommit: f.source, sourceTree: f.tree};
  const plan = (receiptHash, output = "original-output") => ({commit: f.source, reviewedCommit: f.source, tree: f.tree, effects: [], plan_sha256: "b".repeat(64),
    receipt: {receipt_sha256: receiptHash, candidate_commit: f.source, deployment_baseline_commit: f.before, deployment_history_status: "READY", deployment_history_sha256: "f".repeat(64),
      input_binding: {authorities: [], validation: [{sha256: output}]}, coverage: [{path: "source.txt", dependencies: ["source.txt"], criteria: ["synthetic-required-check"], assessment: `review ${receiptHash}`}], reused_coverage: []}});
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "a".repeat(64), validationPlan: plan("a".repeat(64))});
  const first = await preparePublication({root: f.root});
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "d".repeat(64), validationPlan: plan("d".repeat(64))});
  assert.equal((await preparePublication({root: f.root})).prepared_record, first.prepared_record);
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "e".repeat(64), validationPlan: plan("e".repeat(64), "changed-output")});
  await assert.rejects(readPreparedPublication(first.prepared_record, {root: f.root}), /later native candidate decision/);
});

test("direct sealed preparation checks governing applicability and preserves technical approval with unavailable history", async t => {
  const f = await fixture(t), binding = {root: f.root, sourceCommit: f.source, sourceTree: f.tree};
  await mkdir(path.join(f.root, "Vault/docs"), {recursive: true}); const authority = path.join(f.root, "Vault/docs/CONSTITUTION.md");
  const original = "Synthetic original governing criterion.\n"; await writeFile(authority, original);
  const plan = (receiptHash, content, history = "READY") => ({commit: f.source, reviewedCommit: f.source, tree: f.tree, effects: [], plan_sha256: "b".repeat(64),
    receipt: {receipt_sha256: receiptHash, candidate_commit: f.source, deployment_baseline_commit: history === "READY" ? f.before : null,
      deployment_history_status: history, deployment_history_sha256: "f".repeat(64), input_binding: {authorities: [{path: "Vault/docs/CONSTITUTION.md", sha256: createHash("sha256").update(content).digest("hex")}]}}});
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "a".repeat(64), validationPlan: plan("a".repeat(64), original)});
  const first = await preparePublication({root: f.root});
  const changed = "Synthetic changed governing criterion.\n"; await writeFile(authority, changed);
  await assert.rejects(preparePublication({root: f.root}), /Governing authority changed/);
  await assert.rejects(readPreparedPublication(first.prepared_record, {root: f.root}), /later native candidate decision/);
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "c".repeat(64), validationPlan: plan("c".repeat(64), changed, "UNAVAILABLE")});
  await assert.rejects(preparePublication({root: f.root}), /complete READY history binding/);
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "d".repeat(64), validationPlan: plan("d".repeat(64), changed)});
  const renewed = await preparePublication({root: f.root});
  await publishPrepared(renewed.prepared_record, {root: f.root, run: async () => {}});
});

test("a pending same-candidate issuance preserves prior prepared readiness until its own terminals complete", async t => {
  const f = await fixture(t), binding = {root: f.root, sourceCommit: f.source, sourceTree: f.tree};
  const first = await preparePublication({root: f.root, admit: f.admit});
  const admission = {invocation_id: randomUUID(), controller_id: randomUUID()};
  const receipt = {receipt_sha256: "c".repeat(64), candidate_commit: f.source, native_terminal_admission: admission, deployment_baseline_commit: f.before, input_binding: {authorities: [], validation: []}};
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: receipt.receipt_sha256, validationPlan: {commit: f.source, tree: f.tree, receipt, effects: []}});
  await readPreparedPublication(first.prepared_record, {root: f.root});
  const owner = path.join(f.root, ".git/oracle"), run = path.join(owner, "runs", admission.invocation_id), controller = path.join(owner, "controllers", admission.controller_id);
  await mkdir(run, {recursive: true}); await mkdir(controller, {recursive: true});
  await writeFile(path.join(run, "outcome.json"), JSON.stringify({kind: "review", outcome: "APPROVED", receipt_sha256: receipt.receipt_sha256, candidate_commit: f.source}));
  await readPreparedPublication(first.prepared_record, {root: f.root});
  const value = {controller_id: admission.controller_id, outcome: "APPROVED", result: {receipt_sha256: receipt.receipt_sha256, candidate_commit: f.source}, error: null};
  await writeFile(path.join(controller, "outcome.json"), JSON.stringify({...value, sha256: bindingHash(value)}));
  await assert.rejects(readPreparedPublication(first.prepared_record, {root: f.root}), /later native candidate decision/);
  await writeFile(path.join(controller, "outcome.json"), JSON.stringify({...value, sha256: "0".repeat(64)}));
  await assert.rejects(readPreparedPublication(first.prepared_record, {root: f.root}), /terminal admission changed/);
});

test("unrelated candidate decisions and proposal changes preserve fixed-source admission; changed markers fail closed", async t => {
  const f = await fixture(t), prepared = await preparePublication({root: f.root, admit: f.admit});
  await writeFile(path.join(f.root, "source.txt"), "synthetic later author\n"); await f.git("add", "."); await f.git("commit", "-m", "Synthetic unrelated candidate");
  await recordPublicationDecision({root: f.root, sourceCommit: await f.git("rev-parse", "HEAD"), sourceTree: await f.git("rev-parse", "HEAD^{tree}"), status: "ERROR"});
  await writeFile(path.join(f.root, ".git/oracle/proposal.json"), "synthetic unrelated proposal\n");
  await writeFile(path.join(f.root, "unfinished.txt"), "synthetic unfinished input\n");
  let calls = 0;
  await publishPrepared(prepared.prepared_record, {root: f.root, run: async () => {calls++;}});
  assert.equal(calls, 1);
  const marker = path.join(f.root, ".git/oracle/publication-prepared", `${f.source}-${f.tree}.decision`);
  const original = await readFile(marker);
  const value = JSON.parse(original); value.status = "ERROR"; await writeFile(marker, JSON.stringify(value));
  await assert.rejects(publishPrepared(prepared.prepared_record, {root: f.root, run: async () => {calls++;}}), /decision is malformed/);
  assert.equal(calls, 1);
  await writeFile(marker, original); await rm(marker);
  await assert.rejects(readPreparedPublication(prepared.prepared_record, {root: f.root}), /ENOENT/);
});

test("superseded whole-assessment errors retain their outcome without revoking the later decision", async t => {
  const f = await fixture(t), binding = {root: f.root, sourceCommit: f.source, sourceTree: f.tree};
  await recordPublicationDecision({...binding, status: "IN_PROGRESS", decisionId: "synthetic-earlier-attempt"});
  await recordPublicationDecision({...binding, status: "APPROVED", receipt: "a".repeat(64), decisionId: "synthetic-later-attempt"});
  const prepared = await preparePublication({root: f.root, admit: f.admit});
  const original = await recordPublicationDecision({...binding, status: "ERROR", decisionId: "synthetic-earlier-attempt", expectedDecisionId: "synthetic-earlier-attempt"});
  const archived = JSON.parse(await readFile(path.join(f.root, ".git/oracle/publication-prepared", `${original.record_sha256}.decision.json`)));
  assert.equal(archived.status, "ERROR");
  await readPreparedPublication(prepared.prepared_record, {root: f.root});
});

test("real Git publication uses the effective native hook and no heavy validator while authors move", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, ".githooks")); await mkdir(path.join(f.root, "scripts"));
  await cp(new URL("../.githooks/pre-push", import.meta.url), path.join(f.root, ".githooks/pre-push"));
  await chmod(path.join(f.root, ".githooks/pre-push"), 0o755);
  await cp(new URL("../scripts/publication-checkpoint.mjs", import.meta.url), path.join(f.root, "scripts/publication-checkpoint.mjs"));
  for (const name of ["oracle-deployment.mjs", "oracle-review.mjs", "oracle-validation.mjs", "shipment-state.mjs", "release-validation.mjs"]) await writeFile(path.join(f.root, "scripts", name), "throw new Error('Heavy validation is forbidden during prepared Git publication');\n");
  await f.git("config", "core.hooksPath", ".githooks");
  assert.equal(await f.git("config", "--get", "core.hooksPath"), ".githooks");
  const prepared = await preparePublication({root: f.root, admit: f.admit});
  await writeFile(path.join(f.root, "source.txt"), "synthetic concurrent source arrival\n"); await f.git("add", "."); await f.git("commit", "-m", "Synthetic concurrent author commit");
  await writeFile(path.join(f.root, "unfinished.txt"), "synthetic unfinished arrival\n");
  const started = performance.now(); await publishPrepared(prepared.prepared_record, {root: f.root});
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 10000, `Actual Git push exceeded ten seconds: ${elapsed}ms`);
  assert.equal((await execute("git", ["rev-parse", "refs/heads/main"], {cwd: f.remote})).stdout.trim(), f.source);
  assert.notEqual(await f.git("rev-parse", "HEAD"), f.source);
  assert.match(await f.git("status", "--porcelain=v1"), /unfinished.txt/);
  console.log(`MYCRM_SYNTHETIC_PUBLICATION_MS=${Math.round(elapsed)} effective_hook=.githooks/pre-push`);
});

test("every required release command participates in native evidence discovery; fresh CI executes every check", async () => {
  const native = [], publicRunner = [];
  await validateRelease({nativeEvidence: true, execute: async argv => native.push(argv)});
  await validateRelease({nativeEvidence: false, execute: async argv => publicRunner.push(argv)});
  const required = [["npm", "run", "build"], ["npm", "test"], ["npm", "run", "check:release"]];
  assert.deepEqual(native.map(argv => argv.slice(4)), required);
  assert.deepEqual(publicRunner, required);
});
