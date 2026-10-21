// Live controller observations are separate from immutable receipt invocation custody.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile, realpath, readdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import process from "node:process";
import {atomicJson, bindingHash, metadataDirectory, readMetadataFile} from "./oracle-inputs.mjs";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seal = (value) => ({...value, sha256: bindingHash(value)});
function verify(record) {
  const {sha256, ...value} = record;
  if (sha256 !== bindingHash(value)) throw new Error("Review controller observation digest differs");
  return record;
}
async function optional(filename, owner) {
  try { return JSON.parse(await readMetadataFile(filename, "utf8", {root: owner})); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function layout(root) {
  root = await realpath(root);
  const owner = (await execute("git", ["rev-parse", "--absolute-git-dir"], {cwd: root})).stdout.trim();
  const directory = path.join(owner, "oracle", "controllers");
  await metadataDirectory(owner, directory);
  return {root, owner, directory};
}

// Linux start ticks and Darwin's kernel birth microseconds distinguish PID reuse.
export async function controllerProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    let birth, cwd, command;
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      birth = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      cwd = await realpath(`/proc/${pid}/cwd`);
      command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      const after = await readFile(`/proc/${pid}/stat`, "utf8");
      if (after.slice(after.lastIndexOf(")") + 2).split(" ")[19] !== birth) return null;
    } else if (process.platform === "darwin") {
      const script = "import ctypes,json,sys\nclass Info(ctypes.Structure):\n _fields_=[('fields',ctypes.c_uint32*12),('comm',ctypes.c_char*16),('name',ctypes.c_char*32),('tail',ctypes.c_uint32*6),('sec',ctypes.c_uint64),('usec',ctypes.c_uint64)]\ni=Info();l=ctypes.CDLL('/usr/lib/libproc.dylib');n=l.proc_pidinfo(int(sys.argv[1]),3,0,ctypes.byref(i),ctypes.sizeof(i));print(str(i.sec)+':'+str(i.usec) if n==ctypes.sizeof(i) else '')";
      birth = (await execute("python3", ["-c", script, String(pid)])).stdout.trim();
      if (!birth) return null;
      const result = await execute("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
      command = (await execute("ps", ["-ww", "-p", String(pid), "-o", "command="])).stdout.trim();
      const after = (await execute("python3", ["-c", script, String(pid)])).stdout.trim();
      if (birth !== after) return null;
    } else throw new Error("Native review controller identity is unavailable on this platform");
    if (!cwd || !command.length) return null;
    return {pid, birth, root: await realpath(cwd), command};
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code) || typeof error.code === "number") return null;
    throw error;
  }
}

async function inspect(record, state) {
  verify(record);
  if (record.schema !== "my-crm.review-controller/v1" || record.root !== state.root || record.kind !== "review" || record.scope !== "completed-source" || !/^[a-f0-9-]{36}$/.test(record.id ?? "")) throw new Error("Review controller has foreign or malformed root, kind or scope");
  const command = Array.isArray(record.process?.command) ? record.process.command.join(" ") : record.process?.command;
  if (typeof command !== "string" || !/(?:^|\/)oracle-review\.mjs\s+review(?:\s|$)/.test(command)) throw new Error("Review controller is not a native completed-review parent");
  const directory = path.join(state.directory, record.id);
  const outcome = await optional(path.join(directory, "outcome.json"), state.owner);
  if (outcome) {
    verify(outcome);
    if (outcome.controller_id !== record.id) throw new Error("Review controller outcome identity differs");
    return {...record, directory, state: "TERMINAL", outcome};
  }
  const current = await controllerProcess(record.process?.pid);
  const live = current && bindingHash(current) === bindingHash(record.process);
  const progress = live ? await optional(path.join(directory, "progress.json"), state.owner) : null;
  return {...record, directory, state: live ? "RUNNING" : "STALE", progress};
}

