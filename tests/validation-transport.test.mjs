import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile, symlink} from "node:fs/promises";
import {execFile} from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";
import {collectNativeChecks, exportNativeValidation, importNativeValidation, gitBlobHash, historicalInputComparisons, nativeCoverageIntake, requiredCommands, validationContext} from "../scripts/validation-transport.mjs";
import {bindingHash, evidenceBinding} from "../scripts/oracle-inputs.mjs";
import {validateRelease} from "../scripts/release-validation.mjs";
import {readValidationProofs, validationDigest} from "../scripts/oracle-validation.mjs";

const source = "a".repeat(40), tree = "b".repeat(40), repository = "synthetic-owner/my-crm";
const hash = value => createHash("sha256").update(value).digest("hex");
const checks = () => requiredCommands.map(command => ({command, coverage: "EXACT_INPUT_EXECUTION", executions: [{record_sha256: "c".repeat(64), command_sha256: hash(JSON.stringify(command)),
  input_sha256: "d".repeat(64), executable_sha256: "e".repeat(64), environment_sha256: "f".repeat(64), output_sha256: "1".repeat(64), original_environment: {node: "v22.11.0", platform: "darwin", architecture: "arm64"}}]}));
function service({unpublished = false, actor = 17} = {}) {
  const state = {calls: [], owner: {id: 17}, actor: {id: actor}, statuses: [], blob: null, exists: !unpublished};
  const api = async (method, endpoint, body) => {
    state.calls.push({method, endpoint, body});
    if (endpoint === `repos/${repository}`) return {owner: state.owner};
    if (endpoint === "user") return state.actor;
    if (endpoint === `repos/${repository}/git/commits/${source}` && method === "GET") {
      if (!state.exists) throw Object.assign(new Error("Synthetic source object absent"), {status: 404});
      return {sha: source, tree: {sha: tree}};
    }
    if (endpoint.endsWith("/git/blobs") && method === "POST") {state.blob = {encoding: body.encoding, content: body.content, sha: gitBlobHash(Buffer.from(body.content, "base64"))}; return {sha: state.blob.sha};}
    if (endpoint.includes("/git/blobs/") && method === "GET") return state.blob;
    if (endpoint.endsWith("/git/trees")) return {sha: "2".repeat(40)};
    if (endpoint.endsWith("/git/commits")) return {sha: "3".repeat(40)};
    if (endpoint.endsWith("/git/refs")) return {ref: body.ref, object: {sha: body.sha}};
    if (endpoint.includes("/statuses?")) return endpoint.includes(`/commits/${source}/`) ? state.statuses : [];
    if (endpoint.endsWith(`/statuses/${source}`)) {const status = {...body, creator: state.actor}; state.statuses.unshift(status); return status;}
    throw new Error(`Unexpected synthetic API call: ${method} ${endpoint}`);
  };
  return {state, api};
}
async function exported(options = {}) {
  const f = service(options);
  f.result = await exportNativeValidation({repository, sourceCommit: source, sourceTree: tree, api: f.api, collect: async () => checks(), pushSource: async args => {
    assert.deepEqual(args, ["push", "origin", `${source}:refs/heads/codex/validation-source-${source}`]); f.state.calls.push({method: "GIT_SOURCE_PREPARATION"}); f.state.exists = true;
  }});
  return f;
}

test("first CI consumes owner-authenticated native original checks and repeats zero validations", async () => {
  const f = await exported(), prior = await importNativeValidation({repository, sourceCommit: source, sourceTree: tree, api: f.api}), executed = [];
  assert.equal(prior.covered.length, 3); assert.deepEqual(prior.invalidated, []);
  await validateRelease({nativeEvidence: false, priorCoverage: prior, execute: async args => executed.push(args)});
  assert.deepEqual(executed, []);
  assert.equal(prior.provenance, "ORIGINAL_NATIVE_EXECUTION");
  assert.equal(prior.covered[1].original_executions[0].original_environment.platform, "darwin");
  assert.equal(f.state.statuses[0].context, validationContext);
  const publicBytes = Buffer.from(f.state.blob.content, "base64").toString();
  assert.doesNotMatch(publicBytes, /Vault|\/Users\/|\/home\/|token|stderr|review|CODEX_|PATH|execution_cwd/i);
});

