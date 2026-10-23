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
export const requiredCommands = Object.freeze([["npm", "run", "build"], ["npm", "test"], ["npm", "run", "check:release"]]);
export const validationContext = "my-crm/native-validation";
export const requiredCIWorkflow = ".github/workflows/ci.yml";
export const requiredCIJob = "test";
const contract = {required_commands: requiredCommands, execution_contract: "accept-original-supported-native-execution", additional_platform_executions: []};
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

// gh owns existing credentials. Structured JSON travels on stdin, never shell
// text or command-line token arguments; no response logs are published.
export async function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["api", endpoint, "--method", method, "-H", "Accept: application/vnd.github+json", ...(body === undefined ? [] : ["--input", "-"])], {stdio: ["pipe", "pipe", "pipe"]});
    const output = [], errors = []; let size = 0;
    child.stdout.on("data", value => {size += value.length; if (size > 4 * 1024 * 1024) child.kill(); else output.push(value);});
    child.stderr.on("data", value => errors.push(value)); child.once("error", reject); child.stdin.on("error", reject);
    child.once("close", code => {
      if (code !== 0 || size > 4 * 1024 * 1024) {const status = Buffer.concat(errors).toString().match(/\b(?:4\d\d|5\d\d)\b/)?.[0]; const error = new Error(`GitHub validation transport request failed (${status ?? code})`); error.status = status ? Number(status) : null; reject(error);}
      else try {const bytes = Buffer.concat(output).toString(); resolve(bytes.trim() ? JSON.parse(bytes) : null);} catch (error) {reject(error);}
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
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

export async function exportNativeValidation({root = process.cwd(), repository, sourceCommit, sourceTree, admission, remote = "origin", api = githubRequest, collect = collectNativeChecks, pushSource = async args => git(root, args)} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("Validation export requires exact GitHub repository/source identities");
  const metadata = await api("GET", `repos/${repository}`), actor = await api("GET", "user");
  if (actor.id !== metadata.owner.id) throw new Error("Only the authenticated repository owner can issue native validation attestations");
  const checks = await collect({root, sourceCommit, sourceTree, admission});
  const envelope = verifyEnvelope({schema: "my-crm.public-command-validation/v1", repository, source_commit: sourceCommit, source_tree: sourceTree,
    contract_sha256: validationContractHash, issuer_sha256: issuerHash(repository, metadata.owner), checks}, {repository, owner: metadata.owner, sourceCommit, sourceTree});
  let source;
  try {source = await api("GET", `repos/${repository}/git/commits/${sourceCommit}`);} catch (error) {
    if (error.status !== 404) throw error;
    await pushSource(["push", remote, `${sourceCommit}:refs/heads/codex/validation-source-${sourceCommit}`]);
    source = await api("GET", `repos/${repository}/git/commits/${sourceCommit}`);
  }
  if (source.sha !== sourceCommit || source.tree?.sha !== sourceTree) throw new Error("GitHub source object differs from the exact native candidate");
  const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`), blob = await api("POST", `repos/${repository}/git/blobs`, {content: bytes.toString("base64"), encoding: "base64"});
  if (blob.sha !== gitBlobHash(bytes)) throw new Error("GitHub stored a different native validation blob");
  // Keep the immutable blob reachable through an evidence-only ref. No product
  // branch, source, package or public runtime contract changes here.
  const tree = await api("POST", `repos/${repository}/git/trees`, {tree: [{path: "validation.json", mode: "100644", type: "blob", sha: blob.sha}]});
  const commit = await api("POST", `repos/${repository}/git/commits`, {message: `Native command coverage for ${sourceCommit}`, tree: tree.sha, parents: [sourceCommit]});
  const ref = `refs/heads/codex/validation-evidence-${sourceCommit}-${blob.sha}`;
  try {await api("POST", `repos/${repository}/git/refs`, {ref, sha: commit.sha});}
  catch (error) {const existing = await api("GET", `repos/${repository}/git/ref/${ref.slice(5)}`), retained = await api("GET", `repos/${repository}/git/commits/${existing.object?.sha}`);
    if (retained.tree?.sha !== tree.sha || !retained.parents?.some(parent => parent.sha === sourceCommit)) throw error;}
  const description = `sha256:${hash(bytes)}`, target_url = `https://api.github.com/repos/${repository}/git/blobs/${blob.sha}`;
  const status = await api("POST", `repos/${repository}/statuses/${sourceCommit}`, {state: "success", context: validationContext, description, target_url});
  if (status.creator?.id !== metadata.owner.id || status.state !== "success") throw new Error("GitHub status issuer differs from the validated owner");
  return {source_commit: sourceCommit, source_tree: sourceTree, envelope_sha256: hash(bytes), blob_sha: blob.sha, status_context: validationContext};
}

// The source upload above is deliberately unwatched. Only after the trusted
// exact-source command attestation exists may preparation trigger the existing
// repository workflow. Its required job completes validation before main push.
export async function admitRequiredCI({root = process.cwd(), repository, sourceCommit, sourceTree, remote = "origin", api = githubRequest,
  pushSource = async args => git(root, args), retryFailed} = {}) {
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
    let existing;
    try {existing = await api("GET", `repos/${repository}/git/ref/heads/${branch}`);} catch (error) {if (error.status !== 404) throw error;}
    if (existing) {
      if (existing.ref !== ref || existing.object?.type !== "commit" || existing.object.sha !== sourceCommit) throw new Error("Required CI validation ref differs from the fixed source");
    } else await pushSource(["push", remote, `${sourceCommit}:${ref}`]);
    result = await lookup() ?? {...identity, validation_ref: ref, status: "MISSING", reason: "Exact-source required workflow has not appeared"};
  }
  if (retryFailed !== undefined) {
    if (result.status !== "FAILED" || result.run_id !== retryFailed.run_id || result.run_attempt !== retryFailed.run_attempt || result.run_attempt !== 1
        || typeof retryFailed.reason !== "string" || !retryFailed.reason.trim() || retryFailed.reason.length > 2048) throw new Error("Required CI retry needs the exact first failed attempt and a recorded recovery reason");
    await api("POST", `repos/${repository}/actions/runs/${result.run_id}/rerun-failed-jobs`);
    return {...result, status: "PENDING", reason: "Controlled failed-job retry requested", retry_requested: true, recovery_reason: retryFailed.reason, prior_failed_runs: [result]};
  }
  return result;
}

export async function importNativeValidation({repository, sourceCommit, sourceTree, api = githubRequest} = {}) {
  const result = {covered: [], invalidated: [], provenance: "ORIGINAL_NATIVE_EXECUTION"};
  try {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") || !oid.test(sourceCommit ?? "") || !oid.test(sourceTree ?? "")) throw new Error("CI source identity is missing");
    const metadata = await api("GET", `repos/${repository}`);
    let status;
    for (let page = 1; page <= 10 && !status; page++) {
      const rows = await api("GET", `repos/${repository}/commits/${sourceCommit}/statuses?per_page=100&page=${page}`);
      status = rows.find(item => item.context === validationContext && item.creator?.id === metadata.owner.id);
      if (rows.length < 100) break;
    }
    if (!status || status.state !== "success") throw new Error("Passing repository-owner native validation status is absent");
    const prefix = `https://api.github.com/repos/${repository}/git/blobs/`, blobSha = status.target_url?.startsWith(prefix) ? status.target_url.slice(prefix.length) : "";
    if (!oid.test(blobSha) || !/^sha256:[a-f0-9]{64}$/.test(status.description ?? "")) throw new Error("Native status target or digest is invalid");
    const blob = await api("GET", `repos/${repository}/git/blobs/${blobSha}`);
    if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.content.length > 1024 * 1024) throw new Error("Native validation blob encoding/size is invalid");
    const bytes = Buffer.from(blob.content, "base64");
    if (gitBlobHash(bytes) !== blobSha || hash(bytes) !== status.description.slice(7)) throw new Error("Native validation blob/output digest changed");
    const envelope = verifyEnvelope(JSON.parse(bytes), {repository, owner: metadata.owner, sourceCommit, sourceTree});
    result.covered = envelope.checks.map(check => ({command: check.command, coverage: check.coverage, original_executions: check.executions}));
  } catch (error) {result.invalidated.push({reason: error.message});}
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "import") throw new Error("Transport export runs only during completed native validation preparation");
  const sourceCommit = await git(process.cwd(), ["rev-parse", "HEAD"]), sourceTree = await git(process.cwd(), ["rev-parse", "HEAD^{tree}"]);
  console.log(JSON.stringify(await importNativeValidation({repository: process.env.GITHUB_REPOSITORY, sourceCommit, sourceTree})));
}
