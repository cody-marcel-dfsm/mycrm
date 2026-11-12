import {publishedContract, requiredFor, bootstrapEpoch} from "./validation-contract.mjs";
import {createHash} from "node:crypto";
import {execFile, spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const execute = promisify(execFile), oid = /^[a-f0-9]{40}$/, digestPattern = /^[a-f0-9]{64}$/;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const hash = value => createHash("sha256").update(value).digest("hex");
export const gitBlobHash = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const selectedValidation = publishedContract();
export const requiredCommands = Object.freeze(requiredFor(selectedValidation));
export const requiredCIWorkflow = ".github/workflows/ci.yml";
export const requiredCIJob = "test";
const contract = {...(selectedValidation ? {selection_sha256: selectedValidation.contract_sha256} : {bootstrap_epoch:bootstrapEpoch,preselected:false}), required_commands: requiredCommands, execution_contract: "accept-original-supported-native-execution", additional_platform_executions: []};
export const validationContractHash = hash(canonical(contract));
const commandKey = command => hash(canonical(command));
const git = async (root, args) => (await execute("git", args, {cwd: root, maxBuffer: 16 * 1024 * 1024})).stdout.trim();
const issuerHash = (repository, owner) => hash(canonical({repository: repository.toLowerCase(), repository_owner_id: owner.id}));

// This owner-local audit runs only while qualifying original validation facts.
// Public Git inputs stay bound to the captured tree. Ignored historical inputs
// require actual canonical bytes; omission from a public projection is no proof
// of absence. Private paths and these comparisons never enter the envelope.
export async function historicalInputComparisons({root, record, current}) {
  const {pathCustody, readMetadataFile} = await import("./oracle-inputs.mjs");
  const names = [...new Set([...Object.keys(record.before.files), ...Object.keys(current)])].sort();
  const omitted = names.filter(name => !Object.hasOwn(current, name) && !path.isAbsolute(name) && !name.split("/").some(part => ["..", ".git"].includes(part))), ignored = new Set();
  if (omitted.length) {
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile("git", ["check-ignore", "--no-index", "-z", "--stdin"], {cwd: root, maxBuffer: 16 * 1024 * 1024}, (error, output) => error && error.code !== 1 ? reject(error) : resolve(output));
      child.stdin.on("error", reject); child.stdin.end(`${omitted.join("\0")}\0`);
    });
    for (const name of stdout.split("\0").filter(Boolean)) ignored.add(name);
  }
  return Promise.all(names.map(async name => {
    const original = record.before.files[name] ?? null;
    let value = current[name] ?? null, state = Object.hasOwn(current, name) ? "BOUND_INPUT" : "SOURCE_TREE_ABSENT";
    if (!Object.hasOwn(current, name)) {
      if (path.isAbsolute(name) || name.split("/").some(part => ["..", ".git"].includes(part))) state = "UNAVAILABLE";
      else {
        if (ignored.has(name)) {
          try {
            const custody = await pathCustody(root, name, {allowMissing: true, allowFinalLink: false, excluded: [path.join(root, ".git")]});
            if (custody.metadata === null) state = "PRIVATE_INPUT_ABSENT";
            else {
              const bytes = await readMetadataFile(custody.resolved_path, {}, {root});
              value = oid.test(original ?? "") ? gitBlobHash(bytes) : hash(bytes);
              state = "PRIVATE_INPUT_BYTES";
            }
          } catch (error) {
            // Missing components are handled above. Ownership, regular-file and
            // custody failures remain unknown, never converted into absence.
            state = "UNAVAILABLE"; value = null;
          }
        }
      }
    }
    return {path: name, original_hash: original, current_hash: value, current_state: state,
      changed: state === "UNAVAILABLE" || original !== value};
  }));
}

