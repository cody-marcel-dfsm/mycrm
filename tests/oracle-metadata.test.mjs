import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, realpath, chmod, lstat} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {atomicJson, withOracleRun, readMetadataFile, writeMetadataFile, removeMetadataFile, preparedEvidence, metadataDirectory} from "../scripts/oracle-inputs.mjs";

const execute = promisify(execFile);
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "oracle-metadata-"));
  const base = await realpath(temporary);
  const root = path.join(base, "owner"), outside = path.join(base, "foreign");
  await mkdir(root); await mkdir(outside);
  t.after(() => rm(base, {recursive: true, force: true}));
  return {base, root, outside};
}

test("initial metadata admission rejects foreign and returning aliases before lock creation", async (t) => {
  for (const returning of [false, true]) await t.test(String(returning), async (t) => {
    const {root, outside} = await fixture(t);
    const selected = path.join(root, "oracle"), saved = path.join(root, "saved");
    await mkdir(saved);
    if (returning) await symlink(saved, path.join(outside, "return"));
    await symlink(returning ? path.join(outside, "return") : outside, selected);
    let admitted = false;
    await assert.rejects(withOracleRun(selected, async () => { admitted = true; }, {ownerRoot: root}), /owning source scope/);
    assert.equal(admitted, false);
    assert.deepEqual(await readdir(saved), []);
    assert.deepEqual(await readdir(outside), returning ? ["return"] : []);
  });
});

test("metadata creation preserves missing-parent and existing-alias parent semantics", async (t) => {
  const {root} = await fixture(t);
  await assert.rejects(metadataDirectory(root, `${root}/missing/../created`), /unresolved missing parent/);
  assert.deepEqual(await readdir(root), []);
  await mkdir(path.join(root, "deep", "inside"), {recursive: true});
  await symlink(path.join(root, "deep", "inside"), path.join(root, "alias"));
  assert.equal(await metadataDirectory(root, `${root}/alias/../created`), path.join(root, "deep", "created"));
  await assert.rejects(lstat(path.join(root, "created")), {code: "ENOENT"});
});

test("late metadata movement cannot redirect writes, cache reads or cleanup", async (t) => {
  for (const operation of ["atomic", "write", "read", "remove", "cache"]) await t.test(operation, async (t) => {
    const {root, outside} = await fixture(t);
    const directory = path.join(root, "oracle");
    await assert.rejects(withOracleRun(directory, async ({run}) => {
      const replacement = path.join(outside, "runs", path.basename(run));
      await mkdir(replacement, {recursive: true});
      await writeFile(path.join(replacement, "keep.json"), "synthetic-original");
      await rename(directory, path.join(root, "original-store"));
      await symlink(outside, directory);
      const filename = path.join(run, "keep.json");
      if (operation === "atomic") await atomicJson(filename, {changed: true});
      if (operation === "write") await writeMetadataFile(filename, "changed");
      if (operation === "read") await readMetadataFile(filename);
      if (operation === "remove") await removeMetadataFile(filename, {force: true});
      if (operation === "cache") await preparedEvidence(directory, {}, async () => ({changed: true}));
    }, {ownerRoot: root}), /owning source scope/);
    const [run] = await readdir(path.join(outside, "runs"));
    assert.equal(await readFile(path.join(outside, "runs", run, "keep.json"), "utf8"), "synthetic-original");
    assert.deepEqual(await readdir(outside), ["runs"]);
    assert.deepEqual(await readdir(path.join(outside, "runs", run)), ["keep.json"]);
  });
});

test("safe owner/store/file aliases and source-mode ERROR retention remain usable", async (t) => {
  const {base, root} = await fixture(t);
  const declared = path.join(base, "declared-owner"); await symlink(root, declared);
  const actual = path.join(root, "actual"); await mkdir(actual);
  const directory = path.join(declared, "oracle"); await symlink(actual, directory);
  let run;
  await assert.rejects(withOracleRun(directory, async (context) => {
    run = context.run;
    const target = path.join(run, "target.json"); await atomicJson(target, {value: 1});
    const alias = path.join(run, "alias.json"); await symlink(target, alias);
    await atomicJson(alias, {value: 2});
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(await readMetadataFile(alias, "utf8")), {value: 2});
    await chmod(root, 0o755);
    throw new Error("synthetic source movement");
  }, {ownerRoot: declared}), /synthetic source movement/);
  assert.equal(JSON.parse(await readFile(path.join(run, "outcome.json"), "utf8")).outcome, "ERROR");
  await assert.rejects(lstat(path.join(actual, "run.lock")), {code: "ENOENT"});
});

test("existing file, alias and FIFO directory-lock entries remain busy without IO", async (t) => {
  for (const kind of ["file", "alias", "fifo"]) await t.test(kind, async (t) => {
    const {root, outside} = await fixture(t), directory = path.join(root, "oracle");
    await mkdir(directory);
    const lock = path.join(directory, "run.lock");
    if (kind === "file") await writeFile(lock, "original");
    if (kind === "alias") await symlink(outside, lock);
    if (kind === "fifo") await execute("mkfifo", [lock]);
    await assert.rejects(withOracleRun(directory, async () => assert.fail("No admission"), {ownerRoot: root}), /busy/);
    assert.deepEqual(await readdir(outside), []);
    if (kind === "file") assert.equal(await readFile(lock, "utf8"), "original");
  });
});

test("managed regular readers reject foreign leaf aliases and nonregular bodies", async (t) => {
  const {root, outside} = await fixture(t);
  const directory = path.join(root, "oracle");
  await withOracleRun(directory, async ({run}) => {
    const foreign = path.join(outside, "body.json"); await writeFile(foreign, "synthetic");
    const alias = path.join(run, "body.json"); await symlink(foreign, alias);
    await assert.rejects(readMetadataFile(alias), /owning source scope/);
    const fifo = path.join(run, "fifo"); await execute("mkfifo", [fifo]);
    await assert.rejects(readMetadataFile(fifo), /regular file/);
    await assert.rejects(writeMetadataFile(fifo, "value"), /regular file/);
  }, {ownerRoot: root});
});

test("the actual verifier fences initial store and receipt aliases before content", async (t) => {
  for (const kind of ["directory", "receipt"]) await t.test(kind, async (t) => {
    const {root, outside} = await fixture(t);
    const git = (...args) => execute("git", args, {cwd: root});
    await git("init", "-b", "main");
    await writeFile(path.join(root, "candidate.txt"), "original"); await git("add", ".");
    await git("-c", "user.name=Synthetic Reviewer", "-c", "user.email=reviewer@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "synthetic baseline");
    await writeFile(path.join(root, "candidate.txt"), "changed"); await git("add", ".");
    const directory = path.join(root, ".git/oracle");
    if (kind === "directory") await symlink(outside, directory);
    else {
      await mkdir(directory); await writeFile(path.join(outside, "receipt"), "synthetic-unparsed-body");
      await symlink(path.join(outside, "receipt"), path.join(directory, "approval.json"));
    }
    const command = fileURLToPath(new URL("../scripts/oracle-review.mjs", import.meta.url));
    await assert.rejects(execute(process.execPath, [command, "verify-index"], {cwd: root}), (error) => /owning source scope/.test(error.stderr));
    assert.deepEqual(await readdir(outside), kind === "directory" ? [] : ["receipt"]);
  });
});
