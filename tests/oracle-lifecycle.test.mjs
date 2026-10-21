import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdtemp, mkdir, readFile, rm, writeFile, cp, realpath, lstat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import test from "node:test";
import {observeReviewController} from "../scripts/oracle-lifecycle.mjs";
import {atomicJson, bindingHash, contentHash} from "../scripts/oracle-inputs.mjs";

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

async function producerFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mycrm-fresh-producer-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const worker = path.join(root, "oracle-attempt.mjs"); await cp(new URL("../scripts/oracle-attempt.mjs", import.meta.url), worker);
  const bootstrap = path.join(root, "oracle-bootstrap.mjs"); await cp(new URL("../scripts/oracle-bootstrap.mjs", import.meta.url), bootstrap);
  const modules = ["oracle-policy.mjs", "oracle-review.mjs", "oracle-attempt.mjs", "oracle-bootstrap.mjs", "emitter.mjs"];
  await writeFile(path.join(root, "oracle-policy.mjs"), `export const policyModules = ${JSON.stringify(modules)};`);
  await writeFile(path.join(root, "oracle-review.mjs"), 'import {role} from "./emitter.mjs"; import {policyModules} from "./oracle-policy.mjs"; export async function runReviewAttempt(args, {producer, verifyProducer, onAdmitted}) {await verifyProducer(); onAdmitted(); return {role, producer, policyModules};}');
  await writeFile(path.join(root, "emitter.mjs"), 'export const role = "original trusted role";');
  await writeFile(path.join(root, ".gitignore"), "*-ready\n*-go\n");
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim(); await git("init", "-q");
  const commit = async () => {await git("add", ".");await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic producer snapshot");}; await commit();
  const selected = async () => {const stat = await lstat(bootstrap, {bigint: true}); return {bootstrap: {sha256: contentHash(await readFile(bootstrap)), identity: {dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs),mode:String(stat.mode)}}, candidate_commit: await git("rev-parse", "HEAD")};};
  const invoke = async (expected) => {const output=await execute(process.execPath, [bootstrap,JSON.stringify(expected ?? await selected())],{cwd:root}).catch(error=>error);return JSON.parse(output.stdout.trim().split("ORACLE_ATTEMPT_RESULT=")[1]);};
  return {root,worker,bootstrap,modules,commit,selected,invoke};
}

test("native attempt workers load fresh producer modules and retain their actual source identities", async (t) => {
  const f = await producerFixture(t), first = await f.invoke(); assert.equal(first.result.role, "original trusted role");
  await writeFile(path.join(f.root, "emitter.mjs"), 'export const role = "current trusted role";'); await f.commit();
  const second = await f.invoke(); assert.equal(second.result.role, "current trusted role");
  assert.notEqual(first.result.producer.source_sha256["emitter.mjs"], second.result.producer.source_sha256["emitter.mjs"]);
});

test("policy loading and closure movement after the initial snapshot rejects the cached graph", async (t) => {
  const f = await producerFixture(t), ready = path.join(f.root,"policy-ready"), go=path.join(f.root,"policy-go");
  await writeFile(path.join(f.root,"oracle-policy.mjs"), `import {writeFile,access} from 'node:fs/promises'; export const policyModules = ${JSON.stringify(f.modules)}; await writeFile(${JSON.stringify(ready)},'ready'); while(true){try{await access(${JSON.stringify(go)});break;}catch{await new Promise(r=>setTimeout(r,10));}}`); await f.commit();
  const running=f.invoke(); for(let count=0;count<1000;count++){try{await readFile(ready);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  await writeFile(path.join(f.root,"oracle-policy.mjs"),`export const policyModules = ${JSON.stringify([...f.modules,"added.mjs"])};`);
  await writeFile(path.join(f.root,"added.mjs"),"export const added = true;");await f.commit();await writeFile(go,"go");
  const result=await running;assert.equal(result.failure.code,"ORACLE_INPUT_DRIFT");assert.equal(result.admitted,false);assert.equal(result.result,null);
});

test("bootstrap and worker movement cannot be accepted using a cached caller binding", async (t) => {
  const f=await producerFixture(t), expected=await f.selected();
  await writeFile(f.bootstrap,(await readFile(f.bootstrap,"utf8"))+"\n// Arrived bootstrap source\n");await f.commit();
  assert.equal((await f.invoke(expected)).failure.code,"ORACLE_INPUT_DRIFT");
  const ready=path.join(f.root,"worker-ready"),go=path.join(f.root,"worker-go");
  await writeFile(f.worker,(await readFile(f.worker,"utf8"))+`\nconst {writeFile:signal,access:exists}=await import('node:fs/promises');await signal(${JSON.stringify(ready)},'ready');while(true){try{await exists(${JSON.stringify(go)});break;}catch{await new Promise(r=>setTimeout(r,10));}}`);await f.commit();
  const running=f.invoke();for(let count=0;count<1000;count++){try{await readFile(ready);break;}catch{await new Promise(r=>setTimeout(r,10));}}
  await writeFile(f.worker,(await readFile(f.worker,"utf8"))+"\n// Arrived worker source\n");await f.commit();await writeFile(go,"go");
  const result=await running;assert.equal(result.failure.code,"ORACLE_INPUT_DRIFT");assert.equal(result.admitted,false);
});
