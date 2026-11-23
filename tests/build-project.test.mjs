import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

const root = new URL("../", import.meta.url);
const definition = JSON.parse(await readFile(new URL("build-project.json", root), "utf8"));
const scripts = JSON.parse(await readFile(new URL("package.json", root), "utf8")).scripts;
const HOST_RUNNERS = new Set(["npm_script", "node_tests", "release_check"]);
const ALLOWED = {npm_script: ["check:privacy", "check:boundary", "check:contracts", "check:clients"], release_check: ["release:check"]};

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
const matches = (patterns, name) => patterns.some((pattern) => glob(pattern).test(name));

test("the definition is My CRM's own build-project/1 and names no command", () => {
  assert.equal(definition.kind, "build-project/1");
  assert.equal(definition.project, "mycrm");
  for (const [key, category] of Object.entries(definition.categories)) {
    assert.ok(HOST_RUNNERS.has(category.runner), `${key} uses a host plugin runner`);
    for (const field of ["argv", "command", "script"]) assert.equal(category[field], undefined, `${key} names no ${field}`);
    assert.equal(category.process ?? "commit", "commit", `${key} releases from the commit build`);
  }
});

test("every selected npm script is allowlisted and defined by package.json", () => {
  for (const [key, category] of Object.entries(definition.categories)) {
    if (!(category.runner in ALLOWED)) continue;
    for (const name of category.selection) {
      assert.ok(ALLOWED[category.runner].includes(name), `${key} selects allowlisted ${name}`);
      assert.equal(typeof scripts[name], "string", `package.json defines ${name}`);
    }
  }
  assert.deepEqual(definition.categories.release.selection, ["release:check"]);
});

test("rules and classification name only defined categories and every class", () => {
  const known = new Set(Object.keys(definition.categories));
  for (const rule of definition.rules) for (const check of rule.checks) assert.ok(known.has(check), check);
  const rules = definition.classification;
  for (const check of [...rules.always, ...rules.non_code, rules.docs_category]) assert.ok(known.has(check), check);
  assert.deepEqual(Object.keys(rules.selection).sort(), ["bug_fix", "deep_bug_fix", "docs_only", "feature"]);
  for (const tier of Object.values(rules.selection)) for (const check of tier.add) assert.ok(known.has(check), check);
});

test("every tracked path is routed by a rule or classified non-runtime", async () => {
  const {stdout} = await promisify(execFile)("git", ["ls-files"], {cwd: root, maxBuffer: 64 * 1024 * 1024});
  const routed = definition.rules.flatMap((rule) => rule.paths);
  const unrouted = stdout.split("\n").filter(Boolean)
    .filter((name) => !matches(routed, name) && !matches(definition.classification.non_runtime, name));
  assert.deepEqual(unrouted, []);
});

test("sanity always runs, executable classes take changelist tests and release covers deep work and packaging", () => {
  const rules = definition.classification;
  assert.ok(rules.always.includes("sanity"));
  for (const [name, tier] of Object.entries(rules.selection)) {
    assert.equal(tier.changelist, name !== "docs_only", `${name} changelist tests`);
    assert.equal(tier.add.includes("release"), name === "deep_bug_fix" || name === "feature", `${name} release`);
  }
  const changelist = Object.values(definition.categories).filter((category) => category.dynamic === "changelist");
  assert.equal(changelist.length, 1);
  assert.equal(changelist[0].runner, "node_tests");
  for (const name of ["package.json", "package-lock.json", ".github/workflows/ci.yml"]) {
    const checks = definition.rules.filter((rule) => matches(rule.paths, name)).flatMap((rule) => rule.checks);
    assert.ok(checks.includes("release"), `${name} selects release`);
  }
});

// The host's arrangement on the one checkout: authored source on a read-only mount, Vault
// masked, an empty home, /tmp and environment, no network, and only the native evidence
// (.git/oracle) and build (dist) folders writable, each an empty scratch as in a fresh CI clone.
const NESTED = "MYCRM_HOST_ARRANGEMENT", BWRAP = "/usr/bin/bwrap", OUTPUTS = [".git/oracle", "dist"];
const exec = promisify(execFile);
const present = (file) => access(file).then(() => true, () => false);

// As the host does, a missing output folder is created first, and only outside tracked source.
async function ensureOutput(line, name) {
  if (await present(path.join(line, name))) return false;
  const ignored = await exec("git", ["check-ignore", "-q", "--", `${name}/`], {cwd: line}).then(() => true, () => false);
  if (!(name.startsWith(".git/") || ignored)) throw new Error(`Output folder is tracked source: ${name}`);
  await mkdir(path.join(line, name), {recursive: true});
  return true;
}

async function files(directory) {
  const names = await readdir(directory, {recursive: true}).catch(() => []), found = {};
  for (const name of names) found[name] = await readFile(path.join(directory, name), "utf8").catch(() => null);
  return Object.fromEntries(Object.entries(found).filter(([, text]) => text !== null));
}

