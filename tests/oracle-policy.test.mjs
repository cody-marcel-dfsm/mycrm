import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {policyFingerprint as implementationFingerprint, policyModules, legacyPolicy, policyVersion} from "../scripts/oracle-policy.mjs";
import {bindingHash, contentHash} from "../scripts/oracle-inputs.mjs";
import {prepareSeries, assessRound, saveRound, verifySeries} from "../scripts/oracle-series.mjs";

const execute = promisify(execFile);
const names = policyModules;
const implementation = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8")])));
const policyFingerprint = (review, series) => implementationFingerprint(review, series, {...implementation, "oracle-review.mjs": review, "oracle-series.mjs": series});
const source = async () => Promise.all(names.map((name) => readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8")));

test("actual emitted role, API/execution/series policies, prompts, schema and launch controls are fingerprinted", async () => {
  const [, review, series] = await source(); const original = policyFingerprint(review, series);
  for (const [before, after, area] of [
    ["independent My CRM project-local Oracle approver", "changed independent reviewer role", "review"],
    ["Assess API-version impact independently", "Changed API-version impact instructions", "review"],
    ["Run locally in the canonical checkout", "Changed execution instructions", "review"],
    ["Use read-only inspection. Do not edit, stage, commit, or run a release.", "Changed completed review instructions.", "review"],
    ["Verify the stated problem and cause.", "Changed proposal instructions.", "review"],
    ['"--ephemeral"', '"--changed-launch"', "review"],
    ['enum: ["NONE", "CHANGE"]', 'enum: ["NONE"]', "review"],
    ["Findings require stable IDs", "Changed finding contract", "series"],
    ['enum: ["COMPLETE", "INCOMPLETE"]', 'enum: ["COMPLETE"]', "series"],
  ]) {
    assert.ok((area === "review" ? review : series).includes(before));
    assert.notEqual(policyFingerprint(area === "review" ? review.replaceAll(before, after) : review, area === "series" ? series.replaceAll(before, after) : series), original);
  }
  assert.ok(review.includes("ORACLE_REPAIR_SYNTHESIS="));
  // Import-bearing controlling emission modules use complete ordered custody.
  assert.notEqual(policyFingerprint(review.replaceAll("ORACLE_REPAIR_SYNTHESIS=", "ORACLE_DIAGNOSTIC_SYNTHESIS="), series), original);
  assert.throws(() => policyFingerprint(review.replace("const trustedReviewerRole", "const missingRole"), series), /complete reviewer policy/);
});

test("historical Git policy equivalence preserves unaffected coverage and fails closed without original source proof", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-policy-")); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "scripts")); const sources = await source();
  for (const [index, name] of names.entries()) await writeFile(path.join(root, "scripts", name), sources[index]);
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await git("init", "-q"); await git("add", "scripts"); const tree = await git("write-tree");
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [`scripts/${name}`, await git("rev-parse", `${tree}:scripts/${name}`)])));
  const directory = path.join(root, ".git/oracle");
  const options = {root, directory, candidate: {base: "synthetic-base", tree, files: ["a.mjs", "b.mjs"]}, inputs: {authorities: [], tool_sha256: bindingHash(sources.map(contentHash)), tool_source_files: names, owner: null, validation: [], proposal_sha256: null}, files: {...files, "a.mjs": "a1", "b.mjs": "b1"}, environment: "synthetic-env"};
  const coverage = (name, dependencies = [name]) => ({path: name, dependencies, dependency_rationale: "Complete synthetic source closure.", assessment: "Reviewed synthetic behavior.", criteria: ["Synthetic behavior."], evidence: ["Synthetic source inspection."], finding_ids: []});
  const response = {review_status: "COMPLETE", verdict: "APPROVED", coverage: [coverage("a.mjs", ["a.mjs", "scripts/oracle-review.mjs"]), coverage("b.mjs")], findings: [], resolutions: [], validations: [], reused_validations: [], reused_coverage: [], synthesis: null, unreviewed: []};
  const initial = await prepareSeries(options); await saveRound(initial, response, assessRound(initial, response, []));
  const fingerprint = policyFingerprint(sources[1], sources[2]);
  const changed = {...options, inputs: {...options.inputs, tool_sha256: "implementation-changed", reviewer_policy_sha256: fingerprint, reviewer_policy_version: await policyVersion()}, files: {...options.files, "scripts/oracle-review.mjs": "implementation-changed"}};
  const next = await prepareSeries(changed);
  assert.equal(next.public.reviewer_policy_equivalence.sha256, fingerprint);
  assert.deepEqual(next.public.eligible_coverage.map((item) => item.path), ["b.mjs"]);
  const repaired = {...response, coverage: [coverage("a.mjs"), coverage("scripts/oracle-review.mjs")], reused_coverage: ["b.mjs"]};
  const saved = await saveRound(next, repaired, assessRound(next, repaired, []));
  assert.equal(verifySeries(saved, options.candidate.base), saved);
  const changedPolicy = await prepareSeries({...changed, inputs: {...changed.inputs, reviewer_policy_sha256: "changed-policy"}});
  assert.deepEqual(changedPolicy.public.eligible_coverage, []);
  assert.equal((await legacyPolicy({...initial.snapshot, tool_binding_sha256: "unverified"}, root)).sha256, null);
  assert.equal((await legacyPolicy({...initial.snapshot, tree: "unavailable-tree"}, root)).sha256, null);
  await writeFile(path.join(root, "scripts/oracle-review.mjs"), "Changed working source must never substitute for original Git evidence.");
  assert.equal((await legacyPolicy(initial.snapshot, root)).sha256, fingerprint);
});


