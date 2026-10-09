import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildClients, checkClients, clientPackages, clientsDirectory} from "../scripts/build-clients.mjs";
import {readJson, repositoryRoot, sha256File, walkFiles} from "../scripts/release-utils.mjs";

const manifests = {
  claude: ".claude-plugin/plugin.json", codex: ".codex-plugin/plugin.json",
  copilot: "plugin.json", gemini: "gemini-extension.json", muse: ".muse-plugin/plugin.json"
};
const skills = ["my-crm", "my-crm-record-operations", "my-crm-pipeline-operations", "my-crm-activity-operations", "my-crm-federation-operations", "my-crm-customer-journey", "my-crm-automation", "my-crm-cache-maintenance"];

test("all supported client packages discover complete skills and preserve BOS-only delegation", async () => {
  await checkClients();
  const version = (await readJson(path.join(repositoryRoot, "package.json"))).version;
  for (const [host, relative] of Object.entries(clientPackages)) {
    const root = path.join(clientsDirectory, relative);
    const manifest = await readJson(path.join(root, manifests[host]));
    assert.equal(manifest.name, "my-crm");
    assert.equal(manifest.version, version);
    assert.equal(manifest.mcpServers, undefined);
    assert.equal(manifest.apps, undefined);
    const metadata = await readJson(path.join(root, ".bos-product.json"));
    assert.equal(metadata.client, host);
    assert.equal(metadata.version, version);
    assert.equal(metadata.connection_owner, "bos");
    assert.equal(metadata.authentication, "bos_dependency");
    assert.deepEqual(metadata.dependency_products, ["bos"]);
    for (const id of skills) {
      const text = await readFile(path.join(root, `skills/${id}/SKILL.md`), "utf8");
      assert.match(text, new RegExp(`^---\\nname: ${id}\\n`));
      assert.ok(text.split("---")[2].trim().length > 100);
    }
    const files = await walkFiles(root);
    assert.equal(files.filter((file) => file.endsWith("/SKILL.md")).length, 8);
    assert.equal(files.some((file) => /(?:^|\/)(?:\.mcp\.json|mcp\.json|mcp_config\.json|credentials\.json|\.env)$/.test(file)), false);
    if (host === "muse") assert.deepEqual(manifest.capabilities.skills.map(({path: file}) => file).sort(), skills.map((id) => `skills/${id}/SKILL.md`).sort());
  }
  const desktop = await readJson(path.join(clientsDirectory, "gemini/extensions/my-crm/plugin.json"));
  assert.equal(desktop.$schema, "https://antigravity.google/schemas/v1/plugin.json");
  assert.equal(desktop.name, "my-crm");
  const claude = await readJson(path.join(clientsDirectory, "claude/.claude-plugin/marketplace.json"));
  const codex = await readJson(path.join(clientsDirectory, "codex/.agents/plugins/marketplace.json"));
  assert.equal(claude.plugins[0].source, "./plugins/my-crm");
  assert.deepEqual(codex.plugins[0].source, {source: "local", path: "./plugins/my-crm"});
});

test("client conformance rejects incomplete skill trees, altered host metadata and undeclared transports", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "my-crm-client-test-"));
  t.after(() => rm(root, {recursive: true, force: true}));
  await buildClients({destination: root});
  const inventory = async () => Promise.all((await walkFiles(root)).map(async (file) => [file, await sha256File(path.join(root, file))]));
  const first = await inventory();
  await buildClients({destination: root});
  assert.deepEqual(await inventory(), first);
  for (const relative of Object.values(clientPackages)) {
    const file = path.join(root, relative, "skills/my-crm/references/crm-contract-consumption.md");
    const original = await readFile(file);
    await writeFile(file, "incomplete");
    await assert.rejects(checkClients({directory: root}), /Client package source drift/);
    await writeFile(file, original);
  }
  const metadata = path.join(root, clientPackages.claude, ".bos-product.json");
  const original = await readFile(metadata);
  await writeFile(metadata, JSON.stringify({client: "codex"}));
  await assert.rejects(checkClients({directory: root}), /Client package source drift/);
  await writeFile(metadata, original);
  await writeFile(path.join(root, clientPackages.gemini, "mcp_config.json"), "{}");
  await assert.rejects(checkClients({directory: root}), /Client package inventory drift/);
});