test("unpublished source is uploaded during validation preparation before status issuance", async () => {
  const f = await exported({unpublished: true});
  const prepared = f.state.calls.findIndex(item => item.method === "GIT_SOURCE_PREPARATION"), status = f.state.calls.findIndex(item => item.endpoint?.endsWith(`/statuses/${source}`));
  assert.ok(prepared >= 0 && status > prepared);
  assert.ok(f.state.calls.some(item => item.body?.ref?.startsWith("refs/heads/codex/validation-evidence-")), "Immutable blob has no durable reachable evidence ref");
});

test("wrong actor, altered blob, changed source/tree/command contract and failed status invalidate coverage", async () => {
  await assert.rejects(exported({actor: 18}), /repository owner/);
  for (const mutation of ["actor", "bytes", "tree", "contract", "failure"]) {
    const f = await exported();
    if (mutation === "actor") f.state.statuses[0].creator = {id: 18};
    if (mutation === "bytes") f.state.blob.content = Buffer.from("synthetic altered envelope").toString("base64");
    if (mutation === "failure") f.state.statuses[0].state = "failure";
    if (mutation === "contract") {
      const envelope = JSON.parse(Buffer.from(f.state.blob.content, "base64")); envelope.contract_sha256 = "9".repeat(64);
      const bytes = Buffer.from(JSON.stringify(envelope)); f.state.blob.content = bytes.toString("base64"); f.state.blob.sha = gitBlobHash(bytes);
      f.state.statuses[0].target_url = `https://api.github.com/repos/${repository}/git/blobs/${f.state.blob.sha}`; f.state.statuses[0].description = `sha256:${hash(bytes)}`;
    }
    const prior = await importNativeValidation({repository, sourceCommit: source, sourceTree: mutation === "tree" ? "4".repeat(40) : tree, api: f.api});
    assert.deepEqual(prior.covered, [], mutation); assert.equal(prior.invalidated.length, 1, mutation);
  }
});

test("PR source head coverage is accepted and a different synthetic merge SHA is explicitly uncovered", async () => {
  const f = await exported();
  assert.equal((await importNativeValidation({repository, sourceCommit: source, sourceTree: tree, api: f.api})).covered.length, 3);
  assert.equal((await importNativeValidation({repository, sourceCommit: "5".repeat(40), sourceTree: tree, api: f.api})).covered.length, 0);
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
});

test("strict public schema rejects private metadata and missing checks execute only their required commands", async () => {
  const f = service(), unsafe = checks(); unsafe[0].executions[0].original_environment.token = "synthetic-forbidden-secret";
  await assert.rejects(exportNativeValidation({repository, sourceCommit: source, sourceTree: tree, api: f.api, collect: async () => unsafe}), /metadata/);
  assert.equal(f.state.calls.some(item => item.method === "POST"), false);
  const executed = [];
  await validateRelease({nativeEvidence: false, priorCoverage: {covered: [{command: requiredCommands[1], coverage: "EXACT_INPUT_EXECUTION"}], invalidated: []}, execute: async args => executed.push(args)});
  assert.deepEqual(executed, [requiredCommands[0], requiredCommands[2]]);
});

