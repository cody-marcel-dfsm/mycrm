import {readFile, realpath, access, constants, lstat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import process from "node:process";
import {bindingHash, contentHash} from "./oracle-inputs.mjs";
import {verifySeries, retainedObservations} from "./oracle-series.mjs";

export const validationDigest = ({record_sha256: _ignored, ...record}) => bindingHash(record);
const execute = promisify(execFile);

export async function fileMetadata(root, names) {
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    try {
      const value = await lstat(path.resolve(root, name));
      return [name, {type: value.isSymbolicLink() ? "symlink" : value.isFile() ? "regular" : value.isDirectory() ? "directory" : "other", mode: value.mode & 0o777}];
    } catch (error) { if (error.code !== "ENOENT") throw error; return [name, null]; }
  })));
}

// npm dispatch metadata identifies the wrapper invocation, not the environment
// in which a captured check executes. Remove it from both the command's actual
// environment and the comparable reviewer environment. Keep all other values
// in the fingerprint without persisting their contents.
export function executionEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== "_" && !name.startsWith("npm_lifecycle_")));
}

export function environmentHash(environment = process.env) {
  return bindingHash({env: executionEnvironment(environment), node: process.version, versions: process.versions, platform: process.platform, architecture: process.arch});
}

export async function executableBinding(program, environment = process.env) {
  const candidates = program.includes(path.sep) ? [path.resolve(program)] : (environment.PATH ?? "").split(path.delimiter).map((entry) => path.resolve(entry, program));
  for (const filename of candidates) {
    try {
      await access(filename, constants.X_OK);
      const resolved = await realpath(filename);
      return {path: resolved, sha256: contentHash(await readFile(resolved)), metadata: (await fileMetadata(path.dirname(resolved), [path.basename(resolved)]))[path.basename(resolved)]};
    } catch (error) { if (!["ENOENT", "EACCES", "EISDIR"].includes(error.code)) throw error; }
  }
  throw new Error(`Validation executable is unavailable: ${program}`);
}

export async function readValidationProofs({root, directory, validation, checkCurrentExecutable = true}) {
  const proofs = [];
  const canonicalDirectory = await realpath(directory);
  for (const evidence of validation) {
    if (evidence.kind !== "file") continue;
    const filename = await realpath(path.resolve(root, evidence.value.replace(/^@/, "")));
    if (path.dirname(filename) !== path.join(canonicalDirectory, "validations")) continue; // Legacy evidence remains readable.
    const bytes = await readFile(filename);
    const record = JSON.parse(bytes);
    if (contentHash(bytes) !== evidence.sha256 || record.schema !== "my-crm.oracle-validation/v1" ||
        record.record_sha256 !== validationDigest(record) || path.basename(filename) !== `${record.record_sha256}.json` ||
        record.provenance !== "launcher-owned-command-execution" || !Array.isArray(record.command) || !record.command.length ||
        !record.before?.files || (record.after !== null && !record.after?.files) || !["PASSED", "FAILED", "INPUT_DRIFT"].includes(record.outcome) || typeof record.output_sha256 !== "string") throw new Error("Oracle native validation record is malformed or changed");
    const output = path.resolve(record.output_file);
    if (!output.startsWith(`${path.join(canonicalDirectory, "runs")}${path.sep}`) || contentHash(await readFile(output)) !== record.output_sha256) throw new Error("Oracle native validation output is missing or changed");
    const executable = checkCurrentExecutable ? await executableBinding(record.command[0]) : record.executable;
    const metadataReasons = [];
    if (checkCurrentExecutable) {
      if (record.file_metadata_policy !== "live-mode-and-type-v1" || !record.before.file_metadata) metadataReasons.push("original witness lacks live file mode/type provenance");
      else if (bindingHash(await fileMetadata(root, Object.keys(record.before.file_metadata))) !== bindingHash(record.before.file_metadata)) metadataReasons.push("selected source file mode/type changed");
      if (record.before.selected_index) for (const [name, previous] of Object.entries(record.before.selected_index)) {
        const {stdout} = await execute("git", ["ls-files", "--stage", "--", name], {cwd: root});
        if (stdout.trim() !== previous) { metadataReasons.push("selected index mode/type or source changed"); break; }
      }
    }
    const eligible = !metadataReasons.length && record.outcome === "PASSED" && record.exit_code === 0 && !record.signal &&
      bindingHash(record.before) === bindingHash(record.after) && bindingHash(record.executable) === bindingHash(record.after_executable) && bindingHash(executable) === bindingHash(record.executable);
    proofs.push({evidence: evidence.value, record, eligible, reason: eligible ? null : metadataReasons.join("; ") || "command failed, original inputs drifted, or executable changed"});
  }
  return proofs;
}

export async function inheritNativeEvidence({root, directory, base, requestedEvidence}) {
  let series;
  try { series = verifySeries(JSON.parse(await readFile(path.join(directory, "series", `${base}.json`), "utf8")), base); }
  catch (error) { if (error.code === "ENOENT") return {evidence: [], invalidated: []}; throw error; }
  const canonicalDirectory = await realpath(directory);
  const present = new Set(await Promise.all(requestedEvidence.map(async (value) => {
    const filename = path.resolve(root, value.replace(/^@/, ""));
    try { return await realpath(filename); } catch { return filename; }
  })));
  const evidence = [], invalidated = [];
  for (const {item} of retainedObservations(series, "validations")) {
    if (!item.execution_record_sha256) continue; // Native observations only; no legacy/owner/API evidence inference.
    const filename = path.resolve(root, item.evidence.replace(/^@/, ""));
    if (present.has(filename)) continue;
    try {
      const canonical = await realpath(filename);
      if (present.has(canonical)) continue;
      if (path.dirname(canonical) !== path.join(canonicalDirectory, "validations") || path.basename(canonical) !== `${item.execution_record_sha256}.json`) throw new Error("Stored native record is outside its original canonical location");
      if (contentHash(await readFile(canonical)) !== item.evidence_sha256) throw new Error("Stored native record content hash changed");
      const [proof] = await readValidationProofs({root, directory, validation: [{kind: "file", value: item.evidence, sha256: item.evidence_sha256}]});
      if (!proof?.eligible || proof.record.record_sha256 !== item.execution_record_sha256) throw new Error(proof?.reason ?? "Stored native record lacks original passing execution provenance");
      evidence.push(item.evidence); present.add(canonical);
    } catch (error) {
      invalidated.push({kind: "validation", id: item.id, evidence: item.evidence, command: item.command, dependencies: item.dependencies,
        reason: error.code === "ENOENT" ? "Stored native record or retained output is missing" : `Stored native execution proof invalidated: ${error.message}`});
    }
  }
  return {evidence, invalidated};
}
