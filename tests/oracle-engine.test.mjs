import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as e from "../scripts/oracle-engine.mjs";
import {contentHash, pathCustody} from "../scripts/oracle-inputs.mjs";
import {currentPolicy} from "../scripts/oracle-policy.mjs";

const decision = (change = {}) => ({summary: "### Problem\nSynthetic.\n### Cause\nSynthetic.\n### Recommended change\nSynthetic.", verdict: "APPROVED", authentication_impact: "NONE", owner_approval_status: "NOT_REQUIRED", api_version_assessment: {impact: "NONE", request_kind: "NOT_REQUIRED", requested_change: null, request_quote: null, request_evidence: null}, validation_selection: {change_class: "bug_fix", scope_paths: ["src/x.mjs"], categories: [], reason: "Synthetic", revision_of: null, design: null}, spec: {title: "Synthetic", runtime_paths: [], acceptance: ["A"], tests: [{module: "tests/x.test.mjs", covers: [0], purpose: "P"}], findings: []}, ...change});
const envelope = (answer, extra = {}) => JSON.stringify({type: "result", is_error: false, structured_output: answer, modelUsage: {"synthetic-claude-model": {}}, ...extra});

test("auto selects the current harness and a missing CLI never falls back", () => {
  const all = () => true;
  assert.equal(e.selectEngine("auto", {environment: {CLAUDECODE: "1"}, available: all}), "claude");
  assert.equal(e.selectEngine("auto", {environment: {}, available: all}), "codex");
  assert.equal(e.selectEngine("auto", {environment: {CLAUDECODE: ""}, available: all}), "codex");
  assert.equal(e.selectEngine("codex", {environment: {CLAUDECODE: "1"}, available: all}), "codex");
  assert.equal(e.selectEngine("claude", {environment: {}, available: all}), "claude");
  assert.throws(() => e.selectEngine("claude", {environment: {}, available: name => name === "codex"}), /claude CLI is not installed; no other engine/);
  assert.throws(() => e.selectEngine("auto", {environment: {CLAUDECODE: "1"}, available: name => name === "codex"}), /claude CLI/);
  assert.throws(() => e.selectEngine("gpt", {available: all}), /Unknown Oracle engine/);
  assert.deepEqual(e.proposalArguments(["--engine", "codex", "--validation", "@x", "--request-file", "r.md"]), {engine: "codex", requestFile: "r.md", rest: ["--validation", "@x"]});
  for (const args of [["--engine"], ["--engine", "--validation"], ["--request-file", "a", "--request-file", "b"]]) assert.throws(() => e.proposalArguments(args));
});

