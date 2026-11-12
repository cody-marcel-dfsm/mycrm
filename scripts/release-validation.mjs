import {publishedContract, requiredFor} from "./validation-contract.mjs";
import {access} from "node:fs/promises";
import {readFileSync} from "node:fs";
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
const zeros = /^0{40}$/, oid = /^[a-f0-9]{40}$/;
// The complete submitted range: the CI event's own baseline (push `before` or
// pull-request base), otherwise the fetched origin/main. A missing, unfetched or
// non-ancestor baseline fails closed instead of shrinking to the last commit.
export function releaseBaseline(directory = root, environment = process.env) {
  let base = null;
  if (environment.GITHUB_EVENT_PATH) {
    let event; try { event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8")); } catch { event = null; }
    base = event?.pull_request?.base?.sha ?? event?.before ?? null;
  } else {
    const remote = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], {cwd: directory, encoding: "utf8"});
    base = remote.status === 0 ? remote.stdout.trim() : null;
  }
  if (typeof base !== "string" || !oid.test(base) || zeros.test(base)) return null;
  if (spawnSync("git", ["cat-file", "-e", `${base}^{commit}`], {cwd: directory}).status !== 0) return null;
  if (spawnSync("git", ["merge-base", "--is-ancestor", base, "HEAD"], {cwd: directory}).status !== 0) return null;
  return base;
}
function changedPaths(directory, environment) {
  const base = releaseBaseline(directory, environment);
  if (!base) throw new Error("Sealed Oracle spec is missing and the submitted change range cannot be established; run the native proposal");
  return execFileSync("git", ["diff", "--name-only", base, "HEAD"], {cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024}).split("\n").filter(Boolean);
}
// Fail before any test: a non-documentation change needs the contract's sealed
// oracle-spec/1, and publishedContract rejects a missing or mismatched seal.
export function assertSealedSpec(directory = root, {changed, environment = process.env} = {}) {
  const contract = publishedContract(directory);
  if (contract) return contract;
  const executable = (changed ?? changedPaths(directory, environment)).filter(name => !documentationPath(name));
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
      : await (await import("./validation-transport.mjs")).importNativeValidation({root, repository: process.env.GITHUB_REPOSITORY, sourceCommit, sourceTree});
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
