// Fresh module graph per native attempt; the live parent retains ownership.
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {policyModules} from "./oracle-policy.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function producerSnapshot() {
  return Object.fromEntries(await Promise.all(policyModules.map(async (name) => [name, hash(await readFile(new URL(name, import.meta.url)))])));
}
export async function assertProducerSnapshot(original) {
  const current = await producerSnapshot();
  if (JSON.stringify(original) !== JSON.stringify(current)) {
    const error = new Error("Oracle producer modules moved; continue with a fresh native attempt");
    error.code = "ORACLE_INPUT_DRIFT"; throw error;
  }
}

async function main() {
  // Losing the observing parent closes its pipes. Finish durable native custody
  // even when there is no longer an output consumer for this actual attempt.
  const detachedOutput = (error) => { if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error.code)) throw error; };
  process.stdout.on("error", detachedOutput); process.stderr.on("error", detachedOutput);
  let result = null, failure = null;
  try {
    const producer = await producerSnapshot();
    const {runReviewAttempt} = await import("./oracle-review.mjs");
    await assertProducerSnapshot(producer);
    result = await runReviewAttempt(process.argv.slice(2), {producer, verifyProducer: () => assertProducerSnapshot(producer)});
  } catch (error) { failure = {name: error.name, message: error.message, code: error.code ?? null}; process.exitCode = 1; }
  process.stdout.write(`ORACLE_ATTEMPT_RESULT=${JSON.stringify({result, failure})}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
