import {readdir, readFile, lstat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import {atomicJson, bindingHash, contentHash, metadataDirectory, readMetadataFile} from "./oracle-inputs.mjs";
import {readValidationProofs, validationDigest} from "./oracle-validation.mjs";

const execute = promisify(execFile);
const git = async (root, args) => (await execute("git", args, {cwd: root})).stdout.trim();
const digest = ({record_sha256: _ignored, ...value}) => bindingHash(value);

export async function commandArtifactBinding(root, command) {
  if (command[0] !== "npm" || command[1] !== "run" || !["build", "check:release"].includes(command[2]) || command.length !== 3) return null;
  const files = {};
  const walk = async relative => {
    for (const item of (await readdir(path.join(root, relative), {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${item.name}`, metadata = await lstat(path.join(root, name));
      if (metadata.isSymbolicLink() || !metadata.isDirectory() && !metadata.isFile()) throw new Error("Command artifact must contain regular files and directories");
      if (metadata.isDirectory()) await walk(name);
      else files[name] = {sha256: contentHash(await readFile(path.join(root, name))), mode: metadata.mode & 0o777};
    }
  };
  try { await walk("dist/my-crm"); } catch (error) { if (error.code === "ENOENT") return {files: null}; throw error; }
  return {files};
}

// Discover originals, never create a current witness from an earlier log. The
// complete original scope remains intact, including its environment/custody.
export async function findCommandValidation({root, directory, command, before, executable}) {
  const location = path.join(directory, "validations"), invalidated = [];
  let names;
  try { names = await readdir(location); } catch (error) { if (error.code === "ENOENT") return {proof: null, invalidated}; throw error; }
  const originals = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const filename = path.join(location, name);
    let bytes, record;
    try { bytes = await readMetadataFile(filename, {}, {root: path.dirname(directory)}); record = JSON.parse(bytes); }
    catch (error) { invalidated.push({evidence: `@${filename}`, reason: `Original native record unavailable: ${error.message}`}); continue; }
    if (bindingHash(record.command) === bindingHash(command)) originals.push({filename, bytes, record});
  }
  originals.sort((a, b) => String(b.record.finished_at).localeCompare(String(a.record.finished_at)));
  for (const original of originals) {
    const evidence = `@${original.filename}`;
    try {
      if (original.record.record_sha256 !== validationDigest(original.record) || path.basename(original.filename) !== `${original.record.record_sha256}.json`) throw new Error("Original native execution record changed");
      if (bindingHash(original.record.before) !== bindingHash(before)) {
        const previous = original.record.before;
        const changed = [...new Set([...Object.keys(previous.files), ...Object.keys(before.files)])].filter(name => previous.files[name] !== before.files[name]);
        throw new Error(changed.length ? `Consumed input changes: ${changed.join(", ")}` : previous.context.environment !== before.context.environment ? "Command execution environment changed" : "Original captured dependency scope, metadata, configuration or candidate binding changed");
      }
      const [proof] = await readValidationProofs({root, directory, validation: [{kind: "file", value: evidence, sha256: contentHash(original.bytes)}]});
      if (!proof?.eligible) throw new Error(proof?.reason ?? "Original native execution is unavailable");
      if (bindingHash(proof.record.executable) !== bindingHash(executable)) throw new Error("Command executable changed");
      const artifact = await commandArtifactBinding(root, command);
      if (artifact !== null && (!proof.record.produced_artifact || bindingHash(artifact) !== bindingHash(proof.record.produced_artifact))) throw new Error("Original generated artifact provenance is missing or current output changed");
      return {proof, invalidated};
    } catch (error) { invalidated.push({evidence, execution_record_sha256: original.record.record_sha256, reason: error.message}); }
  }
  return {proof: null, invalidated};
}

// Each immutable event names real Git changelists and the original execution.
// Declared-input executions retain their working input identities as supporting
// evidence: their live bytes need not exist in any index or committed tree.
export async function recordCommandCoverage({root, directory, record, evidence, disposition, invalidated = []}) {
  const source_commit = await git(root, ["rev-parse", "HEAD"]), source_tree = await git(root, ["rev-parse", `${source_commit}^{tree}`]);
  const candidate_tree = record.before.tree ?? null;
  const base = record.before.base_commit ?? source_commit;
  const history = await git(root, ["log", "--reverse", "--format=%H %T", `${base}..${source_commit}`]);
  const changelists = (history ? history.split("\n") : [`${source_commit} ${source_tree}`]).map(line => {
    const [commit_sha, tree_sha] = line.split(" ");
    return {commit_sha, tree_sha, validated_in_candidate: candidate_tree, coverage: record.outcome === "PASSED" ? candidate_tree ? "COVERED" : "SUPPORTING" : "PENDING"};
  });
  const value = {schema: "my-crm.command-coverage/v1", command: record.command, source_commit, source_tree, candidate_tree,
    execution_record_sha256: record.record_sha256, evidence, input_sha256: bindingHash(record.before), executable_sha256: bindingHash(record.executable),
    environment_sha256: record.before.context.environment, output_sha256: record.output_sha256, outcome: record.outcome, disposition, changelists, invalidated,
    ...(candidate_tree === null ? {scoped_inputs: record.before} : {})};
  value.record_sha256 = digest(value);
  const location = path.join(directory, "command-tracking"); await metadataDirectory(path.dirname(directory), location);
  const filename = path.join(location, `${value.record_sha256}.json`);
  try { await atomicJson(filename, value, {root: path.dirname(directory), exclusive: true}); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const bytes = await readMetadataFile(filename, "utf8", {root: path.dirname(directory)});
    if (bytes !== `${JSON.stringify(value, null, 2)}\n`) throw new Error("Immutable command coverage record conflicts with its original content");
  }
  return {record: value, filename};
}
