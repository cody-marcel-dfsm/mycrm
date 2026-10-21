// Builtins only: verify the selected bootstrap before any repository import.
import {readFile, lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const facts = stat => ({dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), mode: String(stat.mode)});
const drift = () => Object.assign(new Error("Oracle producer modules moved; continue with a fresh native attempt"), {code: "ORACLE_INPUT_DRIFT"});
async function capture(filename) {
  const before = await lstat(filename, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink()) throw drift();
  const bytes = await readFile(filename), after = await lstat(filename, {bigint: true});
  if (JSON.stringify(facts(before)) !== JSON.stringify(facts(after))) throw drift();
  return {sha256: hash(bytes), identity: facts(after)};
}
const detachedOutput = error => { if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };
process.stdout.on("error", detachedOutput); process.stderr.on("error", detachedOutput);
let completed;
try {
  const selected = JSON.parse(process.argv[2]), bootstrap = await capture(new URL(import.meta.url));
  if (JSON.stringify(bootstrap) !== JSON.stringify(selected.bootstrap) || execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim() !== selected.candidate_commit) throw drift();
  if (execFileSync("git", ["diff", "--name-only"], {encoding: "utf8"}).trim() || execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {encoding: "utf8"}).trim()) throw Object.assign(new Error("Oracle candidate moved before producer import; await authored commits"), {code: "ORACLE_CANDIDATE_MOVED"});
  const worker = await capture(new URL("./oracle-attempt.mjs", import.meta.url));
  const {runAttempt} = await import("./oracle-attempt.mjs");
  completed = await runAttempt(process.argv.slice(3), {candidate_commit: selected.candidate_commit,
    "oracle-bootstrap.mjs": bootstrap, "oracle-attempt.mjs": worker});
} catch (error) { completed = {result: null, failure: {name: error.name, message: error.message, code: error.code ?? null}, admitted: false}; process.exitCode = 1; }
process.stdout.write(`ORACLE_ATTEMPT_RESULT=${JSON.stringify(completed)}\n`);