export async function nativeCoverageIntake({root, sourceCommit, sourceTree, validation, proofs}) {
  const {readMetadataFile} = await import("./oracle-inputs.mjs");
  const manifests = [];
  for (const evidence of validation) {
    if (evidence.kind !== "file") continue;
    const filename = path.resolve(root, evidence.value.replace(/^@/, ""));
    if (!filename.startsWith(`${path.resolve(root, "Vault/tmp")}${path.sep}`) || !filename.endsWith(".json")) continue;
    const bytes = await readMetadataFile(filename, {}, {root});
    if (hash(bytes) !== evidence.sha256) throw new Error("Required-command intake evidence changed");
    let manifest; try {manifest = JSON.parse(bytes);} catch {continue;}
    if (manifest.schema === "my-crm.required-command-coverage/v1") manifests.push({evidence, manifest});
  }
  if (!manifests.length) return {status: "NOT_REQUESTED"};
  const exact = manifests.filter(item => item.manifest.source_commit === sourceCommit && item.manifest.source_tree === sourceTree), gaps = [];
  let selected = null;
  for (const item of exact) {
    const missing = [];
    for (const command of requiredCommands) {
      const checks = Array.isArray(item.manifest.checks) ? item.manifest.checks.filter(check => canonical(check.command) === canonical(command)) : [];
      const records = checks.length === 1 && Array.isArray(checks[0].executions) ? checks[0].executions.map(id => proofs.find(proof => proof.record.record_sha256 === id)?.record) : [];
      if (!records.length || records.some(record => !record || record.outcome !== "PASSED" || record.exit_code !== 0 || record.signal || record.error || canonical(record.before) !== canonical(record.after))
          || !records.some(record => canonical(record.command) === canonical(command))) missing.push(command.join(" "));
    }
    if (!missing.length) {selected = item; break;}
    gaps.push({manifest: item.evidence.value, missing_original_passing_commands: missing});
  }
  if (!exact.length) gaps.push({reason: "No supplied required-command manifest binds the captured commit and tree"});
  const result = {status: selected ? "READY_FOR_INDEPENDENT_ASSESSMENT" : "INCOMPLETE", source_commit: sourceCommit, source_tree: sourceTree,
    manifests: manifests.map(item => ({value: item.evidence.value, sha256: item.evidence.sha256, source_commit: item.manifest.source_commit, source_tree: item.manifest.source_tree})),
    original_records: proofs.map(proof => proof.record.record_sha256).sort(), selected_manifest: selected?.evidence ?? null, gaps: selected ? [] : gaps,
    grants_command_coverage: false, grants_approval: false};
  return {...result, identity_sha256: hash(canonical(result))};
}

// Publication runs without an authenticated GitHub CLI (owner direction,
// 2026-11-11: "Use ssh"). Refs move only through Git over the configured push
// URL; GitHub metadata and Actions state come from unauthenticated public reads.
export const publicApiOrigin = "https://api.github.com";
const publicReadLimit = 4 * 1024 * 1024;
export async function publicGithubRequest(method, endpoint, body, {fetch: request = globalThis.fetch, timeoutMs = 15000} = {}) {
  if (method !== "GET" || body !== undefined) throw Object.assign(new Error(`Public GitHub transport is read-only; ${method} ${endpoint} needs an authenticated write that this host does not use`), {code: "MYCRM_PUBLIC_READ_ONLY", status: null});
  const url = new URL(String(endpoint), `${publicApiOrigin}/`);
  if (url.origin !== publicApiOrigin || /^[a-z]+:/i.test(String(endpoint)) || String(endpoint).startsWith("/")) throw new Error(`Public GitHub reads are limited to ${publicApiOrigin} relative endpoints`);
  const response = await request(url, {method: "GET", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
    headers: {Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "my-crm-publication"}});
  if (!response.ok) throw Object.assign(new Error(`Public GitHub read failed (${response.status})`), {status: response.status});
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > publicReadLimit) throw new Error("Public GitHub read exceeded its bounded response size");
    chunks.push(Buffer.from(chunk));
  }
  try {const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object") throw new Error(); return value;}
  catch {throw new Error("Public GitHub read returned a malformed response");}
}

