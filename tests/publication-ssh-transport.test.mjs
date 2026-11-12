import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";
import test from "node:test";
import * as transport from "../scripts/validation-transport.mjs";
import {preparePublication, publishPrepared} from "../scripts/publication-checkpoint.mjs";
import {validateRelease} from "../scripts/release-validation.mjs";

// Publication over SSH Git: the maintainer host has no authenticated `gh` CLI.
// A local bare repository stands in for the SSH remote; a `gh` trap on PATH and
// a read-only API double prove no authenticated GitHub call is attempted.
const execute = promisify(execFile), zeros = "0".repeat(40), repository = "synthetic-owner/synthetic-repository";
const hash = value => createHash("sha256").update(value).digest("hex");
const evidenceRef = source => `refs/my-crm/native-validation/${source}`;
const checks = () => transport.requiredCommands.map(command => ({command, coverage: "EXACT_INPUT_EXECUTION", executions: [{record_sha256: "c".repeat(64), command_sha256: hash(JSON.stringify(command)),
  input_sha256: "d".repeat(64), executable_sha256: "e".repeat(64), environment_sha256: "f".repeat(64), output_sha256: "1".repeat(64), original_environment: {node: "v22.11.0", platform: "linux", architecture: "x64"}}]}));

async function fixture(t) {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-ssh-publication-")));
  const trap = path.join(parent, "trap"), invoked = path.join(trap, "gh-invoked"), originalPath = process.env.PATH;
  await mkdir(trap);
  await writeFile(path.join(trap, "gh"), `#!/bin/sh\necho invoked > ${JSON.stringify(invoked)}\nexit 79\n`, {mode: 0o755});
  process.env.PATH = `${trap}${path.delimiter}${originalPath}`;
  t.after(async () => {process.env.PATH = originalPath; await rm(parent, {recursive: true, force: true});});
  const root = path.join(parent, "repo"), remote = path.join(parent, "remote.git"), clone = path.join(parent, "clone");
  await execute("git", ["init", "--bare", "-b", "main", remote]); await execute("git", ["clone", remote, root]);
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  const bare = async (...args) => (await execute("git", args, {cwd: remote})).stdout.trim();
  await git("checkout", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid");
  await writeFile(path.join(root, "source.txt"), "synthetic published base\n"); await git("add", "."); await git("commit", "-m", "Synthetic base"); await git("push", "origin", "main");
  const before = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "synthetic intermediate\n"); await git("add", "."); await git("commit", "-m", "Synthetic intermediate");
  const middle = await git("rev-parse", "HEAD");
  await writeFile(path.join(root, "source.txt"), "synthetic validated source\n"); await git("add", "."); await git("commit", "-m", "Synthetic candidate");
  const source = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
  const calls = [];
  // Unauthenticated public reads only: repository metadata and Actions state.
  const state = {runs: [], jobs: []};
  const api = async (method, endpoint, body) => {
    calls.push({method, endpoint});
    if (method !== "GET") {
      // The production reader refuses writes before any network access.
      if (typeof transport.publicGithubRequest !== "function") assert.fail(`Authenticated GitHub write attempted: ${method} ${endpoint}`);
      return transport.publicGithubRequest(method, endpoint, body);
    }
    assert.equal(body, undefined, "Public read carried a request body");
    if (endpoint === `repos/${repository}`) return {full_name: repository, owner: {id: 17}};
    if (endpoint === `repos/${repository}/actions/workflows/ci.yml`) return {id: 7, path: ".github/workflows/ci.yml", state: "active"};
    if (endpoint.startsWith(`repos/${repository}/actions/workflows/7/runs?`)) return {total_count: state.runs.length, workflow_runs: state.runs};
    if (endpoint.startsWith(`repos/${repository}/actions/runs/11/jobs?`)) return {total_count: state.jobs.length, jobs: state.jobs};
    assert.fail(`GitHub REST used where Git is required: ${method} ${endpoint}`);
  };
  const ghInvoked = async () => {try {await readFile(invoked); return true;} catch {return false;}};
  return {parent, root, remote, clone, git, bare, before, middle, source, tree, api, calls, state, ghInvoked};
}
const exportEvidence = f => transport.exportNativeValidation({root: f.root, repository, sourceCommit: f.source, sourceTree: f.tree,
  admission: {technical_receipt_sha256: "9".repeat(64)}, remote: "origin", api: f.api, collect: async () => checks()});