test("post-assignment policy mutations, aliases and unsupported construction fail closed", async () => {
  const [, review, series] = await source();
  for (const addition of [
    'trustedReviewerRole += "changed";',
    'responseSchema.properties.extra = {type: "string"};',
    'responseSchema["properties"]["extra"] = {type: "string"};',
    'responseSchema.required.push("extra");',
    'responseSchema["required"]["push"]("extra");',
    'responseSchema.required.push?.("extra");',
    'Object["assign"](responseSchema, {extra: {}});',
    'const alias = responseSchema.properties; alias.extra = {};',
    'let alias; alias = responseSchema; Object.assign(alias, {});',
    'Object.assign(responseSchema.properties, {extra: {}});',
    'Reflect.set(responseSchema, "extra", {});',
    'const {properties: alias} = responseSchema; alias.extra = {};',
    'mutatePolicy(responseSchema);',
    'reviewSeriesSchemaProperties.coverage.extra = {};',
    '[alias] = [responseSchema]; alias.extra = {};',
  ]) assert.throws(() => policyFingerprint(`${review}\n${addition}`, series), /policy/);
  assert.throws(() => policyFingerprint(review.replace('  ].join("\\n");', '  ].join("\\n"); prompt += "changed";'), series), /policy/);
  assert.throws(() => policyFingerprint(review, `${series}\nreviewSeriesSchemaProperties.coverage.items.properties.extra = {};`), /policy/);
  const prefix = 'const policyPrefix = "prefix";\n';
  const built = prefix + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyPrefix + ');
  assert.notEqual(policyFingerprint(built, series), policyFingerprint(built.replace('"prefix"', '"changed"'), series));
  assert.throws(() => policyFingerprint(`${built}\npolicyPrefix += "changed";`, series), /policy/);
  const helper = 'function policyPrefix() { return "prefix"; }\n' + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyPrefix() + ');
  assert.notEqual(policyFingerprint(helper, series), policyFingerprint(helper.replace('return "prefix"', 'return "changed"'), series));
  assert.throws(() => policyFingerprint('import {policyPrefix} from "./unknown.mjs";\n' + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyPrefix + '), series), /policy/);
});

test("extractor changes rederive original Git policy instead of trusting older opaque digests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-policy-version-")); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "scripts")); const sources = await source();
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  for (const [index, name] of names.entries()) await writeFile(path.join(root, "scripts", name), sources[index]);
  await git("init", "-q"); await git("add", "scripts"); const tree = await git("write-tree");
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [`scripts/${name}`, await git("rev-parse", `${tree}:scripts/${name}`)])));
  const options = {root, directory: path.join(root, ".git/oracle"), candidate: {base: "base", tree, files: ["b.mjs"]}, files: {...files, "b.mjs": "b1"}, inputs: {authorities: [], owner: null, validation: [], proposal_sha256: null, tool_sha256: bindingHash(sources.map(contentHash)), tool_source_files: names, reviewer_policy_sha256: "older-opaque-algorithm", reviewer_policy_version: "older-extractor"}, environment: "env"};
  const response = {review_status: "COMPLETE", verdict: "APPROVED", coverage: [{path: "b.mjs", dependencies: ["b.mjs"], dependency_rationale: "Complete document closure.", assessment: "Read.", criteria: ["Synthetic document criteria."], evidence: ["Synthetic source inspection."], finding_ids: []}], findings: [], resolutions: [], validations: [], reused_validations: [], reused_coverage: [], synthesis: null, unreviewed: []};
  const initial = await prepareSeries(options); await saveRound(initial, response, assessRound(initial, response, []));
  const current = {...options, inputs: {...options.inputs, reviewer_policy_sha256: policyFingerprint(sources[1], sources[2]), reviewer_policy_version: await policyVersion()}};
  const next = await prepareSeries(current);
  assert.equal(next.public.reviewer_policy_equivalence.provenance, "verified-prior-git-blobs");
  assert.deepEqual(next.public.eligible_coverage.map((item) => item.path), ["b.mjs"]);
  assert.equal((await legacyPolicy({...initial.snapshot, tree: "missing-origin"}, root)).sha256, null);
});


