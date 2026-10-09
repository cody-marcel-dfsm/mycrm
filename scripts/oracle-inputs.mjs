import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, rm, writeFile, lstat} from "node:fs/promises";
import path from "node:path";

export const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` : JSON.stringify(value);
export const contentHash = (value) => createHash("sha256").update(value).digest("hex");
export const bindingHash = (value) => contentHash(canonicalJson(value));

export async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: "wx"});
    await rename(temporary, filename);
  } finally { await rm(temporary, {force: true}); }
}

export async function withOracleRun(directory, action) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const lock = path.join(directory, "run.lock");
  try { await mkdir(lock, {mode: 0o700}); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Oracle checkout is busy or has an interrupted lock; inspect run.lock before retrying"); throw error; }
  let run;
  const timings = {};
  const started = performance.now();
  const phase = async (name, operation) => {
    const begin = performance.now();
    try { return await operation(); } finally { timings[name] = performance.now() - begin; }
  };
  try {
    await atomicJson(path.join(lock, "owner.json"), {pid: process.pid, started_at: new Date().toISOString()});
    run = path.join(directory, "runs", randomUUID());
    await mkdir(run, {recursive: true, mode: 0o700});
    return await action({run, phase});
  } finally {
    timings.total_ms = performance.now() - started;
    try { if (run) await atomicJson(path.join(run, "timings.json"), timings); }
    finally { await rm(lock, {recursive: true, force: true}); }
  }
}

async function fileBinding(root, relative) {
  const absolute = path.resolve(root, relative);
  const stats = await lstat(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Oracle input must be a regular file: ${relative}`);
  return {path: relative, sha256: contentHash(await readFile(absolute))};
}

async function vaultSources(root, relative = "Vault") {
  const entries = await readdir(path.join(root, relative), {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (["index", "tmp"].includes(entry.name)) continue;
    const target = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Oracle canonical Vault contains a symbolic link: ${target}`);
    if (entry.isDirectory()) files.push(...await vaultSources(root, target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function evidenceBinding(root, value) {
  if (value === null) return null;
  let filename = value.startsWith("@") ? value.slice(1) : value;
  let stats;
  try { stats = await lstat(path.resolve(root, filename)); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENAMETOOLONG") throw error;
    if (value.startsWith("@")) throw new Error(`Oracle evidence file is missing: ${filename}`);
    return {value, sha256: contentHash(value), kind: "literal"};
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Oracle evidence must be a regular file: ${filename}`);
  return {value, kind: "file", sha256: contentHash(await readFile(path.resolve(root, filename)))};
}

export async function captureInputs({root, base, tree = null, validationEvidence = [], ownerApprovalEvidence = null, proposal = null, complete = false}) {
  // Hash the approver policy bytes without adopting or exposing its instructions.
  const policyFiles = ["AGENTS.md", "Vault/docs/CONSTITUTION.md", ".agents/skills/oracle/SKILL.md"];
  const files = complete ? [...new Set([...policyFiles, ...await vaultSources(root)])].sort() : policyFiles.sort();
  const [authorities, validation, owner] = await Promise.all([
    Promise.all(files.map((filename) => fileBinding(root, filename))),
    Promise.all(validationEvidence.map((value) => evidenceBinding(root, value))),
    evidenceBinding(root, ownerApprovalEvidence),
  ]);
  const tool_sha256 = bindingHash(await Promise.all(["oracle-inputs.mjs", "oracle-review.mjs"].map(async (name) => contentHash(await readFile(new URL(name, import.meta.url))))));
  return {schema: "my-crm.oracle-inputs/v2", tool_sha256, base_commit: base, reviewed_tree: tree, authorities, validation, owner, proposal_sha256: proposal ? bindingHash(proposal) : null};
}

export function assertInputsMatch(expected, actual) {
  if (bindingHash(expected) !== bindingHash(actual)) throw new Error("Oracle inputs drifted: base, tree, authority, evidence, proposal, or owner approval changed; fresh review is required");
}

export async function preparedEvidence(directory, inputs, prepare) {
  const key = bindingHash({version: 1, inputs});
  const cache = path.join(directory, "preparation", `${key}.json`);
  let previous;
  try { previous = JSON.parse(await readFile(cache, "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (previous?.key === key && typeof previous.sha256 === "string" && previous.payload !== undefined && previous.sha256 === bindingHash(previous.payload)) return {payload: previous.payload, reused: true};
  const payload = await prepare();
  await mkdir(path.dirname(cache), {recursive: true, mode: 0o700});
  await atomicJson(cache, {key, sha256: bindingHash(payload), payload});
  return {payload, reused: false};
}
