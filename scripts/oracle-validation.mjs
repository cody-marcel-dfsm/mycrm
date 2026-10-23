import {readFile, realpath, access, constants, lstat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import process from "node:process";
import {bindingHash, contentHash, pathCustody, lexicalPath, metadataDirectory, readMetadataFile, evidenceBinding, assertEvidenceIntegrity} from "./oracle-inputs.mjs";
import {verifySeries, retainedObservations} from "./oracle-series.mjs";

export const validationDigest = ({record_sha256: _ignored, ...record}) => bindingHash(record);
const execute = promisify(execFile);

const gitPath = name => `"${[...Buffer.from(name)].map(byte => byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`).join("")}"`;
function indexedPath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Git index path quoting is malformed");
  const bytes = [], controls = {a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92};
  for (let index = 1; index < value.length - 1; index++) {
    if (value[index] !== "\\") { const point = value.codePointAt(index), text = String.fromCodePoint(point); bytes.push(...Buffer.from(text)); index += text.length - 1; continue; }
    const escaped = value[++index];
    if (Object.hasOwn(controls, escaped)) bytes.push(controls[escaped]);
    else if (/[0-7]/.test(escaped ?? "")) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) octal += value[++index];
      bytes.push(Number.parseInt(octal, 8));
    } else throw new Error("Git index path escape is malformed");
  }
  return Buffer.from(bytes).toString("utf8");
}

