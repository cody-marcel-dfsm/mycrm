import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import test from "node:test";

const execute = promisify(execFile), launcher = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url));
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "my-crm-command-coverage-")));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, "Vault/docs"), {recursive: true}); await mkdir(path.join(root, ".agents/skills/oracle"), {recursive: true});
  await writeFile(path.join(root, "Vault/docs/CONSTITUTION.md"), "Synthetic constitution.\n");
  await writeFile(path.join(root, ".agents/skills/oracle/SKILL.md"), "Synthetic isolated reviewer fixture.\n");
  await writeFile(path.join(root, "AGENTS.md"), "Synthetic command policy.\n");
  await writeFile(path.join(root, "candidate.txt"), "synthetic input\n"); await writeFile(path.join(root, ".gitignore"), "Vault/\n");
  const git = async (...args) => (await execute("git", args, {cwd: root})).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.name", "Synthetic Maintainer"); await git("config", "user.email", "synthetic@example.invalid"); await git("add", "."); await git("commit", "-m", "Synthetic source");
  const counter = path.join(root, ".git", "actual-command-runs");
  const code = "const fs=require('node:fs');const name=process.argv[1];const old=fs.existsSync(name)?Number(fs.readFileSync(name)):0;fs.writeFileSync(name,String(old+1));console.log('synthetic passing execution');";
  const env = {...process.env, CODEX_THREAD_ID: "", CODEX_SELECTED_MODEL: "synthetic-test-model", CODEX_SELECTED_REASONING_EFFORT: "high"};
  const run = extra => execute(process.execPath, [launcher, "validate", "--input", "candidate.txt", "--", process.execPath, "-e", code, counter], {cwd: root, env: {...env, ...extra}});
  return {root, git, counter, run};
}

test("unchanged required validation accepts its original execution and records actual changelist hashes", async t => {
  const f = await fixture(t), first = await f.run(), second = await f.run();
  assert.match(second.stdout, /ORACLE_VALIDATION_REUSED=true/);
  assert.equal(await readFile(f.counter, "utf8"), "1");
  const evidence = output => output.match(/ORACLE_VALIDATION_EVIDENCE=(.+)/)[1];
  assert.equal(evidence(first.stdout), evidence(second.stdout), "Reuse rewrote an earlier log as a new execution");
  const coverage = JSON.parse(await readFile(second.stdout.match(/ORACLE_COMMAND_COVERAGE=@(.+)/)[1]));
  assert.equal(coverage.disposition, "REUSED"); assert.equal(coverage.source_commit, await f.git("rev-parse", "HEAD"));
  assert.equal(coverage.changelists[0].tree_sha, await f.git("rev-parse", "HEAD^{tree}"));
  assert.match(coverage.input_sha256, /^[a-f0-9]{64}$/); assert.match(coverage.output_sha256, /^[a-f0-9]{64}$/);
});

test("changed consumed input, environment and altered original output execute only the invalidated command", async t => {
  const f = await fixture(t); await f.run();
  await writeFile(path.join(f.root, "candidate.txt"), "synthetic changed input\n"); await f.git("add", "."); await f.git("commit", "-m", "Synthetic changed changelist");
  const changed = await f.run(); assert.doesNotMatch(changed.stdout, /ORACLE_VALIDATION_REUSED=true/); assert.match(changed.stdout, /Consumed input changes/);
  assert.equal(await readFile(f.counter, "utf8"), "2");
  const environment = await f.run({SYNTHETIC_CHECK_ENVIRONMENT: "changed"}); assert.match(environment.stdout, /environment changed/); assert.equal(await readFile(f.counter, "utf8"), "3");
  const original = JSON.parse(await readFile(changed.stdout.match(/ORACLE_VALIDATION_EVIDENCE=@(.+)/)[1])); await writeFile(original.output_file, "synthetic altered original output\n");
  const altered = await f.run(); assert.match(altered.stdout, /output is missing or changed/); assert.equal(await readFile(f.counter, "utf8"), "4");
  assert.ok((await readdir(path.join(f.root, ".git/oracle/command-tracking"))).length >= 4);
});