// Exact remote ref discovery by name; ls-remote patterns also match suffixes.
export async function remoteRef(root, remote, ref) {
  const lines = (await git(root, ["ls-remote", "--refs", remote, ref])).split("\n").filter(Boolean).map(line => line.split("\t"));
  const matches = lines.filter(([, name]) => name === ref);
  if (matches.length > 1 || matches.some(([value]) => !oid.test(value))) throw new Error(`Remote ref discovery for ${ref} is ambiguous or malformed`);
  return matches[0]?.[0] ?? null;
}
// Every ref write carries an explicit expected old value; empty means absent.
const leasedPush = (remote, object, ref, expected) => ["push", "--porcelain", `--force-with-lease=${ref}:${expected ?? ""}`, remote, `${object}:${ref}`];

async function gitBytes(root, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {cwd: root, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"]}), output = [], errors = [];
    child.stdout.on("data", value => output.push(value)); child.stderr.on("data", value => errors.push(value));
    child.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(`git ${args[0]} failed: ${Buffer.concat(errors).toString().trim().split("\n").pop()}`)));
    child.stdin.end(input);
  });
}

// The evidence commit is fully determined by source commit and envelope bytes:
// fixed synthetic identity, epoch time, one parent, one validation.json blob.
export const validationRefPrefix = "refs/my-crm/native-validation/";
export const validationRef = sourceCommit => `${validationRefPrefix}${sourceCommit}`;
export const validationEnvelopeLimit = 1024 * 1024;
export const evidenceEnvironment = Object.freeze({GIT_AUTHOR_NAME: "My CRM native validation", GIT_AUTHOR_EMAIL: "native-validation@example.invalid", GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "My CRM native validation", GIT_COMMITTER_EMAIL: "native-validation@example.invalid", GIT_COMMITTER_DATE: "@0 +0000"});
const evidenceMessage = (sourceCommit, bytes) => `Native command coverage for ${sourceCommit}\n\nsha256:${hash(bytes)}`;
export async function evidenceCommit(root, sourceCommit, bytes) {
  const blob = (await gitBytes(root, ["hash-object", "-w", "--stdin"], bytes)).toString().trim();
  const tree = (await gitBytes(root, ["mktree"], `100644 blob ${blob}\tvalidation.json\n`)).toString().trim();
  const commit = (await gitBytes(root, ["-c", "commit.gpgSign=false", "-c", "i18n.commitEncoding=UTF-8", "commit-tree", tree, "-p", sourceCommit, "-F", "-"],
    evidenceMessage(sourceCommit, bytes), {...process.env, ...evidenceEnvironment})).toString().trim();
  if (![blob, tree, commit].every(value => oid.test(value))) throw new Error("Local Git produced malformed evidence object identities");
  return {blob, tree, commit};
}

async function repositoryOwner({repository, ownerId, api}) {
  if (ownerId !== undefined && ownerId !== null && ownerId !== "") {
    if (!/^[1-9][0-9]{0,15}$/.test(String(ownerId)) || !Number.isSafeInteger(Number(ownerId))) throw new Error("Repository owner identifier is malformed");
    return {id: Number(ownerId)};
  }
  const metadata = await api("GET", `repos/${repository}`);
  if (!Number.isSafeInteger(metadata?.owner?.id) || metadata.owner.id < 1) throw new Error("Public repository metadata lacks its owner identity");
  return {id: metadata.owner.id};
}

async function sourceIdentity(root, sourceCommit, sourceTree) {
  let tree; try {tree = await git(root, ["rev-parse", "--verify", "--end-of-options", `${sourceCommit}^{tree}`]);} catch {throw new Error("Exact source commit is unavailable locally");}
  if (tree !== sourceTree) throw new Error("Local source commit tree differs from the exact candidate tree");
}