export async function selectedGitInputs(root, names, {missing = []} = {}) {
  if (!names.length && !missing.length) return {files: {}, selected_index: {}};
  const [hashes, index] = await Promise.all([
    names.length ? new Promise((resolve, reject) => {
      const child = execFile("git", ["hash-object", "--stdin-paths"], {cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024}, (error, stdout) => error ? reject(error) : resolve(stdout));
      child.stdin.on("error", reject); child.stdin.end(`${names.map(gitPath).join("\n")}\n`);
    }) : Promise.resolve(""),
    execute("git", ["ls-files", "--stage"], {cwd: root, maxBuffer: 16 * 1024 * 1024}).then(result => result.stdout),
  ]);
  const values = names.length ? hashes.trim().split("\n") : [];
  if (values.length !== names.length || values.some(value => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value))) throw new Error("Selected Git input hash inventory is incomplete");
  const entries = new Map();
  for (const line of index.split("\n").filter(Boolean)) {
    const separator = line.indexOf("\t");
    if (separator < 0) throw new Error("Git index entry is malformed");
    const name = indexedPath(line.slice(separator + 1));
    entries.set(name, [...entries.get(name) ?? [], line]);
  }
  return {files: Object.fromEntries([...names.map((name, position) => [name, values[position]]), ...missing.map(name => [name, null])]),
    selected_index: Object.fromEntries([...names, ...missing].map(name => [name, (entries.get(name) ?? []).join("\n").trim()]))};
}

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
  return Object.fromEntries(Object.entries(environment).filter(([name]) => declared.includes(name) || name !== "_" && !name.startsWith("npm_lifecycle_") && !dispatchEnvironment.has(name)));
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
  // One operation owns these snapshots. Never retain mutable current input maps
  // between phases: each audit samples afresh, then checks every sampled identity
  // again before returning any current applicability decision.
  const environment = {...process.env};
  const inputs = new Map(), executables = new Map(), indexes = new Map(), originals = new Map(), metadataSets = new Map(), metadataHashes = new WeakMap();
  const inspectInput = async name => {
    const metadata = (await fileMetadata(root, [name]))[name];
    return {metadata, sha256: metadata.type === "regular" ? contentHash(await readFile(metadata.custody.resolved_path)) : null};
  };
  const memo = (cache, key, operation) => {
    if (!cache.has(key)) cache.set(key, operation());
    return cache.get(key);
  };
  const metadataFor = names => memo(metadataSets, JSON.stringify([...names].sort()), async () => Object.fromEntries(await Promise.all(names.map(async name => [name, (await memo(inputs, name, () => inspectInput(name))).metadata]))));
  const metadataHash = metadata => {
    if (!metadataHashes.has(metadata)) metadataHashes.set(metadata, bindingHash(metadata));
    return metadataHashes.get(metadata);
  };
  const executableFor = (program, cwd) => memo(executables, JSON.stringify([program, cwd]), () => executableBinding(program, environment, cwd));
  const inspectIndex = async name => (await execute("git", ["ls-files", "--stage", "--", name], {cwd: root})).stdout.trim();
  const indexFor = name => memo(indexes, name, () => inspectIndex(name));
  const membership = async () => (await execute("git", ["ls-files", "--cached", "--stage", "--others", "--exclude-standard", "-z"], {cwd: root, maxBuffer: 16 * 1024 * 1024})).stdout;
  const initialMembership = checkCurrentExecutable && validation.length ? await membership() : null;
  const canonicalDirectory = await metadataDirectory(path.dirname(directory), directory, {create: false});
  for (const evidence of validation) {
    if (evidence.kind !== "file") continue;
    const requested = lexicalPath(root, evidence.value.replace(/^@/, ""));
    const owned = requested === path.resolve(root) || requested.startsWith(`${path.resolve(root)}${path.sep}`);
    const recordCustody = await pathCustody(root, requested, {scopeRoot: owned ? root : null, allowFinalLink: false});
    const filename = recordCustody.resolved_path;
    if (path.dirname(filename) !== path.join(canonicalDirectory, "validations")) continue; // Legacy evidence remains readable.
    if (evidence.custody && bindingHash(evidence.custody) !== bindingHash(recordCustody)) throw new Error("Oracle native validation record custody changed during review");
    const original = await memo(originals, bindingHash({filename, sha256: evidence.sha256, custody: recordCustody}), async () => {
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
      const executionIntact = record.outcome === "PASSED" && record.exit_code === 0 && !record.signal &&
        bindingHash(record.before) === bindingHash(record.after) && bindingHash(record.executable) === bindingHash(record.after_executable);
      return {record, requested, recordCustody, evidenceHash: evidence.sha256, output, outputCustody, outputHash: record.output_sha256,
        executionIntact, metadataHash: record.before.file_metadata ? bindingHash(record.before.file_metadata) : null, executableHash: bindingHash(record.executable)};
    });
    const {record, outputCustody, executionIntact} = original;
    const executable = checkCurrentExecutable ? await executableFor(record.command[0], record.execution_cwd ?? root) : record.executable;
    const metadataReasons = [];
    let currentProvenance = null;
    if (checkCurrentExecutable) {
      const metadata = await metadataFor(Object.keys(record.before.files));
      const sourceFiles = Object.fromEntries(await Promise.all(Object.keys(metadata).map(async name => [name, (await inputs.get(name)).sha256])));
      currentProvenance = {executable, environment: environmentHash(environment, record.environment_inputs ?? []), file_metadata: metadata, source_files: sourceFiles, record_custody: recordCustody, output_custody: outputCustody};
      if (record.file_metadata_policy !== "live-mode-and-type-v1" || !record.before.file_metadata) metadataReasons.push("original witness lacks live file mode/type provenance");
      if (!record.output_custody || Object.values(record.before.file_metadata ?? {}).some((value) => !value?.custody)) metadataReasons.push("original witness lacks complete transitive path custody");
      else if (metadataHash(await metadataFor(Object.keys(record.before.file_metadata))) !== original.metadataHash) metadataReasons.push("selected source file mode/type changed");
      if (record.before.selected_index) for (const [name, previous] of Object.entries(record.before.selected_index)) {
        if (await indexFor(name) !== previous) { metadataReasons.push("selected index mode/type or source changed"); break; }
      }
      if (!record.execution_cwd || !Object.hasOwn(record.executable, "target_index")) metadataReasons.push("original witness lacks execution cwd or resolved executable index provenance");
    }
    const eligible = !metadataReasons.length && executionIntact && bindingHash(executable) === original.executableHash;
    const originalEligible = executionIntact
      && record.file_metadata_policy === "live-mode-and-type-v1" && Boolean(record.before.file_metadata && record.output_custody && record.execution_cwd && Object.hasOwn(record.executable, "target_index"))
      && Object.values(record.before.file_metadata).every(value => value?.custody);
    proofs.push({evidence: evidence.value, record, eligible, original_eligible: originalEligible, reason: eligible ? null : metadataReasons.join("; ") || "command failed, original inputs drifted, or executable changed", ...(currentProvenance ? {current_provenance: currentProvenance} : {})});
  }
  const changed = name => { throw Object.assign(new Error(`Oracle native validation inputs changed during audit: ${name}`), {code: "ORACLE_INPUT_DRIFT"}); };
  // All I/O remains fresh at the boundary, including private ignored inputs and
  // transitive aliases. Cached early bytes cannot conceal later source/output
  // movement. Original records and their historical outcomes stay untouched.
  if (checkCurrentExecutable) {
    await Promise.all([...inputs].map(async ([name, initial]) => { if (bindingHash(await initial) !== bindingHash(await inspectInput(name))) changed(name); }));
    for (const [key, initial] of executables) {
      const [program, cwd] = JSON.parse(key);
      if (bindingHash(await initial) !== bindingHash(await executableBinding(program, process.env, cwd))) changed(`executable ${program}`);
    }
    for (const [name, initial] of indexes) if (await initial !== await inspectIndex(name)) changed(`index ${name}`);
    for (const proof of proofs) if (proof.current_provenance.environment !== environmentHash(process.env, proof.record.environment_inputs ?? [])) changed("functional environment");
    if (initialMembership !== null && initialMembership !== await membership()) changed("Git source membership/index");
  }
  for (const pending of originals.values()) {
    const original = await pending;
    const owned = original.requested === path.resolve(root) || original.requested.startsWith(`${path.resolve(root)}${path.sep}`);
    const custody = await pathCustody(root, original.requested, {scopeRoot: owned ? root : null, allowFinalLink: false});
    if (bindingHash(custody) !== bindingHash(original.recordCustody) || contentHash(await readMetadataFile(custody.resolved_path, {}, {root: path.dirname(directory)})) !== original.evidenceHash) changed("original record custody/content");
    const outputCustody = await pathCustody(root, original.output, {scopeRoot: path.join(canonicalDirectory, "runs"), allowFinalLink: false});
    if (bindingHash(outputCustody) !== bindingHash(original.outputCustody) || contentHash(await readMetadataFile(outputCustody.resolved_path, {}, {root: path.dirname(directory)})) !== original.outputHash) changed("original output custody/content");
  }
  return proofs;
}