test("export pushes a reproducible git-native evidence commit over the remote with no authenticated CLI", async t => {
  const f = await fixture(t);
  const result = await exportEvidence(f);
  const advertised = await f.bare("for-each-ref", "--format=%(objectname)", evidenceRef(f.source));
  assert.ok(/^[a-f0-9]{40}$/.test(advertised), "Evidence ref was not pushed to the remote");
  assert.equal(result.evidence_ref, evidenceRef(f.source)); assert.equal(result.evidence_commit, advertised);
  assert.equal(await f.bare("rev-parse", `${advertised}^@`), f.source, "Evidence commit must have exactly the source parent");
  const entries = (await f.bare("ls-tree", advertised)).split("\n");
  assert.equal(entries.length, 1); assert.match(entries[0], /^100644 blob [a-f0-9]{40}\tvalidation\.json$/);
  const bytes = (await execute("git", ["cat-file", "blob", `${advertised}:validation.json`], {cwd: f.remote, encoding: "buffer"})).stdout;
  assert.match(await f.bare("log", "-1", "--format=%B", advertised), new RegExp(`sha256:${hash(bytes)}`));
  assert.equal(JSON.parse(bytes).source_tree, f.tree);
  assert.equal(await f.bare("for-each-ref", "refs/heads/codex"), "", "Export created a side branch");
  // Reproducible: an identical second export observes the same object.
  assert.equal((await exportEvidence(f)).evidence_commit, advertised);
  assert.ok(f.calls.every(item => item.method === "GET"), "Export attempted a GitHub write");
  assert.equal(await f.ghInvoked(), false, "gh CLI was invoked");
});