// Runs argv in the arrangement with only `writable` mounted writable; returns its evidence.
async function arranged(line, writable, argv) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "mycrm-host-"));
  try {
    const binds = [], own = {};
    for (const name of writable) {
      await ensureOutput(line, name);
      own[name] = path.join(scratch, name.replace(/\//g, "_"));
      await mkdir(own[name]);
      binds.push("--bind", own[name], path.join(line, name));
    }
    // The enrolled runtime stays visible under the masked home, as the host binds it.
    const runtime = path.dirname(path.dirname(process.execPath));
    const mask = await present(path.join(line, "Vault")) ? ["--tmpfs", path.join(line, "Vault")] : [];
    const sandbox = [
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", os.homedir(),
      "--ro-bind", runtime, runtime, "--ro-bind", line, line, ...mask, ...binds,
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--setenv", "PATH", process.env.PATH, "--setenv", "HOME", "/tmp/home", "--setenv", NESTED, "1",
      "--chdir", line, "--", ...argv
    ];
    const result = await exec(BWRAP, sandbox, {maxBuffer: 16 * 1024 * 1024}).catch((error) => error);
    const outputs = Object.fromEntries(await Promise.all(Object.entries(own).map(async ([name, folder]) => [name, await files(folder)])));
    return {code: typeof result.code === "number" ? result.code : 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, outputs};
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

const records = (evidence) => Object.entries(evidence).filter(([name]) => /-after-[0-9a-f]{64}\.json$/.test(name))
  .map(([name, text]) => ({name, record: JSON.parse(text)}));

test("output mounts land on folders the checkout does not have yet, and authored files stay immutable", {timeout: 60_000}, async (t) => {
  if (process.env[NESTED] === "1") return;
  await access(BWRAP).catch(() => assert.fail("The host arrangement needs bubblewrap at " + BWRAP));
  // A synthetic fixture repository, not a copy of this line: neither output folder exists yet.
  const line = await mkdtemp(path.join(os.tmpdir(), "mycrm-fixture-"));
  t.after(() => rm(line, {recursive: true, force: true}));
  await exec("git", ["init", "--quiet", line]);
  await writeFile(path.join(line, ".gitignore"), "dist/\n");
  await writeFile(path.join(line, "README.md"), "authored\n");
  for (const name of OUTPUTS) assert.equal(await present(path.join(line, name)), false, `${name} starts absent`);
  await assert.rejects(ensureOutput(line, "src"), /tracked source/);
  const probe = "echo built > dist/probe && echo recorded > .git/oracle/probe && if echo changed > README.md; then exit 9; fi";
  const {code, output, outputs} = await arranged(line, OUTPUTS, ["/bin/sh", "-c", probe]);
  assert.equal(code, 0, output);
  assert.deepEqual(outputs, {".git/oracle": {probe: "recorded\n"}, dist: {probe: "built\n"}});
  assert.equal(await readFile(path.join(line, "README.md"), "utf8"), "authored\n");
  for (const name of OUTPUTS) assert.deepEqual(await readdir(path.join(line, name)), [], `${name} kept nothing in the checkout`);
});

test("release:check completes with authored source read-only and only .git/oracle and dist writable", {timeout: 240_000}, async () => {
  // The nested release check runs this module again inside the arrangement; that run checks the rest.
  if (process.env[NESTED] === "1") return;
  await access(BWRAP).catch(() => assert.fail("The host arrangement needs bubblewrap at " + BWRAP));
  const line = fileURLToPath(root).replace(/\/$/, "");
  const head = (await exec("git", ["rev-parse", "HEAD"], {cwd: line})).stdout.trim();
  const release = [process.execPath, "scripts/release-validation.mjs"];

  const passing = await arranged(line, OUTPUTS, release);
  assert.equal(passing.code, 0, passing.output.slice(-4000));
  assert.doesNotMatch(passing.output, /EROFS|EACCES|MYCRM_RELEASE_CHECK=FAILED/);
  const results = records(passing.outputs[".git/oracle"]);
  for (const category of ["sanity", "interactions", "acceptance"]) {
    const mine = results.filter(({record}) => record.category === category);
    assert.equal(mine.length, 1, `${category} recorded exactly one result`);
    const {record} = mine[0];
    assert.equal(record.commit, head);
    assert.equal(record.phase, "after");
    assert.equal(record.inputs_unchanged, true);
    assert.equal(record.passed, true, `${category} passed`);
    assert.equal(record.summary.passed, true);
  }
  assert.equal(new Set(results.map(({name}) => name)).size, results.length);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], {cwd: line})).stdout.trim(), head);
  assert.equal((await exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {cwd: line})).stdout, "", "authored content unchanged");

  // With dist read-only the release tooling cannot package, while evidence stays writable.
  const denied = await arranged(line, [".git/oracle"], release);
  assert.notEqual(denied.code, 0);
  assert.match(denied.output, /MYCRM_RELEASE_CHECK=FAILED .*--category interactions/);
  const evidence = denied.outputs[".git/oracle"], failed = records(evidence);
  assert.ok(failed.some(({record}) => record.category === "sanity" && record.passed), "evidence stayed writable");
  const packaging = failed.find(({record}) => record.category === "interactions");
  assert.ok(packaging && !packaging.record.passed, "packaging failed");
  const log = Object.entries(evidence).find(([name]) => name.endsWith(".log") && /EROFS[^\n]*dist\/my-crm/.test(evidence[name]));
  assert.ok(log, "packaging failed because dist was read-only");
});