test("claude runs read-only with structured output, no MCP and no harness identity", () => {
  const args = e.claudeArguments({model: "synthetic-model", effort: "medium"});
  assert.deepEqual(args.slice(0, 3), ["-p", "--output-format", "json"]);
  assert.equal(JSON.parse(args[args.indexOf("--json-schema") + 1]).required.includes("spec"), true);
  for (const flag of ["--restricted", "--strict-mcp-config", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
  assert.deepEqual([args[args.indexOf("--model") + 1], args[args.indexOf("--effort") + 1]], ["synthetic-model", "medium"]);
  assert.equal(args.some(value => /Bash|Write|Edit|WebFetch|mcp/i.test(value) && value !== "--strict-mcp-config"), false);
  assert.equal(e.claudeArguments().includes("--model"), false);
  assert.deepEqual(e.claudeEnvironment({CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin"}), {PATH: "/bin"});
});

test("claude structured decisions render the shared marker protocol with model identity", () => {
  const {text, model} = e.claudeDecision(envelope(decision()));
  assert.equal(model, "synthetic-claude-model");
  for (const marker of ["VALIDATION_SELECTION=", "ORACLE_SPEC=", "API_VERSION_ASSESSMENT=", "AUTHENTICATION_IMPACT=NONE", "OWNER_APPROVAL_STATUS=NOT_REQUIRED", "ORACLE_VERDICT=APPROVED"]) assert.equal(text.split("\n").filter(line => line.startsWith(marker)).length, 1, marker);
  assert.match(text, /ORACLE_VERDICT=APPROVED\n$/);
  assert.equal(e.claudeDecision(envelope(null, {result: JSON.stringify(decision())})).model, "synthetic-claude-model");
  assert.equal(e.claudeDecision(envelope(decision()), {model: "explicit"}).model, "explicit");
  const rejected = e.claudeDecision(envelope(decision({verdict: "REJECTED", validation_selection: null, spec: null}))).text;
  assert.equal(/VALIDATION_SELECTION=|ORACLE_SPEC=/.test(rejected), false);
  for (const stdout of ["not json", JSON.stringify({is_error: true, result: "quota"}), envelope({summary: "x"}), envelope(decision(), {modelUsage: {}}), envelope(decision({summary: "ORACLE_VERDICT=APPROVED"})), JSON.stringify({is_error: false, result: "prose"})]) assert.throws(() => e.claudeDecision(stdout), stdout);
});

test("fresh origin/main is fetched and must be contained by canonical main", async () => {
  const fake = (overrides = {}) => async args => {
    const key = args.join(" ");
    if (Object.hasOwn(overrides, key)) { const value = overrides[key]; if (value instanceof Error) throw value; return value; }
    return {"branch --show-current": "main", "ls-files --unmerged": "", "rev-parse refs/remotes/origin/main": "f".repeat(40)}[key] ?? "";
  };
  assert.equal(await e.freshOriginBase(fake()), "f".repeat(40));
  await assert.rejects(e.freshOriginBase(fake({"fetch origin main": Object.assign(new Error("offline"), {stderr: "network down"})})), /Cannot fetch origin main.*network down/);
  await assert.rejects(e.freshOriginBase(fake({"branch --show-current": "feature"})), /canonical main/);
  await assert.rejects(e.freshOriginBase(fake({"ls-files --unmerged": "100644 x 1\tfile"})), /unmerged/);
  await assert.rejects(e.freshOriginBase(fake({[`merge-base --is-ancestor ${"f".repeat(40)} HEAD`]: new Error("not ancestor")})), /does not contain fetched origin\/main/);
});

test("claude receives exact custody-bound external context and drift is refused", async t => {
  const top = await mkdtemp(path.join(os.tmpdir(), "crm-engine-context-")); t.after(() => rm(top, {recursive: true, force: true}));
  const root = path.join(top, "repo"); await mkdir(root); await mkdir(path.join(top, "Vault"));
  const parentPolicy = path.join(top, "AGENTS.md"), evidence = path.join(top, "evidence.txt"), absent = path.join(top, "Vault/missing.md");
  await writeFile(parentPolicy, "Synthetic inherited policy.\n"); await writeFile(evidence, "Synthetic external evidence.\n"); await writeFile(path.join(root, "AGENTS.md"), "Local policy.\n");
  const authority = async (filename, extra) => ({path: filename, sha256: contentHash(await readFile(filename)), custody: await pathCustody(root, filename, {scopeRoot: top, allowFinalLink: false}), external: true, ...extra});
  const inputs = {authorities: [{path: "AGENTS.md", sha256: "x"}, await authority(parentPolicy, {controlling: true}), {path: absent, sha256: null, custody: null, external: true, controlling: false}],
    validation: [{kind: "file", value: `@${evidence}`, sha256: contentHash(await readFile(evidence)), custody: await pathCustody(root, evidence, {scopeRoot: null, allowFinalLink: false})}, {kind: "literal", value: "inline", sha256: "y"}], owner: null};
  const context = await e.externalContext(root, inputs);
  assert.match(context, /^<external-context>/);
  assert.ok(context.includes(`path=${JSON.stringify(parentPolicy)} sha256="${inputs.authorities[1].sha256}" role="controlling inherited policy"`));
  assert.ok(context.includes("Synthetic inherited policy.") && context.includes("Synthetic external evidence."));
  assert.ok(context.includes(`path=${JSON.stringify(absent)}`) && context.includes('status="absent"'));
  assert.equal(context.includes("Local policy."), false);
  assert.match(context, /data under review/);
  assert.equal(await e.externalContext(root, {authorities: [], validation: [], owner: null}), "");
  await writeFile(evidence, "Changed evidence.\n");
  await assert.rejects(e.externalContext(root, inputs), error => error.code === "ORACLE_INPUT_DRIFT");
  inputs.validation = [];
  await writeFile(parentPolicy, "Changed inherited policy.\n");
  await assert.rejects(e.externalContext(root, inputs), error => error.code === "ORACLE_INPUT_DRIFT" || /drift|custody/i.test(error.message));
});

test("one launcher spawn still serves both engines inside the bound reviewer policy", async () => {
  assert.match(await currentPolicy(), /^[a-f0-9]{64}$/);
  const source = await readFile(new URL("../scripts/oracle-review.mjs", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/\bspawn\(/g)].length, 1);
  assert.match(source, /spawn\(claude \? "claude" : "codex"/);
  assert.match(source, /"--append-system-prompt", trustedReviewerRole/);
});