test("a fresh clone imports exact evidence through git only and tampered evidence executes every command", async t => {
  const f = await fixture(t);
  await exportEvidence(f);
  await execute("git", ["clone", f.remote, f.clone]);
  const refuseApi = async (method, endpoint) => assert.fail(`Import used GitHub REST: ${method} ${endpoint}`);
  const imported = () => transport.importNativeValidation({root: f.clone, repository, sourceCommit: f.source, sourceTree: f.tree, remote: "origin", ownerId: "17", api: refuseApi});
  const prior = await imported();
  assert.deepEqual(prior.invalidated, []); assert.equal(prior.covered.length, transport.requiredCommands.length);
  const executed = [];
  await validateRelease({nativeEvidence: false, priorCoverage: prior, execute: async args => executed.push(args)});
  assert.deepEqual(executed, []);
  assert.equal((await transport.importNativeValidation({root: f.clone, repository, sourceCommit: f.source, sourceTree: "4".repeat(40), remote: "origin", ownerId: "17", api: refuseApi})).covered.length, 0);
  assert.equal((await transport.importNativeValidation({root: f.clone, repository, sourceCommit: f.source, sourceTree: f.tree, remote: "origin", ownerId: "18", api: refuseApi})).covered.length, 0, "Different owner issuer accepted");
  const original = await f.bare("rev-parse", evidenceRef(f.source));
  const envelope = (await execute("git", ["cat-file", "blob", `${original}:validation.json`], {cwd: f.remote, encoding: "buffer"})).stdout;
  // Forged objects reuse the fixed evidence identity unless told otherwise, so
  // each case isolates one integrity check.
  const forge = async (bytes, {parents = [f.source], name = "validation.json", fixed = true} = {}) => {
    const file = path.join(f.parent, "forged"); await writeFile(file, bytes);
    const blob = await f.git("hash-object", "-w", file);
    await writeFile(file, `100644 blob ${blob}\t${name}\n`);
    const tree = (await execute("sh", ["-c", "git mktree < \"$1\"", "sh", file], {cwd: f.root})).stdout.trim();
    const env = fixed ? {...process.env, ...transport.evidenceEnvironment} : process.env;
    return (await execute("git", ["-c", "commit.gpgSign=false", "commit-tree", tree, ...parents.flatMap(item => ["-p", item]), "-m", `Native command coverage for ${f.source}`, "-m", `sha256:${hash(bytes)}`], {cwd: f.root, env})).stdout.trim();
  };
  const altered = JSON.parse(envelope); altered.contract_sha256 = "2".repeat(64);
  const cases = {
    "altered envelope": await forge(Buffer.from(`${JSON.stringify(altered)}\n`)),
    "non-reproducible metadata": await forge(envelope, {fixed: false}),
    "redirected parent": await forge(envelope, {parents: [f.before]}),
    "second parent": await forge(envelope, {parents: [f.source, f.before]}),
    "renamed entry": await forge(envelope, {name: "other.json"}),
    "oversized envelope": await forge(Buffer.alloc(1024 * 1024 + 1, 32)),
    "source commit itself": f.source
  };
  for (const [name, commit] of Object.entries(cases)) {
    await f.git("push", "--force", "origin", `${commit}:${evidenceRef(f.source)}`);
    const result = await imported();
    assert.deepEqual(result.covered, [], name); assert.equal(result.invalidated.length, 1, name);
  }
  await f.git("push", "origin", `:${evidenceRef(f.source)}`);
  const missing = await imported(); assert.deepEqual(missing.covered, []); assert.equal(missing.invalidated.length, 1);
  const executedAll = [];
  await validateRelease({nativeEvidence: false, priorCoverage: missing, execute: async args => executedAll.push(args)});
  assert.deepEqual(executedAll, transport.requiredCommands);
  assert.equal(await f.ghInvoked(), false, "gh CLI was invoked");
});

test("public reads are GET-only HTTPS without credentials and bounded", async () => {
  assert.equal(typeof transport.publicGithubRequest, "function", "Unauthenticated public GitHub reader is missing");
  const requests = [];
  const reply = (status, text, headers = {}) => async (url, options) => {requests.push({url: String(url), options}); return new Response(text, {status, headers});};
  assert.deepEqual(await transport.publicGithubRequest("GET", `repos/${repository}`, undefined, {fetch: reply(200, JSON.stringify({owner: {id: 17}}))}), {owner: {id: 17}});
  assert.equal(requests[0].url, `https://api.github.com/repos/${repository}`);
  assert.equal(requests[0].options.method, "GET"); assert.equal(requests[0].options.credentials, "omit"); assert.equal(requests[0].options.redirect, "error");
  assert.ok(requests[0].options.signal, "Public read has no bounded duration");
  assert.ok(!Object.keys(requests[0].options.headers).some(name => /authorization|cookie/i.test(name)), "Public read attached credentials");
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) await assert.rejects(transport.publicGithubRequest(method, `repos/${repository}/statuses/${"a".repeat(40)}`, {}, {fetch: reply(200, "{}")}), /read-only/);
  await assert.rejects(transport.publicGithubRequest("GET", "https://example.invalid/repos/x", undefined, {fetch: reply(200, "{}")}), /api\.github\.com/);
  await assert.rejects(transport.publicGithubRequest("GET", `repos/${repository}`, undefined, {fetch: reply(404, "{}")}), error => error.status === 404);
  await assert.rejects(transport.publicGithubRequest("GET", `repos/${repository}`, undefined, {fetch: reply(200, "not json")}), /malformed/);
  await assert.rejects(transport.publicGithubRequest("GET", `repos/${repository}`, undefined, {fetch: reply(200, "x".repeat(4 * 1024 * 1024 + 1))}), /bounded|size/);
  assert.equal(requests.length, 4, "Rejected methods or destinations reached the network");
});

