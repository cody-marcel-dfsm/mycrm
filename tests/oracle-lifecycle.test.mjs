import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile, cp, realpath} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import {observeReviewController} from "../scripts/oracle-lifecycle.mjs";
import {atomicJson, bindingHash} from "../scripts/oracle-inputs.mjs";

const execute = promisify(execFile), seal = (value) => ({...value, sha256: bindingHash(value)});
async function fixture(t, legacy = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mycrm-terminal-race-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await execute("git", ["init", "-q"], {cwd: root});
  const owner = path.join(root, ".git"), controllers = path.join(owner, "oracle/controllers"), id = randomUUID();
  const directory = path.join(controllers, id); await mkdir(directory, {recursive: true});
  const record = seal({schema: "my-crm.review-controller/v1", id, generation: 0, root: await realpath(root),
    kind: "review", scope: "completed-source", process: {pid: 42, birth: "synthetic-birth", command: ["node", "oracle-review.mjs", "review"]},
    ...(legacy ? {legacy_invocation: {id: randomUUID(), kind: "review"}} : {})});
  await atomicJson(path.join(controllers, "00000000.json"), record, {root: owner, exclusive: true});
  const terminal = legacy ? path.join(owner, "oracle/runs", record.legacy_invocation.id, "outcome.json") : path.join(directory, "outcome.json");
  const outcome = legacy ? {kind: "review", started_at: "synthetic-start", finished_at: "synthetic-finish", outcome: "APPROVED"}
    : seal({controller_id: id, outcome: "APPROVED", result: {verdict: "APPROVED"}, error: null});
  return {root, owner, record: {...record, directory}, terminal, outcome};
}

for (const legacy of [false, true]) test(`${legacy ? "legacy" : "registered"} observer reads a terminal publication that races process exit`, async (t) => {
  const f = await fixture(t, legacy);
  const result = await observeReviewController(f.record, {root: f.root, processIdentity: async () => {
    await atomicJson(f.terminal, f.outcome, {root: f.owner, exclusive: true}); return null;
  }});
  assert.equal(legacy ? result.native_outcome.outcome : result.verdict, "APPROVED");
  assert.deepEqual(JSON.parse(await readFile(f.terminal)), f.outcome);
});

test("unregistered legacy observer also rechecks terminal bytes after process disappearance", async (t) => {
  const f = await fixture(t, true);
  const result = await observeReviewController({...f.record, legacy_unregistered: true}, {root: f.root, processIdentity: async () => {
    await atomicJson(f.terminal, f.outcome, {root: f.owner, exclusive: true}); return null;
  }});
  assert.equal(result.action, "LEGACY_REVIEW_COMPLETED");
});

test("missing and altered terminal records retain observation failure", async (t) => {
  for (const altered of [false, true]) {
    const f = await fixture(t);
    await assert.rejects(observeReviewController(f.record, {root: f.root, processIdentity: async () => {
      if (altered) await atomicJson(f.terminal, {...f.outcome, outcome: "forged"}, {root: f.owner, exclusive: true});
      return null;
    }}), altered ? /digest differs/ : /ended without a terminal/);
  }
});

test("native attempt workers load fresh producer modules and retain their actual source identities", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mycrm-fresh-producer-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const worker = path.join(root, "oracle-attempt.mjs"); await cp(new URL("../scripts/oracle-attempt.mjs", import.meta.url), worker);
  await writeFile(path.join(root, "oracle-policy.mjs"), 'export const policyModules = ["oracle-policy.mjs", "oracle-review.mjs", "oracle-attempt.mjs", "emitter.mjs"];');
  await writeFile(path.join(root, "oracle-review.mjs"), 'import {role} from "./emitter.mjs"; export async function runReviewAttempt(args, {producer, verifyProducer}) {await verifyProducer(); return {role, producer};}');
  const invoke = async () => JSON.parse((await execute(process.execPath, [worker])).stdout.trim().split("ORACLE_ATTEMPT_RESULT=")[1]);
  await writeFile(path.join(root, "emitter.mjs"), 'export const role = "original trusted role";');
  const first = await invoke(); assert.equal(first.result.role, "original trusted role");
  await writeFile(path.join(root, "emitter.mjs"), 'export const role = "current trusted role";');
  const second = await invoke(); assert.equal(second.result.role, "current trusted role");
  assert.notEqual(first.result.producer["emitter.mjs"], second.result.producer["emitter.mjs"]);
  await writeFile(path.join(root, "oracle-review.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync(new URL("./emitter.mjs", import.meta.url), "changed during import"); export async function runReviewAttempt() {throw new Error("must not execute");}');
  const failed = await execute(process.execPath, [worker]).catch((error) => error);
  assert.equal(JSON.parse(failed.stdout.trim().split("ORACLE_ATTEMPT_RESULT=")[1]).failure.code, "ORACLE_INPUT_DRIFT");
});
