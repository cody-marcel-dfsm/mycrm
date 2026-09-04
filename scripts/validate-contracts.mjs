import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { generateCrmFsm, validateCrmFsm } from "../src/fsm/generate.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const errors = [];
const resource = "https://dfsm.ai/mcp/apps/leaddirector/crm";

const pkg = await readJson("package.json");
const manifest = await readJson("plugins/my-crm/.codex-plugin/plugin.json");
const product = await readJson("plugins/my-crm/.bos-product.json");
const mcp = await readJson("plugins/my-crm/.mcp.json");
const graphSchema = await readJson("contracts/fsm/v1/crm-automation.schema.json");
const mcpSchema = await readJson("contracts/bos/v1/my-crm-product-mcp.schema.json");
const example = await readJson("examples/fsm/lead-follow-up.fsm.json");

if (pkg.license !== "Apache-2.0" || manifest.license !== "Apache-2.0") errors.push("package and plugin must declare Apache-2.0");
if (pkg.version !== manifest.version || pkg.version !== product.version) errors.push("package, plugin, and product versions must match");
if (manifest.name !== "my-crm" || manifest.interface?.displayName !== "My CRM") errors.push("plugin identity is invalid");
if (manifest.apps !== undefined) errors.push("My CRM packages must not declare .app.json compatibility mappings");

const serverEntries = Object.entries(mcp.mcpServers ?? {});
if (serverEntries.length !== 1 || serverEntries[0][0] !== "my-crm") errors.push("My CRM must declare exactly one product-owned MCP server");
const server = serverEntries[0]?.[1];
if (server?.url !== resource || server?.oauth_resource !== resource) errors.push("My CRM MCP and OAuth resource must equal the sealed product URL");
if (server?.type !== "http" || server?.required !== true || server?.startup_timeout_sec !== 180 || server?.tool_timeout_sec !== 180) {
  errors.push("My CRM MCP transport and 180-second host budgets are invalid");
}
if (product.connection_owner !== "my-crm" || product.resource_url !== resource) errors.push("My CRM must own its product connection");
if (JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"])) errors.push("My CRM must depend on BOS only");
if (product.application_name !== "leaddirector" || product.mcp_group_name !== "crm") errors.push("My CRM must bind the Lead Director application CRM group");

if (graphSchema.$id !== "https://dfsm.ai/contracts/fsm/v1/crm-automation.schema.json") errors.push("FSM schema identity is invalid");
if (mcpSchema.$id !== "https://dfsm.ai/contracts/bos/v1/my-crm-product-mcp.schema.json") errors.push("MCP schema identity is invalid");
const graphIssues = validateCrmFsm(example);
if (graphIssues.length) errors.push(...graphIssues.map((issue) => `example: ${issue}`));
const exampleCapabilities = [...new Set(example.spec.transitions.flatMap((transition) => transition.effects.map((effect) => effect.capability)))];
try {
  generateCrmFsm({
    slug: example.metadata.slug,
    name: example.metadata.name,
    description: example.metadata.description,
    labels: example.metadata.labels,
    goal: example.spec.goal,
    capabilityContract: example.spec.capabilityContract,
    inputs: example.spec.inputs,
    states: example.spec.states,
    transitions: example.spec.transitions
  }, { capabilityCatalog: exampleCapabilities });
} catch (error) { errors.push(error.message); }

for (const relative of ["LICENSE", "NOTICE", "plugins/my-crm/assets/my-crm-logo.png"]) {
  try { await access(path.join(root, relative)); } catch { errors.push(`${relative} is missing`); }
}
const inspected = ["README.md", "AGENTS.md"];
const skillsRoot = path.join(root, "plugins/my-crm/skills");
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (entry.isDirectory()) inspected.push(`plugins/my-crm/skills/${entry.name}/SKILL.md`);
}
for (const relative of inspected) {
  const content = await readFile(path.join(root, relative), "utf8");
  if (/\[TODO(?::|\])/i.test(content) || /REPLACE_WITH_REGISTERED_ID/.test(content)) errors.push(`${relative} contains a placeholder`);
}
try { await access(path.join(root, "plugins/my-crm/.app.json")); errors.push("My CRM must not contain .app.json"); } catch {}
try { await access(path.join(root, "scripts/configure-openai-app.mjs")); errors.push("obsolete app registration tooling must be absent"); } catch {}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public contracts and plugin package are valid.");
}