function verifyEnvelope(envelope, {repository, owner, sourceCommit, sourceTree}) {
  const keys = ["schema", "repository", "source_commit", "source_tree", "contract_sha256", "issuer_sha256", "checks"];
  if (!envelope || Object.keys(envelope).sort().join() !== keys.sort().join() || envelope.schema !== "my-crm.public-command-validation/v1"
      || envelope.repository.toLowerCase() !== repository.toLowerCase() || envelope.source_commit !== sourceCommit || envelope.source_tree !== sourceTree
      || envelope.contract_sha256 !== validationContractHash || envelope.issuer_sha256 !== issuerHash(repository, owner) || !Array.isArray(envelope.checks)) throw new Error("Native validation envelope source, repository, issuer or command contract changed");
  const seen = new Set();
  for (const check of envelope.checks) {
    if (Object.keys(check).sort().join() !== ["command", "coverage", "executions"].sort().join() || !requiredCommands.some(command => canonical(command) === canonical(check.command))
        || seen.has(commandKey(check.command)) || !["EXACT_INPUT_EXECUTION", "BASELINE_PLUS_FOCUSED_REPAIR"].includes(check.coverage) || !Array.isArray(check.executions) || !check.executions.length) throw new Error("Native validation check identity/coverage is invalid or duplicated");
    seen.add(commandKey(check.command));
    for (const record of check.executions) {
      const allowed = ["record_sha256", "command_sha256", "input_sha256", "executable_sha256", "environment_sha256", "output_sha256", "original_environment", ...(Object.hasOwn(record, "qualification") ? ["qualification"] : [])];
      if (Object.keys(record).sort().join() !== [...allowed].sort().join() || allowed.slice(0, 6).some(key => !digestPattern.test(record[key] ?? ""))) throw new Error("Native validation original execution hashes are invalid");
      if (Object.hasOwn(record, "qualification") && (record.qualification !== "INDEPENDENTLY_QUALIFIED_HISTORICAL_PASS" || check.coverage !== "BASELINE_PLUS_FOCUSED_REPAIR")) throw new Error("Historical execution qualification requires composed independent coverage");
      const environment = record.original_environment;
      if (environment !== null && (Object.keys(environment).sort().join() !== ["node", "platform", "architecture"].sort().join() || !/^v\d+\.\d+\.\d+$/.test(environment.node)
          || !["darwin", "linux", "win32"].includes(environment.platform) || !["arm64", "x64", "ia32", "arm", "ppc64", "s390x", "riscv64"].includes(environment.architecture))) throw new Error("Native validation environment metadata is not safe and truthful");
    }
    if (check.coverage === "EXACT_INPUT_EXECUTION" && (check.executions.length !== 1 || check.executions[0].command_sha256 !== commandKey(check.command))) throw new Error("Native validation execution does not establish its required command");
  }
  // This schema has no path/value/log/review fields. Content below is only
  // canonical command identity, opaque hashes and enumerated platform metadata.
  return envelope;
}

const publicExecution = record => ({record_sha256: record.record_sha256, command_sha256: commandKey(record.command), input_sha256: hash(canonical(record.before)),
  executable_sha256: hash(canonical(record.executable)), environment_sha256: record.before.context.environment, output_sha256: record.output_sha256,
  original_environment: record.recorder_environment ?? null});

