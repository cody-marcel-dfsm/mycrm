import {readFile, realpath, access, constants, lstat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import process from "node:process";
import {bindingHash, contentHash, pathCustody, lexicalPath, metadataDirectory, readMetadataFile} from "./oracle-inputs.mjs";
import {verifySeries, retainedObservations} from "./oracle-series.mjs";

export const validationDigest = ({record_sha256: _ignored, ...record}) => bindingHash(record);
const execute = promisify(execFile);

export async function fileMetadata(root, names) {
  return Object.fromEntries(await Promise.all(names.map(async (name) => {
    const custody = await pathCustody(root, name, {scopeRoot: path.isAbsolute(name) ? path.dirname(path.resolve(root)) : root, allowMissing: true, excluded: [path.join(root, ".git")]});
    return [name, {...custody.metadata ?? {type: "missing", mode: null}, custody}];
  })));
}

// Dispatch identity is removed from the actual child environment as well as its
// applicability hash. A command that consumes one of these values declares it
// explicitly; canonical cwd, executable, runtime and all other config stay bound.
const dispatchEnvironment = new Set(["CODEX_THREAD_ID", "CODEX_PARENT_THREAD_ID", "CODEX_SESSION_ID", "PWD", "OLDPWD", "SHLVL"]);
export function executionEnvironment(environment = process.env, declared = []) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name !== "_" && !name.startsWith("npm_lifecycle_") && (!dispatchEnvironment.has(name) || declared.includes(name))));
}

export function fullEnvironmentHash(environment = process.env) {
  return bindingHash({env: environment, node: process.version, versions: process.versions, platform: process.platform, architecture: process.arch});
}
export function environmentHash(environment = process.env, declared = []) {
  return fullEnvironmentHash(executionEnvironment(environment, declared));
}

export async function executableBinding(program, environment = process.env, cwd = process.cwd()) {
  // execFile uses the Unix default search path when PATH is absent. An
  // explicitly empty PATH instead searches cwd; keep those facts distinct.
  const searchPath = environment.PATH ?? (process.platform === "win32" ? process.env.PATH ?? "" : "/usr/bin:/bin");
  const candidates = program.includes(path.sep) ? [lexicalPath(cwd, program)] : searchPath.split(path.delimiter).map((entry) => lexicalPath(cwd, `${entry ? `${entry}${path.sep}` : ""}${program}`));
  for (const filename of candidates) {
    try {
      const custody = await pathCustody(cwd, filename, {scopeRoot: null});
      if (custody.metadata === null) continue;
      await access(filename, constants.X_OK);
      // Alias index entries alone do not bind the executable target's staged
      // mode or identity. Keep external executables supported without Git reads.
      const root = await realpath(cwd), relative = path.relative(root, custody.resolved_path);
      let targetIndex = null;
      if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        try { const {stdout} = await execute("git", ["ls-files", "--stage", "--", relative], {cwd: root}); targetIndex = {path: relative, entry: stdout.trim()}; }
        catch (error) { if (error.code !== 128) throw error; }
      }
      return {path: custody.resolved_path, sha256: contentHash(await readFile(custody.resolved_path)), metadata: custody.metadata, custody, target_index: targetIndex};
    } catch (error) { if (!["ENOENT", "EACCES", "EISDIR", "ENOTDIR"].includes(error.code)) throw error; }
  }
  throw new Error(`Validation executable is unavailable: ${program}`);
}