test("export verifies actual native originals and composes only independently assessed passing baseline plus repair", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-native-transport-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const execute = promisify(execFile), git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await mkdir(path.join(root, "Vault/docs"), {recursive: true}); await mkdir(path.join(root, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(root, "Vault/docs/CONSTITUTION.md"), "Synthetic constitution.\n"); await writeFile(path.join(root, "AGENTS.md"), "Synthetic policy.\n");
  await writeFile(path.join(root, ".agents/skills/oracle/SKILL.md"), "Synthetic isolated reviewer fixture.\n");
  await writeFile(path.join(root, ".gitignore"), "Vault/\ndist/\n"); await writeFile(path.join(root, "candidate.txt"), "Synthetic source before repair.\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({name: "synthetic-native-transport", type: "module", scripts: {build: "node synthetic-check.mjs build", test: "node synthetic-check.mjs test", "check:release": "node synthetic-check.mjs package"}}));
  await writeFile(path.join(root, "synthetic-check.mjs"), "import{mkdir,writeFile}from'node:fs/promises';if(process.argv[2]==='build'){await mkdir('dist/my-crm',{recursive:true});await writeFile('dist/my-crm/artifact.txt','synthetic artifact');}console.log('Synthetic original command ran');if(process.argv[2]==='test'&&process.env.SYNTHETIC_FAIL_NATIVE_CHECK)process.exitCode=1;\n");
  await git("init", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid"); await git("add", "."); await git("commit", "-m", "Synthetic source baseline");
  const launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url)), env = {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", CODEX_SELECTED_REASONING_EFFORT: "high"};
  const capture = async (command, extra = {}) => {
    const names = (await git("ls-files")).split("\n"), args = [launcher, "validate", ...names.flatMap(name => ["--input", name]), "--", ...command];
    let output; try {output = (await execute(process.execPath, args, {cwd: root, env: {...env, ...extra}})).stdout;} catch (error) {output = error.stdout;}
    const reference = output.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)?.[1]; assert.ok(reference, output);
    return {reference, record: JSON.parse(await readFile(reference.slice(1)))};
  };
  let originals = await Promise.all(requiredCommands.map(command => capture(command)));
  const store = path.join(root, ".git/oracle/technical-receipts"); await mkdir(store, {recursive: true});
  const admission = {technical_receipt_sha256: "9".repeat(64)};
  const receipt = async (proofs, coverage = [], extraEvidence = []) => {
    const sourceCommit = await git("rev-parse", "HEAD"), sourceTree = await git("rev-parse", "HEAD^{tree}");
    await writeFile(path.join(store, `${admission.technical_receipt_sha256}.json`), JSON.stringify({verdict: "APPROVED", review_status: "COMPLETE", candidate_commit: sourceCommit, reviewed_tree: sourceTree, receipt_sha256: admission.technical_receipt_sha256,
      input_binding: {authorities: proofs[0].record.review_provenance.before.inputs.authorities, validation: [...await Promise.all(proofs.map(proof => evidenceBinding(root, proof.reference))), ...extraEvidence]}, coverage}));
    return {root, sourceCommit, sourceTree, admission};
  };
  assert.equal((await collectNativeChecks(await receipt(originals))).length, 3);
  const failed = await capture(requiredCommands[1], {SYNTHETIC_FAIL_NATIVE_CHECK: "true"});
  assert.equal(failed.record.outcome, "FAILED");
  await assert.rejects(collectNativeChecks(await receipt([originals[0], failed, originals[2]])), /coverage missing/);
  const baseline = originals[1]; await writeFile(path.join(root, "candidate.txt"), "Synthetic repaired source.\n"); await git("add", "."); await git("commit", "-m", "Synthetic focused repair changelist");
  const focused = await capture([process.execPath, "synthetic-check.mjs", "focused"]);
  originals = [await capture(requiredCommands[0]), baseline, await capture(requiredCommands[2]), focused];
  const candidate = {source_commit: await git("rev-parse", "HEAD"), source_tree: await git("rev-parse", "HEAD^{tree}")};
  const manifestPath = path.join(root, "Vault/tmp/required-command-coverage.json"); await mkdir(path.dirname(manifestPath), {recursive: true});
  await writeFile(manifestPath, JSON.stringify({schema: "my-crm.required-command-coverage/v1", ...candidate, checks: [{command: requiredCommands[1], executions: [baseline.record.record_sha256, focused.record.record_sha256]}]}));
  const manifest = await evidenceBinding(root, `@${manifestPath}`);
  await assert.rejects(collectNativeChecks(await receipt(originals, [], [manifest])), /explicit exact-candidate independent assessment/);
  const coverage = [{path: "package.json", criteria: ["required-command-coverage"], evidence: [manifest.value]}];
  const composed = await collectNativeChecks(await receipt(originals, coverage, [manifest]));
  assert.equal(composed.find(check => JSON.stringify(check.command) === JSON.stringify(requiredCommands[1])).coverage, "BASELINE_PLUS_FOCUSED_REPAIR");
  const original = composed.find(check => check.coverage === "BASELINE_PLUS_FOCUSED_REPAIR").executions[0];
  assert.equal(original.input_sha256, bindingHash(baseline.record.before));
  assert.equal(original.record_sha256, baseline.record.record_sha256);
  assert.equal(original.output_sha256, baseline.record.output_sha256);
  // A synthetic legacy record retains its real original output/input hashes,
  // while deliberately representing unavailable historical custody/cwd facts.
  const privateInput = "Vault/tmp/original-input.txt", generatedGuide = "Vault/tmp/generated-guide.txt";
  await writeFile(path.join(root, privateInput), "Synthetic unchanged original private input.\n");
  await writeFile(path.join(root, generatedGuide), "Synthetic current generated navigation.\n");
  const legacyRecord = structuredClone(baseline.record); delete legacyRecord.execution_cwd; delete legacyRecord.output_custody; delete legacyRecord.recorder_environment;
  legacyRecord.before.files[privateInput] = gitBlobHash(await readFile(path.join(root, privateInput)));
  legacyRecord.before.files[generatedGuide] = gitBlobHash(Buffer.from("Synthetic previous generated navigation.\n"));
  legacyRecord.after = structuredClone(legacyRecord.before);
  legacyRecord.record_sha256 = validationDigest(legacyRecord);
  const legacyPath = path.join(root, ".git/oracle/validations", `${legacyRecord.record_sha256}.json`);
  await writeFile(legacyPath, `${JSON.stringify(legacyRecord)}\n`);
  const legacy = {reference: `@${legacyPath}`, record: legacyRecord};
  const [strict] = await readValidationProofs({root, directory: path.join(root, ".git/oracle"), validation: [await evidenceBinding(root, legacy.reference)]});
  assert.equal(strict.eligible, false); assert.equal(strict.original_eligible, false);
  const publicFiles = Object.fromEntries((await git("ls-tree", "-rz", candidate.source_tree)).split("\0").filter(Boolean).map(entry => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t")).split(" ")[2]]));
  const current = {...publicFiles, ...Object.fromEntries(originals[0].record.review_provenance.before.inputs.authorities.map(item => [item.path, item.sha256]))};
  const comparisons = await historicalInputComparisons({root, record: legacyRecord, current});
  assert.equal(comparisons.find(item => item.path === privateInput).changed, false);
  assert.equal(comparisons.find(item => item.path === privateInput).current_state, "PRIVATE_INPUT_BYTES");
  const changed = comparisons.filter(item => item.changed);
  const qualified = {schema: "my-crm.required-command-coverage/v1", ...candidate, checks: [{command: requiredCommands[1], executions: [legacyRecord.record_sha256, focused.record.record_sha256], qualified_executions: [{record_sha256: legacyRecord.record_sha256,
    original_scope_sha256: bindingHash(legacyRecord.before), original_output_sha256: legacyRecord.output_sha256,
    accepted_facts: ["The original required command passed with retained input and output hashes; current repair closure was independently assessed."],
    limitations: ["Original execution cwd and transitive output custody are unknown and remain unclaimed."],
    affected_dependencies: changed.map(item => ({path: item.path, current_hash: item.current_hash, current_state: item.current_state,
      disposition: item.path === generatedGuide ? "NON_EXECUTION_INPUT" : "EXECUTION_COVERED",
      ...(item.path === generatedGuide ? {reason: "Generated navigation is outside the declared synthetic check command closure.", evidence: ["The check imports only node:fs/promises and reads no guide."]} : {})})), repair_executions: [focused.record.record_sha256]}]}]};
  const qualifiedPath = path.join(root, "Vault/tmp/qualified-historical-coverage.json");
  await writeFile(qualifiedPath, JSON.stringify(qualified)); const qualifiedEvidence = await evidenceBinding(root, `@${qualifiedPath}`);
  const qualifiedProofs = [originals[0], legacy, originals[2], focused];
  const qualificationCoverage = [{path: "package.json", criteria: ["required-command-coverage", "qualified-historical-execution", "qualified-dependency-disposition"], evidence: [qualifiedEvidence.value]}];
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, [{...qualificationCoverage[0], criteria: ["required-command-coverage"]}], [qualifiedEvidence])), /independent qualification/);
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, [{...qualificationCoverage[0], criteria: ["required-command-coverage", "qualified-historical-execution"]}], [qualifiedEvidence])), /complete affected dependency/);
  const qualifiedChecks = await collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [qualifiedEvidence]));
  const historicalExecution = qualifiedChecks.find(check => check.coverage === "BASELINE_PLUS_FOCUSED_REPAIR").executions[0];
  assert.equal(historicalExecution.qualification, "INDEPENDENTLY_QUALIFIED_HISTORICAL_PASS"); assert.equal(historicalExecution.original_environment, null);
  assert.equal(historicalExecution.record_sha256, legacyRecord.record_sha256); assert.equal(strict.eligible, false);
  assert.doesNotMatch(JSON.stringify(qualifiedChecks), /Vault|generated-guide|original-input|Synthetic previous|Synthetic current/);
  await writeFile(path.join(root, privateInput), "Synthetic genuine uncovered command-input change.\n");
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [qualifiedEvidence])), /complete affected dependency/);
  await writeFile(path.join(root, privateInput), "Synthetic unchanged original private input.\n");
  qualified.checks[0].qualified_executions[0].affected_dependencies.pop();
  await writeFile(qualifiedPath, JSON.stringify(qualified));
  await assert.rejects(collectNativeChecks(await receipt(qualifiedProofs, qualificationCoverage, [await evidenceBinding(root, `@${qualifiedPath}`)])), /complete affected dependency/);
  qualified.checks[0].executions[0] = failed.record.record_sha256;
  await writeFile(qualifiedPath, JSON.stringify(qualified));
  await assert.rejects(collectNativeChecks(await receipt([originals[0], failed, originals[2], focused], qualificationCoverage, [await evidenceBinding(root, `@${qualifiedPath}`)])), /intact original passing/);
  const historicalPath = path.join(root, "Vault/tmp/required-command-coverage-original.json");
  const source = baseline.record.review_provenance.before.base_commit;
  await writeFile(historicalPath, JSON.stringify({schema: "my-crm.required-command-coverage/v1", source_commit: source, source_tree: await git("rev-parse", `${source}^{tree}`), checks: []}));
  const historical = await evidenceBinding(root, `@${historicalPath}`);
  assert.equal((await collectNativeChecks(await receipt(originals, coverage, [manifest, historical]))).length, 3);
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [historical])), /coverage missing/);
  await writeFile(historicalPath, "{}\n");
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [manifest, historical])), /manifest changed/);
  await writeFile(baseline.record.output_file, "Synthetic altered original output\n");
  await assert.rejects(collectNativeChecks(await receipt(originals, coverage, [manifest])), /output is missing or changed/);
});