export async function collectNativeChecks({root, sourceCommit, sourceTree, admission}) {
  const {readMetadataFile} = await import("./oracle-inputs.mjs");
  const {readValidationProofs} = await import("./oracle-validation.mjs");
  const owner = await git(root, ["rev-parse", "--absolute-git-dir"]), directory = path.join(owner, "oracle");
  const receipt = JSON.parse(await readMetadataFile(path.join(directory, "technical-receipts", `${admission.technical_receipt_sha256}.json`), "utf8", {root: owner}));
  if (receipt.verdict !== "APPROVED" || receipt.review_status !== "COMPLETE" || receipt.reviewed_tree !== sourceTree || receipt.receipt_sha256 !== admission.technical_receipt_sha256
      || (receipt.candidate_commit ?? sourceCommit) !== sourceCommit) throw new Error("CI export requires the exact complete independent native decision");
  const originals = await readValidationProofs({root, directory, validation: receipt.input_binding.validation, checkCurrentExecutable: false});
  const proofs = originals.filter(proof => proof.eligible && proof.original_eligible);
  const publicFiles = Object.fromEntries((await git(root, ["ls-tree", "-rz", sourceTree])).split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t")).split(" ")[2]]));
  const authorities = Object.fromEntries((receipt.input_binding.authorities ?? []).map(item => [item.path, item.sha256]));
  const current = {...publicFiles, ...authorities};
  const exact = new Map(await Promise.all(proofs.filter(proof => requiredCommands.some(command => canonical(command) === canonical(proof.record.command))).map(async proof =>
    [proof.record.record_sha256, !(await historicalInputComparisons({root, record: proof.record,
      current: Object.fromEntries(Object.entries(current).filter(([name]) => Object.hasOwn(publicFiles, name) || Object.hasOwn(proof.record.before.files, name)))})).some(item => item.changed)])));
  const checks = requiredCommands.flatMap(command => {
    const proof = proofs.find(proof => canonical(proof.record.command) === canonical(command) && exact.get(proof.record.record_sha256));
    return proof ? [{command, coverage: "EXACT_INPUT_EXECUTION", executions: [publicExecution(proof.record)]}] : [];
  });
  // A focused repair never turns a failed aggregate into a passing execution.
  // A composed claim needs an exact candidate manifest explicitly assessed by
  // the independent reviewer, binding each original passing execution.
  for (const evidence of receipt.input_binding.validation) {
    if (evidence.kind !== "file") continue;
    const filename = path.resolve(root, evidence.value.replace(/^@/, ""));
    if (!filename.startsWith(`${path.resolve(root, "Vault/tmp")}${path.sep}`) || !filename.endsWith(".json")) continue;
    let bytes; try { bytes = await readFile(filename); } catch { continue; }
    if (hash(bytes) !== evidence.sha256) throw new Error("Focused required-command manifest changed");
    let manifest; try { manifest = JSON.parse(bytes); } catch { continue; }
    if (manifest.schema !== "my-crm.required-command-coverage/v1") continue;
    if (!Array.isArray(manifest.checks)) throw new Error("Focused required-command manifest is malformed");
    // Native continuation retains original evidence. Historical manifests are
    // immutable supporting facts, never current command-coverage authority.
    if (manifest.source_commit !== sourceCommit || manifest.source_tree !== sourceTree) continue;
    const assessed = [...receipt.coverage ?? [], ...receipt.reused_coverage ?? []].some(item => item.criteria?.includes("required-command-coverage") && item.evidence?.includes(evidence.value));
    if (!assessed) throw new Error("Focused command coverage lacks an explicit exact-candidate independent assessment");
    for (const check of manifest.checks) {
      if (checks.some(item => canonical(item.command) === canonical(check.command))) continue;
      if (!requiredCommands.some(command => canonical(command) === canonical(check.command)) || !Array.isArray(check.executions) || !check.executions.length) throw new Error("Focused command coverage is incomplete");
      const selected = check.executions.map(id => originals.find(proof => proof.record.record_sha256 === id));
      const records = selected.map(proof => proof?.record);
      if (records.some(record => !record) || !records.some(record => canonical(record.command) === canonical(check.command))) throw new Error("Focused coverage requires the original passing required-command baseline and every passing repair proof");
      const executions = await Promise.all(selected.map(async proof => {
        const record = proof.record;
        if (!proof.eligible) throw new Error("Focused coverage requires intact original passing execution facts");
        if (proof.original_eligible) return publicExecution(record);
        const qualification = check.qualified_executions?.find(item => item.record_sha256 === record.record_sha256);
        const independentlyQualified = [...receipt.coverage ?? [], ...receipt.reused_coverage ?? []].some(item => item.criteria?.includes("qualified-historical-execution") && item.evidence?.includes(evidence.value));
        const changed = (await historicalInputComparisons({root, record, current})).filter(item => item.changed);
        const repairs = (qualification?.repair_executions ?? []).map(id => selected.find(item => item?.record.record_sha256 === id && item.original_eligible && item.eligible));
        const dispositionAssessed = [...receipt.coverage ?? [], ...receipt.reused_coverage ?? []].some(item => item.criteria?.includes("qualified-dependency-disposition") && item.evidence?.includes(evidence.value));
        const dependencyCovered = comparison => {
          const disposition = qualification?.affected_dependencies?.find(item => item.path === comparison.path);
          if (!disposition || disposition.current_hash !== comparison.current_hash || disposition.current_state !== comparison.current_state || comparison.current_state === "UNAVAILABLE") return false;
          if (disposition.disposition === "NON_EXECUTION_INPUT") return dispositionAssessed && typeof disposition.reason === "string" && disposition.reason.trim()
            && Array.isArray(disposition.evidence) && disposition.evidence.length && disposition.evidence.every(value => typeof value === "string" && value.trim());
          if (disposition.disposition !== "EXECUTION_COVERED") return false;
          return Object.hasOwn(authorities, comparison.path) || repairs.some(item => item && Object.hasOwn(item.record.before.files, comparison.path) && item.record.before.files[comparison.path] === comparison.current_hash);
        };
        if (!independentlyQualified || !qualification || qualification.original_scope_sha256 !== hash(canonical(record.before)) || qualification.original_output_sha256 !== record.output_sha256
            || !qualification.accepted_facts?.length || !qualification.limitations?.length || [...qualification.accepted_facts, ...qualification.limitations].some(value => typeof value !== "string" || !value.trim())
            || !Array.isArray(qualification.affected_dependencies) || canonical(qualification.affected_dependencies.map(item => item.path).sort()) !== canonical(changed.map(item => item.path))
            || !repairs.length || repairs.some(item => !item) || changed.some(item => !dependencyCovered(item))) throw new Error("Historical passing facts require exact independent qualification and complete affected dependency/repair coverage");
        return {...publicExecution(record), qualification: "INDEPENDENTLY_QUALIFIED_HISTORICAL_PASS"};
      }));
      checks.push({command: check.command, coverage: "BASELINE_PLUS_FOCUSED_REPAIR", executions});
    }
  }
  const missing = requiredCommands.filter(command => !checks.some(check => canonical(command) === canonical(check.command)));
  if (missing.length) throw new Error(`Required native validation coverage missing: ${missing.map(command => command.join(" ")).join("; ")}`);
  return checks;
}

export async function exportNativeValidation({root = process.cwd(), repository, sourceCommit, sourceTree, admission, remote = "origin", api = publicGithubRequest, ownerId, collect = collectNativeChecks,
  lsRemote = ref => remoteRef(root, remote, ref), pushRef = async args => git(root, args)} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("Validation export requires exact GitHub repository/source identities");
  await sourceIdentity(root, sourceCommit, sourceTree);
  const owner = await repositoryOwner({repository, ownerId, api});
  const checks = await collect({root, sourceCommit, sourceTree, admission});
  const envelope = verifyEnvelope({schema: "my-crm.public-command-validation/v1", repository, source_commit: sourceCommit, source_tree: sourceTree,
    contract_sha256: validationContractHash, issuer_sha256: issuerHash(repository, owner), checks}, {repository, owner, sourceCommit, sourceTree});
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`);
  if (bytes.length > validationEnvelopeLimit) throw new Error("Native validation envelope exceeds its bounded size");
  const evidence = await evidenceCommit(root, sourceCommit, bytes), ref = validationRef(sourceCommit);
  // The evidence commit's parent is the source, so this one leased push also
  // uploads the exact source objects. No branch, status or product ref moves.
  const observed = await lsRemote(ref);
  if (observed !== evidence.commit) {
    await pushRef(leasedPush(remote, evidence.commit, ref, observed));
    if (await lsRemote(ref) !== evidence.commit) throw new Error("Remote validation evidence ref differs from the exact pushed evidence commit");
  }
  return {source_commit: sourceCommit, source_tree: sourceTree, envelope_sha256: hash(bytes), blob_sha: evidence.blob, evidence_commit: evidence.commit, evidence_ref: ref};
}

// The evidence ref above is deliberately unwatched. Only after the exact-source
// command evidence exists may preparation trigger the existing repository
// workflow. Its required job completes validation before main push.
export async function admitRequiredCI({root = process.cwd(), repository, sourceCommit, sourceTree, remote = "origin", api = publicGithubRequest,
  lsRemote = ref => remoteRef(root, remote, ref), pushSource = async args => git(root, args), retryFailed} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("Required CI admission needs the exact repository/source/tree");
  const workflow = await api("GET", `repos/${repository}/actions/workflows/ci.yml`);
  if (!Number.isSafeInteger(workflow.id) || workflow.id < 1 || workflow.path !== requiredCIWorkflow || workflow.state !== "active") throw new Error("Required CI workflow identity or enabled state differs");
  const branch = `codex/validation-ready-${sourceCommit}`, ref = `refs/heads/${branch}`;
  const identity = {source_commit: sourceCommit, source_tree: sourceTree, workflow_path: requiredCIWorkflow, workflow_id: workflow.id, required_job: requiredCIJob};
  const lookup = async () => {
    const response = await api("GET", `repos/${repository}/actions/workflows/${workflow.id}/runs?head_sha=${sourceCommit}&per_page=100`);
    if (!Array.isArray(response.workflow_runs) || response.total_count !== response.workflow_runs.length) throw new Error("Required CI run response is malformed or incomplete");
    const runs = response.workflow_runs.filter(run => run.event === "pull_request" || run.event === "push" && ["main", branch].includes(run.head_branch));
    const valid = run => Number.isSafeInteger(run.id) && run.id > 0 && Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0
      && run.workflow_id === workflow.id && run.path === requiredCIWorkflow && run.head_sha === sourceCommit
      && typeof run.head_branch === "string" && run.head_branch.length > 0 && run.head_branch.length <= 1024 && !/[\x00-\x20\x7f]/.test(run.head_branch)
      && run.repository?.full_name?.toLowerCase() === repository.toLowerCase() && run.head_repository?.full_name?.toLowerCase() === repository.toLowerCase();
    if (runs.some(run => !valid(run))) throw new Error("Required CI run has a different source, repository or workflow identity");
    const results = [];
    for (const run of runs.sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt)) {
      const observed = {...identity, run_id: run.id, run_attempt: run.run_attempt, run_event: run.event, head_branch: run.head_branch, validation_ref: `refs/heads/${run.head_branch}`};
      if (run.status !== "completed") {
        if (!["queued", "in_progress", "requested", "waiting", "pending"].includes(run.status) || run.conclusion !== null) throw new Error("Required CI pending run state is malformed");
        results.push({...observed, status: "PENDING", reason: run.status}); continue;
      }
      if (run.conclusion !== "success") {results.push({...observed, status: "FAILED", reason: run.conclusion ?? "missing conclusion"}); continue;}
      const jobs = await api("GET", `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
      if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length) throw new Error("Required CI job response is malformed or incomplete");
      const selected = jobs.jobs.filter(job => job.name === requiredCIJob);
      if (selected.length !== 1) {results.push({...observed, status: "MISSING", reason: "Unique required test job is absent"}); continue;}
      const job = selected[0];
      if (!Number.isSafeInteger(job.id) || job.id < 1 || job.run_id !== run.id || job.head_sha !== sourceCommit || job.head_branch !== run.head_branch
          || job.run_attempt !== run.run_attempt) throw new Error("Required CI test job has a different run, attempt or source identity");
      if (job.status !== "completed") {
        if (!["queued", "in_progress", "waiting"].includes(job.status) || job.conclusion !== null) throw new Error("Required CI pending job state is malformed");
        results.push({...observed, job_id: job.id, status: "PENDING", reason: job.status}); continue;
      }
      if (job.conclusion !== "success") {results.push({...observed, job_id: job.id, status: "FAILED", reason: job.conclusion ?? "missing conclusion"}); continue;}
      return {...observed, job_id: job.id, status: "SUCCEEDED", prior_failed_runs: results.filter(item => item.status === "FAILED")};
    }
    return results.find(item => item.status === "PENDING") ?? results[0] ?? null;
  };
  // Existing PR/main/validation results are admitted before any ref mutation.
  // Identical source and workflow inputs already establish the required job.
  let result = await lookup();
  if (!result) {
    const existing = await lsRemote(ref);
    if (existing) {
      if (existing !== sourceCommit) throw new Error("Required CI validation ref differs from the fixed source");
    } else {
      await pushSource(leasedPush(remote, sourceCommit, ref, null));
      if (await lsRemote(ref) !== sourceCommit) throw new Error("Required CI validation ref differs from the fixed source after creation");
    }
    result = await lookup() ?? {...identity, validation_ref: ref, status: "MISSING", reason: "Exact-source required workflow has not appeared"};
  }
  if (retryFailed !== undefined) {
    if (result.status !== "FAILED" || result.run_id !== retryFailed.run_id || result.run_attempt !== retryFailed.run_attempt || result.run_attempt !== 1
        || typeof retryFailed.reason !== "string" || !retryFailed.reason.trim() || retryFailed.reason.length > 2048) throw new Error("Required CI retry needs the exact first failed attempt and a recorded recovery reason");
    try {await api("POST", `repos/${repository}/actions/runs/${result.run_id}/rerun-failed-jobs`);}
    catch (error) {
      if (error.code !== "MYCRM_PUBLIC_READ_ONLY") throw error;
      // No authenticated Actions write exists on this host. Keep the original
      // failure; a maintainer reruns it on GitHub and preparation resumes.
      return {...result, retry_requested: false, recovery_reason: retryFailed.reason, prior_failed_runs: [result],
        reason: `${result.reason}; authenticated rerun unavailable: re-run failed jobs at https://github.com/${repository}/actions/runs/${result.run_id}, then prepare again without --retry-ci`};
    }
    return {...result, status: "PENDING", reason: "Controlled failed-job retry requested", retry_requested: true, recovery_reason: retryFailed.reason, prior_failed_runs: [result]};
  }
  return result;
}

