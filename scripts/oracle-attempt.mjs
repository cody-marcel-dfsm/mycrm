// No repository import precedes the producer snapshot.
import {readFile, lstat} from "node:fs/promises";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const facts = (stat) => ({dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs), mode: String(stat.mode)});
const drift = () => Object.assign(new Error("Oracle producer modules moved; continue with a fresh native attempt"), {code: "ORACLE_INPUT_DRIFT"});
const head = () => execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim();
async function source(name) {
  const filename = new URL(name, import.meta.url), before = await lstat(filename, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink()) throw drift();
  const bytes = await readFile(filename), after = await lstat(filename, {bigint: true});
  if (JSON.stringify(facts(before)) !== JSON.stringify(facts(after))) throw drift();
  return {sha256: hash(bytes), identity: facts(after), text: bytes.toString("utf8")};
}
export async function producerSnapshot() {
  const policy = await source("oracle-policy.mjs");
  const declarations = [...policy.text.matchAll(/export\s+const\s+policyModules\s*=\s*(\[[\s\S]*?\]);/g)];
  if (declarations.length !== 1) throw new Error("Producer closure requires one static declared module list");
  const modules = JSON.parse(declarations[0][1]);
  if (!Array.isArray(modules) || new Set(modules).size !== modules.length || !modules.includes("oracle-policy.mjs") || modules.some(name => typeof name !== "string" || !/^[a-z0-9-]+\.mjs$/.test(name))) throw new Error("Producer closure contains an unsafe or incomplete module declaration");
  const files = await Promise.all(modules.map(async name => [name, name === "oracle-policy.mjs" ? policy : await source(name)]));
  return {schema: "my-crm.oracle-producer/v2", candidate_commit: head(), policy_modules: modules,
    source_sha256: Object.fromEntries(files.map(([name, value]) => [name, value.sha256])),
    source_identity: Object.fromEntries(files.map(([name, value]) => [name, value.identity]))};
}
export async function assertProducerSnapshot(original) {
  if (JSON.stringify(original) !== JSON.stringify(await producerSnapshot())) throw drift();
}
export async function runAttempt(args, origin) {
  let result = null, failure = null, admitted = false;
  try {
    for (const name of ["oracle-bootstrap.mjs", "oracle-attempt.mjs"]) {
      const actual = await source(name), expected = origin?.[name];
      if (!expected || actual.sha256 !== expected.sha256 || JSON.stringify(actual.identity) !== JSON.stringify(expected.identity)) throw drift();
    }
    if (head() !== origin.candidate_commit) throw drift();
    const producer = await producerSnapshot();
    const {runReviewAttempt} = await import("./oracle-review.mjs");
    await assertProducerSnapshot(producer);
    result = await runReviewAttempt(args, {producer, verifyProducer: () => assertProducerSnapshot(producer), onAdmitted: () => { admitted = true; }});
  } catch (error) { failure = {name: error.name, message: error.message, code: error.code ?? null}; process.exitCode = 1; }
  return {result, failure, admitted};
}