export function assertValidationProofsMatch(before, after) {
  if (bindingHash(before) === bindingHash(after)) return;
  const changed = [...new Set([...before, ...after].map((item) => item.evidence))].filter((name) => bindingHash(before.find((item) => item.evidence === name) ?? null) !== bindingHash(after.find((item) => item.evidence === name) ?? null));
  throw new Error(`Oracle native validation source, executable, environment or provenance changed during review: ${changed.join(", ")}`);
}

async function manifestExecutionContext({root, directory, requestedEvidence, originalHashes}) {
  const evidence = [], invalidated = [], manifests = [], bindings = [];
  const present = new Set(requestedEvidence.map(value => lexicalPath(root, value.replace(/^@/, ""))));
  const privateRoot = path.resolve(root, "Vault/tmp"), canonicalDirectory = await metadataDirectory(path.dirname(directory), directory, {create: false});
  for (const value of requestedEvidence) {
    const filename = lexicalPath(root, value.replace(/^@/, ""));
    if (!filename.startsWith(`${privateRoot}${path.sep}`) || !filename.endsWith(".json")) continue;
    const binding = await evidenceBinding(root, value);
    if (!binding.custody.resolved_path.startsWith(`${privateRoot}${path.sep}`)) throw new Error("Required-command recovery manifest escaped its canonical private directory");
    const bytes = await readMetadataFile(filename, {}, {root});
    if (contentHash(bytes) !== binding.sha256) throw new Error("Required-command recovery manifest changed during admission");
    let manifest; try { manifest = JSON.parse(bytes); } catch { continue; }
    if (manifest.schema === "my-crm.required-command-coverage/v1") { manifests.push({manifest, binding}); bindings.push(binding); }
  }
  if (!manifests.length) return {evidence, invalidated};
  const [commit, tree] = (await execute("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {cwd: root})).stdout.trim().split("\n");
  for (const {manifest, binding} of manifests) {
    if (manifest.source_commit !== commit || manifest.source_tree !== tree) continue;
    if (!Array.isArray(manifest.checks) || manifest.checks.some(check => !Array.isArray(check?.executions) || check.executions.some(id => !/^[a-f0-9]{64}$/.test(id)))) {
      invalidated.push({kind: "validation", id: "manifest-execution-context", evidence: binding.value, reason: "Required-command manifest has malformed original execution identities"}); continue;
    }
    for (const id of new Set(manifest.checks.flatMap(check => check.executions))) {
      const value = `@${path.join(canonicalDirectory, "validations", `${id}.json`)}`;
      if (present.has(value.slice(1))) continue;
      present.add(value.slice(1));
      try {
        const original = await evidenceBinding(root, value);
        if (originalHashes.has(id) && original.sha256 !== originalHashes.get(id)) throw new Error("Stored native original record content hash changed");
        // Restore authentic context, including failed/ineligible historical
        // records. This integrity-only read grants no current applicability,
        // command coverage or approval. The normal audit and reviewer retain
        // every original outcome, unknown provenance and eligibility decision.
        const [proof] = await readValidationProofs({root, directory, validation: [original], checkCurrentExecutable: false});
        if (!proof || proof.record.record_sha256 !== id) throw new Error("Manifest original execution identity differs");
        evidence.push(value);
      } catch (error) {
        invalidated.push({kind: "validation", id: `manifest-native-${id}`, evidence: value,
          reason: error.code === "ENOENT" ? "Required-command original record or output is missing" : `Required-command original context invalidated: ${error.message}`});
      }
    }
  }
  await assertEvidenceIntegrity(root, bindings);
  return {evidence, invalidated};
}

export async function inheritNativeEvidence({root, directory, base, requestedEvidence}) {
  let series;
  try { series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${base}.json`), "utf8", {root: path.dirname(directory)})), base); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const originalHashes = new Map((series ? retainedObservations(series, "validations") : []).filter(({item}) => item.execution_record_sha256).map(({item}) => [item.execution_record_sha256, item.evidence_sha256]));
  const context = await manifestExecutionContext({root, directory, requestedEvidence, originalHashes});
  if (!series) return context;
  const canonicalDirectory = await metadataDirectory(path.dirname(directory), directory, {create: false});
  const present = new Set(await Promise.all(requestedEvidence.map(async (value) => {
    const filename = lexicalPath(root, value.replace(/^@/, ""));
    try { return (await pathCustody(root, filename, {scopeRoot: null})).resolved_path; } catch { return filename; }
  })));
  const evidence = context.evidence.filter(value => !present.has(value.slice(1))), invalidated = [...context.invalidated];
  for (const value of evidence) present.add(value.slice(1));
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