// CI imports evidence with Git only; the owner id comes from the Actions
// environment. Any mismatch imports nothing, so CI executes every command.
export async function importNativeValidation({root = process.cwd(), repository, sourceCommit, sourceTree, remote = "origin", ownerId = process.env.GITHUB_REPOSITORY_OWNER_ID, api = publicGithubRequest} = {}) {
  const result = {covered: [], invalidated: [], provenance: "ORIGINAL_NATIVE_EXECUTION"};
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("CI source identity is missing");
    const owner = await repositoryOwner({repository, ownerId, api});
    const ref = validationRef(sourceCommit), local = `refs/my-crm/imported-validation/${sourceCommit}`;
    try {await git(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+${ref}:${local}`]);}
    catch {throw new Error("Native validation evidence ref is absent or unreadable");}
    await sourceIdentity(root, sourceCommit, sourceTree);
    const commit = await git(root, ["rev-parse", "--verify", `${local}^{commit}`]);
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).split(" ").slice(1);
    if (parents.length !== 1 || parents[0] !== sourceCommit) throw new Error("Native validation evidence is not bound to the exact source parent");
    const entries = (await git(root, ["ls-tree", "-z", `${commit}^{tree}`])).split("\0").filter(Boolean);
    const entry = entries.length === 1 ? entries[0].match(/^100644 blob ([a-f0-9]{40})\tvalidation\.json$/) : null;
    if (!entry) throw new Error("Native validation evidence tree must hold only validation.json");
    if (Number(await git(root, ["cat-file", "-s", entry[1]])) > validationEnvelopeLimit) throw new Error("Native validation envelope exceeds its bounded size");
    const bytes = await gitBytes(root, ["cat-file", "blob", entry[1]], "");
    if (gitBlobHash(bytes) !== entry[1]) throw new Error("Native validation blob digest changed");
    if ((await evidenceCommit(root, sourceCommit, bytes)).commit !== commit) throw new Error("Native validation evidence commit is not the reproducible record for its envelope");
    const envelope = verifyEnvelope(JSON.parse(bytes), {repository, owner, sourceCommit, sourceTree});
    result.covered = envelope.checks.map(check => ({command: check.command, coverage: check.coverage, original_executions: check.executions}));
  } catch (error) {result.invalidated.push({reason: error.message});}
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "import") throw new Error("Transport export runs only during completed native validation preparation");
  const sourceCommit = await git(process.cwd(), ["rev-parse", "HEAD"]), sourceTree = await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]);
  console.log(JSON.stringify(await importNativeValidation({repository: process.env.GITHUB_REPOSITORY, sourceCommit, sourceTree})));
}
