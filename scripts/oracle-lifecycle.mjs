// Live controller observations are separate from immutable receipt invocation custody.
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile, realpath, readdir, lstat} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import process from "node:process";
import {atomicJson, bindingHash, contentHash, metadataDirectory, readMetadataFile} from "./oracle-inputs.mjs";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nativeParent = (command) => /^(?:\S*\/)?node(?:\s+--\S+)*\s+\S*oracle-review\.mjs\s+review(?:\s|$)/.test(Array.isArray(command) ? command.join(" ") : command ?? "");
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
  if (typeof command !== "string" || !nativeParent(command)) throw new Error("Review controller is not a native completed-review parent");
  const directory = path.join(state.directory, record.id);
  if (record.legacy_invocation) {
    const filename = path.join(state.owner, "oracle", "runs", record.legacy_invocation.id, "outcome.json");
    const native = await optional(filename, state.owner);
    if (native) {
      if (native.kind !== "review" || typeof native.started_at !== "string" || typeof native.finished_at !== "string") throw new Error("Legacy native review outcome is malformed");
      return {...record, directory, state: "TERMINAL", outcome: {outcome: native.outcome,
        native_outcome: native, native_outcome_file: filename, native_outcome_sha256: contentHash(await readMetadataFile(filename)),
        result: {action: "LEGACY_REVIEW_COMPLETED", native_outcome: native, invocation: record.legacy_invocation}, error: null}};
    }
  }
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

async function processStartedBefore(identity, timestamp) {
  if (process.platform === "darwin") {
    const [seconds, micros] = identity.birth.split(":").map(Number);
    return seconds * 1000 + micros / 1000 <= timestamp;
  }
  const boot = (await readFile("/proc/stat", "utf8")).match(/^btime (\d+)$/m)?.[1];
  const ticks = Number((await execute("getconf", ["CLK_TCK"])).stdout.trim());
  return boot && ticks && Number(boot) * 1000 + Number(identity.birth) * 1000 / ticks <= timestamp;
}

async function legacyController(state) {
  const filename = path.join(state.owner, "oracle", "active-review.json");
  const invocation = await optional(filename, state.owner);
  if (!invocation) return null;
  if (invocation.kind !== "review" || !/^[a-f0-9-]{36}$/.test(invocation.id ?? "")) throw new Error("Pending native review invocation is malformed");
  const run = path.join(state.owner, "oracle", "runs", invocation.id);
  if (await optional(path.join(run, "outcome.json"), state.owner)) return null;
  const publishedAt = (await lstat(filename)).mtimeMs;
  const rows = (await execute("ps", ["-axo", "pid=,ppid=,command="], {maxBuffer: 16 * 1024 * 1024})).stdout.split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
    .map((item) => ({pid: Number(item[1]), parent: Number(item[2]), command: item[3]}));
  const candidates = [];
  for (const row of rows) {
    if (row.pid === process.pid || !nativeParent(row.command)) continue;
    const identity = await controllerProcess(row.pid);
    if (!identity || identity.root !== state.root || !await processStartedBefore(identity, publishedAt)) continue;
    const boundChild = rows.some((child) => child.parent === row.pid && child.command.includes(`${run}${path.sep}`));
    candidates.push({identity, boundChild});
  }
  const bound = candidates.filter((item) => item.boundChild), eligible = bound.length ? bound : candidates;
  if (!eligible.length) return null;
  if (eligible.length !== 1) throw new Error("Multiple live legacy review parents cannot be bound unambiguously; retain their native work");
  const after = await optional(filename, state.owner);
  if (bindingHash(after) !== bindingHash(invocation) || (await lstat(filename)).mtimeMs !== publishedAt) return legacyController(state);
  const evidence = await optional(path.join(run, "evidence.json"), state.owner);
  const execution = await optional(path.join(run, "process.json"), state.owner);
  return {process: eligible[0].identity, legacy_invocation: invocation,
    candidate_commit: evidence?.inputs?.candidate_commit ?? null,
    legacy_phase: execution ? "FINALIZING" : evidence ? "ASSESSING" : "PREPARING",
    legacy_binding: eligible[0].boundChild ? "DIRECT_CHILD_NATIVE_RUN" : "UNIQUE_PARENT_ROOT_BIRTH_AND_NATIVE_ADMISSION"};
}

export async function activeReviewController(root = process.cwd()) {
  const state = await layout(root);
  // Immutable, atomically created generation observations give simultaneous
  // starters one real live owner. No record is removed or held as a source lock.
  for (let generation = 0; generation < 100000; generation++) {
    const filename = path.join(state.directory, `${String(generation).padStart(8, "0")}.json`);
    const record = await optional(filename, state.owner);
    if (!record) {
      const legacy = await legacyController(state);
      return legacy ? {...legacy, legacy_unregistered: true, state: "RUNNING", root: state.root} : null;
    }
    const current = await inspect(record, state);
    if (current.state === "RUNNING") return current;
  }
  throw new Error("Review controller observation history exceeds its supported bound");
}