test("canonical emission providers, aliases and dynamic builder boundaries cannot preserve stale policy", async () => {
  const [, review, series] = await source();
  for (const addition of [
    'JSON.stringify = () => "changed";',
    'Object.keys = () => [];',
    'const encoder = JSON; encoder.stringify = alternateEncoder;',
    'const encoder = [JSON][0]; encoder.stringify = alternateEncoder;',
    'let encoder; encoder = [JSON][0]; encoder.stringify = alternateEncoder;',
    'const carrier = {encoder: JSON}; carrier.encoder.stringify = alternateEncoder;',
    'let encoder; encoder = JSON; encoder.stringify = alternateEncoder;',
    'const {stringify: encoder} = JSON;',
    'const {JSON: encoder} = globalThis; encoder.stringify = alternateEncoder;',
    'execOracle = alternateLauncher;',
    'const launcher = execOracle; launcher.value = alternateLauncher;',
    'spawn.value = alternateLauncher;',
    'Ajv.prototype.validate = alternateValidator;',
    'process.env = alternateEnvironment;',
    'const runtime = process; runtime.env.EXTRA = "changed";',
    'path.join = alternatePath;',
    'const provider = path; provider.join = alternatePath;',
    'function unrelated(JSON) { return JSON; }',
    'class JSON { static stringify() { return "changed"; } }',
  ]) assert.throws(() => policyFingerprint(`${review}\n${addition}`, series), /policy|Reflective/);
  assert.throws(() => policyFingerprint(review.replace('"node:child_process"', '"./alternate-provider.mjs"'), series), /provider import/);
  assert.throws(() => policyFingerprint(review, `${series}\nJSON.stringify = alternateEncoder;`), /policy/);
  for (const invocation of ['mutate();', 'if (true) mutate();', 'if (false) mutate();', '']) {
    const built = 'const policyParts = []; function mutate() { policyParts.push("prefix"); }\n' + invocation + '\n' + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyParts.join("") + ');
    assert.throws(() => policyFingerprint(built, series), /policy/);
  }
  const closure = 'const policyPrefix = () => Math.random();\n' + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyPrefix() + ');
  assert.throws(() => policyFingerprint(closure, series), /policy/);
  assert.throws(() => policyFingerprint('const hiddenKind = "prefix"; const policyPrefix = eval("hiddenKind");\n' + review.replace('const trustedReviewerRole = ', 'const trustedReviewerRole = policyPrefix + '), series), /policy|Reflective/);
});