export async function activeReviewController(root = process.cwd()) {
  const state = await layout(root);
  // Immutable, atomically created generation observations give simultaneous
  // starters one real live owner. No record is removed or held as a source lock.
  for (let generation = 0; generation < 100000; generation++) {
    const filename = path.join(state.directory, `${String(generation).padStart(8, "0")}.json`);
    const record = await optional(filename, state.owner);
    if (!record) return null;
    const current = await inspect(record, state);
    if (current.state === "RUNNING") return current;
  }
  throw new Error("Review controller observation history exceeds its supported bound");
}

async function claim(state) {
  const identity = await controllerProcess(process.pid);
  if (!identity || identity.root !== state.root) throw new Error("Cannot verify this native review controller process");
  for (let generation = 0; generation < 100000; generation++) {
    const filename = path.join(state.directory, `${String(generation).padStart(8, "0")}.json`);
    const existing = await optional(filename, state.owner);
    if (existing) {
      const current = await inspect(existing, state);
      if (current.state === "RUNNING") return {record: current, owned: false};
      continue;
    }
    const record = seal({schema: "my-crm.review-controller/v1", id: randomUUID(), generation,
      kind: "review", scope: "completed-source", root: state.root, process: identity,
      started_at: new Date().toISOString(), review_started_at: process.env.MYCRM_REVIEW_STARTED_AT ?? null,
      release_started_at: process.env.MYCRM_RELEASE_STARTED_AT ?? null});
    try {
      await atomicJson(filename, record, {root: state.owner, exclusive: true});
      const directory = path.join(state.directory, record.id);
      await metadataDirectory(state.owner, directory);
      return {record: {...record, directory, state: "RUNNING"}, owned: true};
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    generation--; // Inspect the winner of this exact atomic publication.
  }
  throw new Error("Review controller admission history exceeds its supported bound");
}

export async function observeReviewController(record, {root = process.cwd(), args = []} = {}) {
  const state = await layout(root);
  if (args.length) await atomicJson(path.join(record.directory, "requests", `${randomUUID()}.json`),
    seal({controller_id: record.id, args, received_at: new Date().toISOString()}), {root: state.owner, exclusive: true});
  process.stdout.write(`ORACLE_REVIEW=ATTACHED controller=${record.id} pid=${record.process.pid}\n`);
  for (;;) {
    const current = await inspect(record, state);
    if (current.state === "TERMINAL") {
      if (current.outcome.error) throw new Error(`Attached review controller failed: ${current.outcome.error.message}`);
      if (current.outcome.result?.verdict === "REJECTED" || current.outcome.result?.review_status === "INCOMPLETE") process.exitCode = 1;
      return current.outcome.result;
    }
    if (current.state !== "RUNNING") throw new Error("Attached review controller process ended without a terminal outcome; original observations retained");
    await pause(500);
  }
}

export async function withReviewController({root = process.cwd(), args = [], action}) {
  const state = await layout(root), admission = await claim(state), record = admission.record;
  if (!admission.owned) return observeReviewController(record, {root: state.root, args});
  const requests = new Set();
  const progress = (value) => atomicJson(path.join(record.directory, "progress.json"),
    {controller_id: record.id, updated_at: new Date().toISOString(), ...value}, {root: state.owner});
  const pendingArguments = async () => {
    const directory = path.join(record.directory, "requests");
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const result = [];
    for (const name of names.sort()) if (!requests.has(name)) {
      const item = verify(await optional(path.join(directory, name), state.owner));
      if (item.controller_id !== record.id || !Array.isArray(item.args) || item.args.some((arg) => typeof arg !== "string")) throw new Error("Attached review request is malformed or foreign");
      requests.add(name); result.push(...item.args);
    }
    return result;
  };
  let result, failure;
  try { await progress({phase: "PREPARING"}); result = await action({record, progress, pendingArguments}); return result; }
  catch (error) { failure = error; throw error; }
  finally {
    await atomicJson(path.join(record.directory, "outcome.json"), seal({controller_id: record.id,
      finished_at: new Date().toISOString(), outcome: failure ? "ERROR" : result?.verdict ?? result?.review_status ?? result?.action ?? "COMPLETED",
      result: result ?? null, error: failure ? {name: failure.name, message: failure.message} : null}), {root: state.owner, exclusive: true});
  }
}
