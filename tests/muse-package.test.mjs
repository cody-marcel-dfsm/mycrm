import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {buildMuse, checkMuse, museDirectory} from "../scripts/build-muse.mjs";
import {repositoryRoot, sha256File, walkFiles} from "../scripts/release-utils.mjs";

const expected = ["my-crm", "my-crm-activity-operations", "my-crm-automation", "my-crm-cache-maintenance", "my-crm-customer-journey", "my-crm-federation-operations", "my-crm-pipeline-operations", "my-crm-record-operations"].sort();

test("committed Muse package exposes eight complete native skills through BOS only", async () => {
  const manifest = await checkMuse();
  assert.deepEqual(manifest.capabilities.skills.map(({id}) => id).sort(), expected);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.compat.manifestDir, ".muse-plugin");
  assert.equal(manifest.capabilities.mcpServers, undefined);
  assert.equal(manifest.meta.brandColor, "#061638");
  const metadata = JSON.parse(await readFile(path.join(museDirectory, ".bos-product.json"), "utf8"));
  assert.equal(metadata.client, "muse");
  assert.equal(metadata.connection_owner, "bos");
  assert.equal(metadata.authentication, "bos_dependency");
  assert.deepEqual(metadata.dependency_products, ["bos"]);
  for (const {id, path: file} of manifest.capabilities.skills) {
    assert.match(id, /^[a-z0-9][a-z0-9._-]{0,79}$/);
    assert.ok((await readFile(path.join(museDirectory, file))).length < 256 * 1024);
  }
});

test("Muse generation is deterministic and rejects skill drift or an added transport", async (t) => {
  const base = path.join(repositoryRoot, "Vault/tmp/muse-client/tests");
  await mkdir(base, {recursive: true});
  const temporary = await mkdtemp(path.join(base, "package-"));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  await buildMuse({destination: temporary});
  const inventory = async () => Promise.all((await walkFiles(temporary)).map(async (file) => [file, await sha256File(path.join(temporary, file))]));
  const first = await inventory();
  await buildMuse({destination: temporary});
  assert.deepEqual(await inventory(), first);
  await checkMuse({directory: temporary});
  const skill = path.join(temporary, "skills/my-crm/SKILL.md");
  const original = await readFile(skill);
  await writeFile(skill, "changed skill");
  await assert.rejects(checkMuse({directory: temporary}), /Muse source drift/);
  await writeFile(skill, original);
  await writeFile(path.join(temporary, ".mcp.json"), "{}");
  await assert.rejects(checkMuse({directory: temporary}), /Unexpected Muse package file/);
});
