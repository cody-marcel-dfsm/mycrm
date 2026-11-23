import assert from "node:assert/strict";
import {execFile} from "node:child_process";
import {access, mkdir, mkdtemp, readFile, readdir, rm} from "node:fs/promises";
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
const NESTED = "MYCRM_HOST_ARRANGEMENT", BWRAP = "/usr/bin/bwrap";

async function hostRelease(writable) {
  const line = fileURLToPath(root).replace(/\/$/, ""), scratch = await mkdtemp(path.join(os.tmpdir(), "mycrm-host-"));
  try {
    const binds = [];
    for (const name of writable) {
      const own = path.join(scratch, name.replace(/\//g, "_"));
      await mkdir(own);
      binds.push("--bind", own, path.join(line, name));
    }
    // The enrolled runtime stays visible under the masked home, as the host binds it.
    const runtime = path.dirname(path.dirname(process.execPath));
    const sandbox = [
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", os.homedir(),
      "--ro-bind", runtime, runtime, "--ro-bind", line, line, "--tmpfs", path.join(line, "Vault"), ...binds,
      "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
      "--setenv", "PATH", process.env.PATH, "--setenv", "HOME", "/tmp/home", "--setenv", NESTED, "1",
      "--chdir", line, "--", process.execPath, "scripts/release-validation.mjs"
    ];
    const result = await promisify(execFile)(BWRAP, sandbox, {maxBuffer: 16 * 1024 * 1024}).catch((error) => error);
    const records = await readdir(path.join(scratch, ".git_oracle"), {recursive: true}).catch(() => []);
    return {code: result.code ?? 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, records};
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

test("release:check completes with authored source read-only and only .git/oracle and dist writable", {timeout: 240_000}, async () => {
  // The nested release check runs this module again inside the arrangement; that run checks the rest.
  if (process.env[NESTED] === "1") return;
  await access(BWRAP).catch(() => assert.fail("The host arrangement needs bubblewrap at " + BWRAP));
  const {code, output, records} = await hostRelease([".git/oracle", "dist"]);
  assert.equal(code, 0, output.slice(-4000));
  assert.doesNotMatch(output, /EROFS|EACCES|MYCRM_RELEASE_CHECK=FAILED/);
  for (const category of ["sanity", "interactions", "acceptance"])
    assert.ok(records.some((name) => path.basename(name).startsWith(`${category}-after-`)), `${category} recorded its own evidence`);
  // The arrangement is what makes it pass: without a writable dist the release tooling cannot build.
  assert.notEqual((await hostRelease([".git/oracle"])).code, 0);
});