test("required CI admission discovers and creates the watched ref through git with an absent-ref lease", async t => {
  const f = await fixture(t), branch = `codex/validation-ready-${f.source}`;
  await exportEvidence(f);
  const admit = options => transport.admitRequiredCI({root: f.root, repository, sourceCommit: f.source, sourceTree: f.tree, remote: "origin", api: f.api, ...options});
  const missing = await admit();
  assert.equal(missing.status, "MISSING");
  assert.equal(await f.bare("rev-parse", `refs/heads/${branch}`), f.source, "Watched ref was not created over git");
  assert.ok(!f.calls.some(item => item.endpoint.includes("/git/")), "Ref discovery used REST");
  f.state.runs = [{id: 11, workflow_id: 7, path: ".github/workflows/ci.yml", head_sha: f.source, head_branch: branch, event: "push", run_attempt: 1, status: "completed", conclusion: "failure", repository: {full_name: repository}, head_repository: {full_name: repository}}];
  const failed = await admit(); assert.equal(failed.status, "FAILED");
  const retry = await admit({retryFailed: {run_id: 11, run_attempt: 1, reason: "Synthetic recovered external input"}});
  assert.equal(retry.status, "FAILED", "Unavailable authenticated rerun must not report a pending retry");
  assert.match(retry.reason, /actions\/runs\/11/); assert.equal(retry.prior_failed_runs[0].reason, "failure");
  // A conflicting watched ref is refused rather than replaced.
  const g = await fixture(t), other = `codex/validation-ready-${g.source}`;
  await g.git("push", "origin", `${g.before}:refs/heads/${other}`);
  await assert.rejects(transport.admitRequiredCI({root: g.root, repository, sourceCommit: g.source, sourceTree: g.tree, remote: "origin", api: g.api}), /differs/);
  assert.equal(await g.bare("rev-parse", `refs/heads/${other}`), g.before);
  assert.equal(await f.ghInvoked(), false, "gh CLI was invoked");
});

test("publication pushes with an expected-old-value lease and refuses a remote that moved after preparation", async t => {
  const f = await fixture(t);
  const admit = async () => ({status: "ADMITTED", source_commit: f.source, target_tree: f.tree, technical_receipt_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), protected_effects: []});
  const prepared = await preparePublication({root: f.root, remoteBefore: f.before, admit});
  // A concurrent fast-forward that an ordinary push would silently build on.
  await f.git("push", "origin", `${f.middle}:refs/heads/main`);
  await assert.rejects(publishPrepared(prepared.prepared_record, {root: f.root}), /push failed/i);
  assert.equal(await f.bare("rev-parse", "refs/heads/main"), f.middle, "Moved remote was overwritten");
  const calls = [];
  await publishPrepared(prepared.prepared_record, {root: f.root, run: async args => calls.push(args)});
  assert.deepEqual(calls, [["push", `--force-with-lease=refs/heads/main:${f.before}`, "origin", `${f.source}:refs/heads/main`]]);
  await f.git("push", "--force", "origin", `${f.before}:refs/heads/main`);
  await publishPrepared(prepared.prepared_record, {root: f.root});
  assert.equal(await f.bare("rev-parse", "refs/heads/main"), f.source);
  // An absent destination uses the empty expectation.
  const g = await fixture(t);
  await g.git("push", "origin", ":refs/heads/main");
  const admitG = async () => ({status: "ADMITTED", source_commit: g.source, target_tree: g.tree, technical_receipt_sha256: "a".repeat(64), plan_sha256: "b".repeat(64), protected_effects: []});
  const absent = await preparePublication({root: g.root, remoteBefore: zeros, admit: admitG}), absentCalls = [];
  await publishPrepared(absent.prepared_record, {root: g.root, run: async args => absentCalls.push(args)});
  assert.deepEqual(absentCalls, [["push", "--force-with-lease=refs/heads/main:", "origin", `${g.source}:refs/heads/main`]]);
  assert.equal(await f.ghInvoked(), false, "gh CLI was invoked");
});
