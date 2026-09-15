import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const json = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const run = promisify(execFile);

test("plugin declares one product MCP and delegates authentication to required BOS", async () => {
  const manifest = await json("plugins/my-crm/.codex-plugin/plugin.json");
  const mcp = await json("plugins/my-crm/.mcp.json");
  const product = await json("plugins/my-crm/.bos-product.json");
  assert.equal(manifest.name, "my-crm");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.apps, undefined);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["crm"]);
  assert.equal(mcp.mcpServers.crm.url, "https://dfsm.ai/mcp/apps/leaddirector/crm");
  assert.equal(mcp.mcpServers.crm.oauth_resource, mcp.mcpServers.crm.url);
  assert.equal(mcp.mcpServers.crm.startup_timeout_sec, 180);
  assert.equal(mcp.mcpServers.crm.tool_timeout_sec, 180);
  assert.equal(product.connection_owner, "my-crm");
  assert.equal(product.authentication, "oauth_2_1");
  assert.equal(product.authentication_handoff.contract_id, "bos.authentication-handoff");
  assert.equal(product.authentication_handoff.contract_version, "1");
  assert.equal(product.authentication_handoff.authentication_manager, "bos");
  assert.equal(product.authentication_handoff.connection_owner, undefined);
  assert.equal(product.authentication_handoff.credential_lifecycle_owner, "host");
  assert.equal(product.authentication_handoff.authorization_enforcement_owner, "bos-service");
  assert.equal(product.authentication_handoff.delegation_policy, "AUTOMATIC");
  assert.deepEqual(product.authentication_handoff.recognized_condition_categories, [
    "MISSING_GRANT", "EXPIRED_TOKEN", "REVOKED_GRANT", "INVALID_CLIENT",
    "INVALID_GRANT", "RESOURCE_MISMATCH", "REAUTHENTICATION_REQUIRED",
    "AUTHORIZATION_REQUIRED", "MCP_WWW_AUTHENTICATE", "MCP_SESSION_CLOSED",
    "PROVIDER_AUTHORIZATION_REQUIRED"
  ]);
  assert.equal(product.authentication_handoff.readiness_result.representation, "AUTHENTICATION_READINESS_ONLY");
  assert.equal(product.authentication_handoff.context_handoff, undefined);
  assert.equal(product.authentication_handoff.continuation_policy, undefined);
  assert.equal(product.oauth, undefined);
  assert.deepEqual(product.dependency_products, ["bos"]);
  await access(path.join(root, "plugins/my-crm/assets/my-crm-logo.png"));
});

test("Vault initializer recreates the private layout", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "my-crm-vault-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/init-vault.mjs"), temporary], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  for (const relative of ["README.md", "decisions", "docs", "evidence", "index/manifests", "reviews", "specs", "tmp"]) {
    await access(path.join(temporary, relative));
  }
});

test("the complete Vault is private and excluded from Git and npm distribution", async () => {
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  const pkg = await json("package.json");
  assert.match(ignore, /^\/Vault\/$/m);
  assert.equal(pkg.files.includes("Vault/"), false);
  const tracked = await run("git", ["ls-files", "Vault"], { cwd: root });
  assert.equal(tracked.stdout.trim(), "");
  await run("git", ["check-ignore", "-q", "Vault/README.md"], { cwd: root });
});

test("package contains grouped My CRM expertise and no app compatibility mapping", async () => {
  const expected = [
    "my-crm",
    "my-crm-record-operations",
    "my-crm-pipeline-operations",
    "my-crm-activity-operations",
    "my-crm-federation-operations",
    "my-crm-customer-journey",
    "my-crm-automation"
  ];
  for (const skill of expected) await access(path.join(root, `plugins/my-crm/skills/${skill}/SKILL.md`));
  await assert.rejects(access(path.join(root, "plugins/my-crm/.app.json")));
  await assert.rejects(access(path.join(root, "scripts/configure-openai-app.mjs")));
});