test("indirect providers and launcher transformations change verified historical policy and coverage", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-policy-emission-")); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "scripts")); const sources = await source();
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  for (const [index, name] of names.entries()) await writeFile(path.join(root, "scripts", name), sources[index]);
  await git("init", "-q"); await git("add", "scripts"); const tree = await git("write-tree");
  const files = Object.fromEntries(await Promise.all(names.map(async (name) => [`scripts/${name}`, await git("rev-parse", `${tree}:scripts/${name}`)])));
  const fingerprint = policyFingerprint(sources[1], sources[2]);
  const options = {root, directory: path.join(root, ".git/oracle"), candidate: {base: "base", tree, files: ["status.md"]}, files: {...files, "status.md": "same"}, inputs: {authorities: [], owner: null, validation: [], proposal_sha256: null, tool_sha256: bindingHash(sources.map(contentHash)), tool_source_files: names, reviewer_policy_sha256: fingerprint, reviewer_policy_version: await policyVersion()}, environment: "env"};
  const response = {review_status: "COMPLETE", verdict: "APPROVED", coverage: [{path: "status.md", dependencies: ["status.md"], dependency_rationale: "Complete synthetic closure.", assessment: "Read.", criteria: ["Synthetic document criteria."], evidence: ["Synthetic source inspection."], finding_ids: []}], findings: [], resolutions: [], validations: [], reused_validations: [], reused_coverage: [], synthesis: null, unreviewed: []};
  const initial = await prepareSeries(options); await saveRound(initial, response, assessRound(initial, response, []));
  const variants = [
    `${sources[1]}\nfunction stringify(value) { value.stringify = () => "changed"; } stringify(JSON);`,
    `${sources[1]}\nfunction keys(value) { value.stringify = () => "changed"; } keys(JSON);`,
    `${sources[1]}\nconst encoder = ((value) => value)(JSON); encoder.stringify = () => "changed";`,
    `${sources[1]}\n((value) => { value.stringify = () => "changed"; })(JSON);`,
    `import * as runtime from "node:process"; runtime.env.CODEX_SELECTED_MODEL = "changed";\n${sources[1]}`,
    `import provider from "./synthetic-provider.mjs"; provider.install("changed");\n${sources[1]}`,
    sources[1].replace(/function execOracle\(([^)]*)\) \{/, 'function execOracle($1) { args.push("-c", "developer_instructions=changed");'),
    sources[1].replace(/function execOracle\(([^)]*)\) \{/, 'function execOracle($1) { args.splice(args.indexOf("--sandbox"), 2);'),
  ];
  for (const review of variants) {
    assert.notEqual(review, sources[1], "Every synthetic policy mutation must actually alter the current launcher");
    let changed; try { changed = policyFingerprint(review, sources[2]); } catch { changed = null; }
    assert.notEqual(changed, fingerprint);
    await writeFile(path.join(root, "scripts/oracle-review.mjs"), review);
    await git("add", "scripts"); const changedTree = await git("write-tree");
    const nextFiles = {...files, "scripts/oracle-review.mjs": await git("rev-parse", `${changedTree}:scripts/oracle-review.mjs`)};
    const original = await legacyPolicy({...initial.snapshot, tree: changedTree, files: {...nextFiles, "status.md": "same"}, tool_binding_sha256: bindingHash(sources.map((value, index) => contentHash(index === 1 ? review : value)))}, root);
    assert.notEqual(original.sha256, fingerprint);
    const next = await prepareSeries({...options, candidate: {...options.candidate, tree: changedTree}, files: {...nextFiles, "status.md": "same"}, inputs: {...options.inputs, reviewer_policy_sha256: changed, tool_sha256: bindingHash(sources.map((value, index) => contentHash(index === 1 ? review : value)))}});
    assert.deepEqual(next.public.eligible_coverage, []);
  }
  for (const name of names) {
    const changedImplementation = {...implementation, [name]: `${implementation[name]}\n// Changed declared local module implementation custody.\n`};
    const changed = implementationFingerprint(changedImplementation["oracle-review.mjs"], changedImplementation["oracle-series.mjs"], changedImplementation);
    assert.notEqual(changed, fingerprint);
    const next = await prepareSeries({...options, inputs: {...options.inputs, reviewer_policy_sha256: changed}});
    assert.deepEqual(next.public.eligible_coverage, []);
  }
  const mutated = {...implementation, "oracle-inputs.mjs": `${implementation["oracle-inputs.mjs"]}\nconst originalEncoder = JSON.stringify; JSON.stringify = (value, ...args) => originalEncoder(typeof value === "string" ? value.replace("trusted reviewer", "changed reviewer") : value, ...args);`};
  assert.notEqual(implementationFingerprint(sources[1], sources[2], mutated), fingerprint);
  assert.throws(() => implementationFingerprint(sources[1], sources[2]), /implementation closure/);
  const missing = {...implementation}; delete missing["codex-child-model.mjs"];
  assert.throws(() => implementationFingerprint(sources[1], sources[2], missing), /implementation closure/);
});