test("historical identity audit distinguishes source/private absence and refuses unavailable custody", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-historical-inputs-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  await promisify(execFile)("git", ["init", "-b", "main"], {cwd: root});
  await writeFile(path.join(root, ".gitignore"), "Vault/\n"); await mkdir(path.join(root, "Vault"));
  await writeFile(path.join(root, "Vault/actual"), "Synthetic private bytes");
  await symlink("actual", path.join(root, "Vault/link"));
  const record = {before: {files: {"deleted.mjs": "a".repeat(40), "Vault/missing": "b".repeat(40), "Vault/actual": gitBlobHash(Buffer.from("Synthetic private bytes")), "Vault/link": "c".repeat(40), "/outside-owner.txt": "d".repeat(64)}}};
  const compared = await historicalInputComparisons({root, record, current: {}});
  assert.deepEqual(compared.map(item => [item.path, item.current_state]), [["/outside-owner.txt", "UNAVAILABLE"], ["Vault/actual", "PRIVATE_INPUT_BYTES"], ["Vault/link", "UNAVAILABLE"], ["Vault/missing", "PRIVATE_INPUT_ABSENT"], ["deleted.mjs", "SOURCE_TREE_ABSENT"]]);
  assert.equal(compared.find(item => item.path === "Vault/actual").changed, false);
});