export async function readValidationProofs({root, directory, validation, checkCurrentExecutable = true}) {
  const proofs = [];
  const canonicalDirectory = await metadataDirectory(path.dirname(directory), directory, {create: false});
  for (const evidence of validation) {
    if (evidence.kind !== "file") continue;
    const requested = lexicalPath(root, evidence.value.replace(/^@/, ""));
    const owned = requested === path.resolve(root) || requested.startsWith(`${path.resolve(root)}${path.sep}`);
    const recordCustody = await pathCustody(root, requested, {scopeRoot: owned ? root : null, allowFinalLink: false});
    const filename = recordCustody.resolved_path;
    if (path.dirname(filename) !== path.join(canonicalDirectory, "validations")) continue; // Legacy evidence remains readable.
    if (evidence.custody && bindingHash(evidence.custody) !== bindingHash(recordCustody)) throw new Error("Oracle native validation record custody changed during review");
    const bytes = await readMetadataFile(filename, {}, {root: path.dirname(directory)});
    const record = JSON.parse(bytes);
    if (contentHash(bytes) !== evidence.sha256 || record.schema !== "my-crm.oracle-validation/v1" ||
        record.record_sha256 !== validationDigest(record) || path.basename(filename) !== `${record.record_sha256}.json` ||
        record.provenance !== "launcher-owned-command-execution" || !Array.isArray(record.command) || !record.command.length ||
        !record.before?.files || (record.after !== null && !record.after?.files) || !["PASSED", "FAILED", "INPUT_DRIFT"].includes(record.outcome) || typeof record.output_sha256 !== "string") throw new Error("Oracle native validation record is malformed or changed");
    const output = lexicalPath(root, record.output_file);
    if (!output.startsWith(`${path.join(canonicalDirectory, "runs")}${path.sep}`)) throw new Error(`Oracle native validation output is missing or changed: ${output}`);
    const outputCustody = await pathCustody(root, output, {scopeRoot: path.join(canonicalDirectory, "runs"), allowFinalLink: false});
    if (record.output_custody && bindingHash(record.output_custody) !== bindingHash(outputCustody) || contentHash(await readMetadataFile(outputCustody.resolved_path, {}, {root: path.dirname(directory)})) !== record.output_sha256) throw new Error(`Oracle native validation output is missing or changed, including transitive custody: ${output}`);
    const executable = checkCurrentExecutable ? await executableBinding(record.command[0], process.env, record.execution_cwd ?? root) : record.executable;
    const metadataReasons = [];
    let currentProvenance = null;
    if (checkCurrentExecutable) {
      const metadata = await fileMetadata(root, Object.keys(record.before.files));
      const sourceFiles = Object.fromEntries(await Promise.all(Object.entries(metadata).map(async ([name, value]) => [name, value?.type === "regular" ? contentHash(await readFile(value.custody.resolved_path)) : null])));
      currentProvenance = {executable, environment: environmentHash(process.env, record.environment_inputs ?? []), file_metadata: metadata, source_files: sourceFiles, record_custody: recordCustody, output_custody: outputCustody};
      if (record.file_metadata_policy !== "live-mode-and-type-v1" || !record.before.file_metadata) metadataReasons.push("original witness lacks live file mode/type provenance");
      if (!record.output_custody || Object.values(record.before.file_metadata ?? {}).some((value) => !value?.custody)) metadataReasons.push("original witness lacks complete transitive path custody");
      else if (bindingHash(await fileMetadata(root, Object.keys(record.before.file_metadata))) !== bindingHash(record.before.file_metadata)) metadataReasons.push("selected source file mode/type changed");
      if (record.before.selected_index) for (const [name, previous] of Object.entries(record.before.selected_index)) {
        const {stdout} = await execute("git", ["ls-files", "--stage", "--", name], {cwd: root});
        if (stdout.trim() !== previous) { metadataReasons.push("selected index mode/type or source changed"); break; }
      }
      if (!record.execution_cwd || !Object.hasOwn(record.executable, "target_index")) metadataReasons.push("original witness lacks execution cwd or resolved executable index provenance");
    }
    const eligible = !metadataReasons.length && record.outcome === "PASSED" && record.exit_code === 0 && !record.signal &&
      bindingHash(record.before) === bindingHash(record.after) && bindingHash(record.executable) === bindingHash(record.after_executable) && bindingHash(executable) === bindingHash(record.executable);
    const originalEligible = record.outcome === "PASSED" && record.exit_code === 0 && !record.signal && bindingHash(record.before) === bindingHash(record.after) && bindingHash(record.executable) === bindingHash(record.after_executable)
      && record.file_metadata_policy === "live-mode-and-type-v1" && Boolean(record.before.file_metadata && record.output_custody && record.execution_cwd && Object.hasOwn(record.executable, "target_index"))
      && Object.values(record.before.file_metadata).every(value => value?.custody);
    proofs.push({evidence: evidence.value, record, eligible, original_eligible: originalEligible, reason: eligible ? null : metadataReasons.join("; ") || "command failed, original inputs drifted, or executable changed", ...(currentProvenance ? {current_provenance: currentProvenance} : {})});
  }
  return proofs;
}

export function assertValidationProofsMatch(before, after) {
  if (bindingHash(before) === bindingHash(after)) return;
  const changed = [...new Set([...before, ...after].map((item) => item.evidence))].filter((name) => bindingHash(before.find((item) => item.evidence === name) ?? null) !== bindingHash(after.find((item) => item.evidence === name) ?? null));
  throw new Error(`Oracle native validation source, executable, environment or provenance changed during review: ${changed.join(", ")}`);
}

export async function inheritNativeEvidence({root, directory, base, requestedEvidence}) {
  let series;
  try { series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${base}.json`), "utf8", {root: path.dirname(directory)})), base); }
  catch (error) { if (error.code === "ENOENT") return {evidence: [], invalidated: []}; throw error; }
  const canonicalDirectory = await metadataDirectory(path.dirname(directory), directory, {create: false});
  const present = new Set(await Promise.all(requestedEvidence.map(async (value) => {
    const filename = lexicalPath(root, value.replace(/^@/, ""));
    try { return (await pathCustody(root, filename, {scopeRoot: null})).resolved_path; } catch { return filename; }
  })));
  const evidence = [], invalidated = [];
  for (const {item} of retainedObservations(series, "validations")) {
    if (!item.execution_record_sha256) continue; // Native observations only; no legacy/owner/API evidence inference.
    const filename = lexicalPath(root, item.evidence.replace(/^@/, ""));
    if (present.has(filename)) continue;
    try {
      const custody = await pathCustody(root, filename, {scopeRoot: path.join(canonicalDirectory, "validations"), allowFinalLink: false});
      const canonical = custody.resolved_path;
      if (present.has(canonical)) continue;
      if (path.dirname(canonical) !== path.join(canonicalDirectory, "validations") || path.basename(canonical) !== `${item.execution_record_sha256}.json`) throw new Error("Stored native record is outside its original canonical location");
      if (contentHash(await readMetadataFile(canonical, {}, {root: path.dirname(directory)})) !== item.evidence_sha256) throw new Error("Stored native record content hash changed");
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
