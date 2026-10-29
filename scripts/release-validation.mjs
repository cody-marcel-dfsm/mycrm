import {publishedContract, requiredFor} from "./validation-contract.mjs";
import {access} from "node:fs/promises";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = args => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), {cwd: root, stdio: "inherit"});
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Required release validation failed: ${args.join(" ")} (${signal ?? code})`)));
});
export async function validateRelease({execute = run, nativeEvidence, priorCoverage} = {}) {
  if (nativeEvidence === undefined) {
    try { await access(path.join(root, "Vault/docs/CONSTITUTION.md")); nativeEvidence = true; }
    catch (error) { if (error.code !== "ENOENT") throw error; nativeEvidence = false; }
  }
  if (priorCoverage === undefined && !nativeEvidence && process.env.GITHUB_ACTIONS === "true") {
    const call = promisify(execFile), sourceCommit = (await call("git", ["rev-parse", "HEAD"], {cwd: root})).stdout.trim();
    const sourceTree = (await call("git", ["rev-parse", "HEAD^{tree}"], {cwd: root})).stdout.trim();
    priorCoverage = process.env.MYCRM_VALIDATION_SOURCE_SHA && process.env.MYCRM_VALIDATION_SOURCE_SHA !== sourceCommit
      ? {covered: [], invalidated: [{reason: "CI checkout differs from its exact event source commit"}]}
      : await (await import("./validation-transport.mjs")).importNativeValidation({repository: process.env.GITHUB_REPOSITORY, sourceCommit, sourceTree});
  }
  for (const invalidation of priorCoverage?.invalidated ?? []) console.log(`MYCRM_VALIDATION_INVALIDATED=${JSON.stringify(invalidation)}`);
  for (const command of requiredFor(publishedContract(root))) {
    const covered = priorCoverage?.covered?.find(item => JSON.stringify(item.command) === JSON.stringify(command));
    if (covered) {console.log(`MYCRM_VALIDATION_REUSED=${JSON.stringify({command, provenance: "ORIGINAL_NATIVE_EXECUTION", coverage: covered.coverage, executions: covered.original_executions})}`); continue;}
    // Missing native coverage executes every required command honestly.
    const args = nativeEvidence ? [process.execPath, path.join(root, "scripts/oracle-review.mjs"), "validate", "--", ...command] : command;
    await execute(args);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validateRelease().catch(error => {console.error(error.message); process.exitCode = 1;});