test("native intake binds exact candidate and actual original commands without granting assessment", async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-intake-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  const filename = path.join(root, "Vault/tmp/command-coverage.json"); await mkdir(path.dirname(filename), {recursive: true});
  const proofs = requiredCommands.map((command,index) => ({record: {record_sha256: String(index+1).repeat(64), command, outcome: "PASSED", exit_code: 0, signal: null, error: null, before: {files: {"source.mjs":"original"}}, after: {files: {"source.mjs":"original"}}}}));
  const manifest = {schema:"my-crm.required-command-coverage/v1", source_commit: source, source_tree:tree, checks:requiredCommands.map((command,index)=>({command,executions:[proofs[index].record.record_sha256]}))};
  const intake = async () => {await writeFile(filename,JSON.stringify(manifest));return nativeCoverageIntake({root,sourceCommit:source,sourceTree:tree,validation:[await evidenceBinding(root,`@${filename}`)],proofs});};
  const ready = await intake(); assert.equal(ready.status,"READY_FOR_INDEPENDENT_ASSESSMENT"); assert.equal(ready.grants_approval,false); assert.equal(ready.grants_command_coverage,false);
  manifest.source_tree="c".repeat(40); const missing=await intake(); assert.equal(missing.status,"INCOMPLETE"); assert.equal((await intake()).identity_sha256,missing.identity_sha256);
  manifest.source_tree=tree; proofs[1].record.outcome="FAILED"; assert.equal((await intake()).status,"INCOMPLETE");
  proofs[1].record.outcome="PASSED"; proofs[1].record.after.files["source.mjs"]="changed"; assert.equal((await intake()).status,"INCOMPLETE");
});
