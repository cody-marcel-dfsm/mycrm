import {publishedContract, requiredFor} from "./validation-contract.mjs";
import {access} from "node:fs/promises";
import {execFile, execFileSync, spawn, spawnSync} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import process from "node:process";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = args => new Promise((resolve, reject) => {
  const child = spawn(args[0], args.slice(1), {cwd: root, stdio: "inherit"});
  child.once("error", reject); child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Required release validation failed: ${args.join(" ")} (${signal ?? code})`)));
});
// Genuine documentation; executable guidance and client/plugin text are not.
export const documentationPath = name => name.endsWith(".md") && !["AGENTS.md", "CLAUDE.md"].includes(name) && !/^(?:\.agents|\.claude|plugins|clients)\//.test(name);
function changedPaths(directory) {
  const git = args => execFileSync("git", args, {cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024}).trim();
  const parent = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^"], {cwd: directory, encoding: "utf8"}).status === 0;
  return (parent ? git(["diff", "--name-only", "HEAD^", "HEAD"]) : git(["ls-tree", "-r", "--name-only", "HEAD"])).split("\n").filter(Boolean);
}
// Fail before any test: a non-documentation change needs the contract's sealed
// oracle-spec/1, and publishedContract rejects a missing or mismatched seal.
export function assertSealedSpec(directory = root, {changed} = {}) {
  const contract = publishedContract(directory);
  if (contract) return contract;
  const executable = (changed ?? changedPaths(directory)).filter(name => !documentationPath(name));
  if (executable.length) throw new Error(`Sealed Oracle spec is missing for non-documentation changes: ${executable.slice(0, 8).join(", ")}${executable.length > 8 ? ", ..." : ""}; run the native proposal`);
  return null;
}
export async function validateRelease({execute = run, nativeEvidence, priorCoverage, sealed = assertSealedSpec} = {}) {
  const contract = sealed(root);
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
  for (const command of requiredFor(contract)) {
    const covered = priorCoverage?.covered?.find(item => JSON.stringify(item.command) === JSON.stringify(command));
    if (covered) {console.log(`MYCRM_VALIDATION_REUSED=${JSON.stringify({command, provenance: "ORIGINAL_NATIVE_EXECUTION", coverage: covered.coverage, executions: covered.original_executions})}`); continue;}
    // Missing native coverage executes every required command honestly.
    const args = nativeEvidence ? [process.execPath, path.join(root, "scripts/oracle-review.mjs"), "validate", "--", ...command] : command;
    await execute(args);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) validateRelease().catch(error => {console.error(`MYCRM_RELEASE_CHECK=FAILED ${error.message}`); process.exitCode = 1;});
