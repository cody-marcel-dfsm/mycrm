import assert from "node:assert/strict";
import {access, mkdtemp, readFile, rm} from "node:fs/promises";
import {execFile, spawn} from "node:child_process";
import {promisify} from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const json = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const run = promisify(execFile);

test("plugin depends on the single BOS-owned connection and declares no authentication binding", async () => {
  const manifest = await json("plugins/my-crm/.codex-plugin/plugin.json");
  const claudeManifest = await json("plugins/my-crm/.claude-plugin/plugin.json");
  const product = await json("plugins/my-crm/.bos-product.json");
  const promptContracts = await json("contracts/my-crm/v1/marketplace-prompt-contracts.json");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(claudeManifest.version, manifest.version);
  assert.equal(manifest.mcpServers, undefined);
  assert.deepEqual(manifest.interface.defaultPrompt, promptContracts.prompts.map(({text}) => text));
  assert.equal(manifest.interface.defaultPrompt.length, 3);
  for (const prompt of promptContracts.prompts) {
    assert.ok(prompt.text.length <= 500);
    assert.equal(prompt.assertions.includes("active-authenticated-scope"), true);
    assert.equal(prompt.assertions.includes("plugin-scoped-default"), true);
    assert.equal(prompt.assertions.includes("bos-authority-resolution"), true);
    assert.equal(prompt.assertions.includes("cross-context-data-isolation"), true);
    assert.equal(prompt.assertions.includes("current-discovery-only"), true);
    assert.equal(prompt.assertions.includes("no-additional-identifiers"), true);
    assert.equal(prompt.assertions.includes("calendar-derived-audience"), true);
    assert.equal(prompt.assertions.includes("stop-when-no-qualifying-attendee"), true);
  }
  assert.equal(promptContracts.prompts[1].operation, null);
  assert.equal(promptContracts.prompts[1].routing, "bos-journey");
  assert.equal(promptContracts.prompts[1].assertions.includes("no-initial-crm-lookup"), true);
  assert.equal(product.schema_version, "2");
  assert.equal(product.application_name, "my-crm");
  assert.equal(product.connection_owner, "bos");
  assert.deepEqual(product.dependency_products, ["bos"]);
  assert.equal(product.authentication, "bos_dependency");
  assert.equal(product.authorization_scope_policy, "ONE_ORGANIZATION_APPLICATION_INSTALLATION_ROLE_PER_GRANT");
  for (const key of ["resource_url", "oauth", "token", "grant", "session", "credential", "mcp_group_name", "mcp_server_name", "codex_mcp_startup_timeout_sec", "codex_mcp_tool_timeout_sec"]) assert.equal(product[key], undefined);
  assert.equal(product.authentication_handoff.authentication_manager, "bos");
  assert.equal(product.authentication_handoff.credential_lifecycle_owner, "host");
  assert.equal(product.authentication_handoff.readiness_result.authority_data, "EXCLUDED");
  await assert.rejects(access(path.join(root, "plugins/my-crm/.mcp.json")));
  const release = await json("contracts/my-crm/v1/release-dependencies.json");
  assert.equal(release.status, "blocked_external");
  assert.ok(release.dependencies.some(({id}) => id === "shared-bos-connection-host-binding"));
});

test("package contains source-first CRM expertise and no local runtime", async () => {
  const expected = ["my-crm", "my-crm-record-operations", "my-crm-pipeline-operations", "my-crm-activity-operations", "my-crm-federation-operations", "my-crm-customer-journey", "my-crm-automation", "my-crm-cache-maintenance"];
  for (const skill of expected) await access(path.join(root, `plugins/my-crm/skills/${skill}/SKILL.md`));
  await access(path.join(root, "examples/crm/README.md"));
  for (const retired of ["src/fsm", "contracts/fsm", "examples/fsm", "plugins/my-crm/.app.json"]) await assert.rejects(access(path.join(root, retired)));
});

test("built artifact excludes Vault, credentials, a second MCP, and every external BOS contract", async () => {
  const {stdout} = await run("npm", ["pack", "--dry-run", "--json"], {cwd: root, maxBuffer: 1024 * 1024});
  const report = JSON.parse(stdout)[0];
  const files = report.files.map(({path: relative}) => relative);
  assert.equal(files.some((relative) => relative.startsWith("Vault/")), false);
  assert.equal(files.some((relative) => relative.endsWith(".mcp.json") || relative.includes("/fsm/")), false);
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("NOTICE"));
  assert.equal(files.some((relative) => relative.startsWith("contracts/")), false);
  assert.equal(files.some((relative) => /provenance|\.tgz$|\.tar\.gz$/.test(relative)), false);
});

test("Vault initializer recreates the private layout and Vault stays untracked", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-vault-"));
  context.after(() => rm(temporary, {recursive: true, force: true}));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/init-vault.mjs"), temporary], {stdio: "pipe"});
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await access(path.join(temporary, "README.md"));
  assert.equal((await run("git", ["ls-files", "Vault"], {cwd: root})).stdout.trim(), "");
});