async function claim(state) {
  const identity = await controllerProcess(process.pid);
  if (!identity || identity.root !== state.root) throw new Error("Cannot verify this native review controller process");
  let previous = null, priorReview = null, priorRelease = null;
  for (let generation = 0; generation < 100000; generation++) {
    const filename = path.join(state.directory, `${String(generation).padStart(8, "0")}.json`);
    const existing = await optional(filename, state.owner);
    if (existing) {
      const current = await inspect(existing, state);
      if (current.state === "RUNNING") return {record: current, owned: false};
      previous = {controller_id: current.id, generation, observed_state: current.state, source_verdict: null};
      priorReview = current.review_started_at ?? priorReview;
      priorRelease = current.release_started_at ?? priorRelease;
      continue;
    }
    const legacy = await legacyController(state);
    // A contender may have published while process discovery was in flight.
    // Follow that actual observation instead of adopting the new parent twice.
    if (await optional(filename, state.owner)) { generation--; continue; }
    const record = seal({schema: "my-crm.review-controller/v1", id: randomUUID(), generation,
      kind: "review", scope: "completed-source", root: state.root, process: identity, ...legacy,
      started_at: new Date().toISOString(), review_started_at: process.env.MYCRM_REVIEW_STARTED_AT ?? priorReview,
      release_started_at: process.env.MYCRM_RELEASE_STARTED_AT ?? priorRelease, predecessor_observation: previous});
    try {
      await atomicJson(filename, record, {root: state.owner, exclusive: true});
      const directory = path.join(state.directory, record.id);
      await metadataDirectory(state.owner, directory);
      return {record: {...record, directory, state: "RUNNING"}, owned: !legacy};
    } catch (error) { if (error.code !== "EEXIST") throw error; }
    generation--; // Inspect the winner of this exact atomic publication.
  }
  throw new Error("Review controller admission history exceeds its supported bound");
}

export async function observeReviewController(record, {root = process.cwd(), args = []} = {}) {
  const state = await layout(root);
  if (record.legacy_unregistered) {
    for (;;) {
      const outcome = await optional(path.join(state.owner, "oracle", "runs", record.legacy_invocation.id, "outcome.json"), state.owner);
      if (outcome) return {action: "LEGACY_REVIEW_COMPLETED", native_outcome: outcome, invocation: record.legacy_invocation};
      const identity = await controllerProcess(record.process.pid);
      if (!identity || bindingHash(identity) !== bindingHash(record.process)) throw new Error("Legacy review process ended without its native outcome; retain original observations");
      await pause(500);
    }
  }
  const requestId = args.length ? `${randomUUID()}.json` : null;
  if (requestId) await atomicJson(path.join(record.directory, "requests", requestId),
    seal({controller_id: record.id, args, received_at: new Date().toISOString()}), {root: state.owner, exclusive: true});
  process.stdout.write(`ORACLE_REVIEW=ATTACHED controller=${record.id} pid=${record.process.pid}\n`);
  for (;;) {
    const original = await optional(path.join(state.directory, `${String(record.generation).padStart(8, "0")}.json`), state.owner);
    if (!original || original.sha256 !== record.sha256) throw new Error("Attached review controller observation changed");
    const current = await inspect(original, state);
    if (current.state === "TERMINAL") {
      if (current.outcome.error) throw new Error(`Attached review controller failed: ${current.outcome.error.message}`);
      if (record.legacy_invocation) {
        process.stdout.write(`ORACLE_REVIEW=LEGACY_COMPLETED invocation=${record.legacy_invocation.id} outcome=${current.outcome.outcome}\n`);
        return current.outcome.result;
      }
      if (requestId && !current.outcome.accepted_requests?.includes(requestId)) return {action: "UNCONSUMED_REVIEW_REQUEST"};
      if (current.outcome.result?.verdict === "REJECTED" || current.outcome.result?.review_status === "INCOMPLETE") process.exitCode = 1;
      process.stdout.write(`ORACLE_REVIEW=COMPLETED controller=${record.id} outcome=${current.outcome.outcome} receipt=${current.outcome.result?.receipt_sha256 ?? "NONE"}\n`);
      return current.outcome.result;
    }
    if (current.state !== "RUNNING") throw new Error("Attached review controller process ended without a terminal outcome; original observations retained");
    await pause(500);
  }
}

export async function withReviewController({root = process.cwd(), args = [], action}) {
  const state = await layout(root), admission = await claim(state), record = admission.record;
  if (!admission.owned) {
    const result = await observeReviewController(record, {root: state.root, args});
    if (result?.action === "LEGACY_REVIEW_COMPLETED") {
      const head = (await execute("git", ["rev-parse", "HEAD"], {cwd: state.root})).stdout.trim();
      if (record.candidate_commit && record.candidate_commit !== head || args.length) return withReviewController({root: state.root, args, action});
      if (result.native_outcome.outcome !== "APPROVED") throw new Error(`Legacy native review finished ${result.native_outcome.outcome}: ${result.native_outcome.error?.message ?? "unfinished or rejected assessment"}`);
    }
    return result?.action === "UNCONSUMED_REVIEW_REQUEST" ? withReviewController({root: state.root, args, action}) : result;
  }
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
  let result, failure, interrupted = false;
  const cancel = () => { interrupted = true; };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try { await progress({phase: "PREPARING"}); result = await action({record, progress, pendingArguments, cancelled: () => interrupted}); return result; }
  catch (error) { failure = error; throw error; }
  finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    await atomicJson(path.join(record.directory, "outcome.json"), seal({controller_id: record.id,
      finished_at: new Date().toISOString(), outcome: failure ? "ERROR" : result?.verdict ?? result?.review_status ?? result?.action ?? "COMPLETED",
      result: result ?? null, accepted_requests: [...requests], error: failure ? {name: failure.name, message: failure.message} : null}), {root: state.owner, exclusive: true});
  }
}
