import {access, readFile, readdir} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {validateJsonSchema, validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";
import {buildCrmContribution} from "../src/journey/client.mjs";
import {buildUpdateRequest, createConceptualCustomer} from "../src/crm/operations.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const errors = [];

async function jsonFiles(directory, files = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await jsonFiles(absolute, files);
    else if (entry.name.endsWith(".json")) files.push(absolute);
  }
  return files;
}

const pkg = await readJson("package.json");
const manifest = await readJson("plugins/my-crm/.codex-plugin/plugin.json");
const product = await readJson("plugins/my-crm/.bos-product.json");
const marketplacePromptContracts = await readJson("contracts/my-crm/v1/marketplace-prompt-contracts.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");

if (pkg.license !== "Apache-2.0" || manifest.license !== "Apache-2.0") errors.push("package and plugin must declare Apache-2.0");
if (pkg.version !== manifest.version || pkg.version !== product.version) errors.push("package, plugin, and product versions must match");
if (manifest.name !== "my-crm" || manifest.interface?.displayName !== "My CRM") errors.push("plugin identity is invalid");
if (JSON.stringify(manifest.interface?.defaultPrompt) !== JSON.stringify(marketplacePromptContracts.prompts?.map(({text}) => text))) errors.push("plugin starter prompts must exactly match their marketplace prompt contracts");
const canonicalJourneyPrompt = marketplacePromptContracts.prompts?.find(({id}) => id === "canonical-recent-meeting-follow-up");
if (canonicalJourneyPrompt?.text !== "Use the attendees from the meeting that just ended to prepare and send a follow-up." || canonicalJourneyPrompt?.operation !== null || canonicalJourneyPrompt?.effect !== "approval-gated-write" || canonicalJourneyPrompt?.routing !== "bos-journey" || !canonicalJourneyPrompt?.assertions?.includes("no-initial-crm-lookup") || !canonicalJourneyPrompt?.assertions?.includes("approval-before-send") || !canonicalJourneyPrompt?.assertions?.includes("crm-only-on-returned-instruction")) errors.push("canonical recent-meeting starter prompt must retain BOS-owned journey routing and My CRM participation boundaries");
if (manifest.apps !== undefined || manifest.mcpServers !== undefined) errors.push("My CRM must not declare an app mapping or a second MCP connection");
if (product.schema_version !== "2" || product.application_name !== "my-crm") errors.push("My CRM product identity is invalid");
if (product.connection_owner !== "bos" || JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"]) || product.authentication !== "bos_dependency") errors.push("My CRM must depend on the BOS-owned connection");
if (product.authorization_scope_policy !== "ONE_ORGANIZATION_APPLICATION_INSTALLATION_ROLE_PER_GRANT") errors.push("My CRM must preserve the approved BOS authorization scope policy");
for (const key of ["resource_url", "oauth", "token", "grant", "session", "credential", "mcp_group_name", "mcp_server_name", "codex_mcp_startup_timeout_sec", "codex_mcp_tool_timeout_sec"]) if (product[key] !== undefined) errors.push(`My CRM product metadata must not declare ${key}`);

const handoff = product.authentication_handoff;
if (handoff?.authentication_manager !== "bos" || handoff?.credential_lifecycle_owner !== "host" || handoff?.authorization_enforcement_owner !== "bos-service" || handoff?.delegation_policy !== "AUTOMATIC") errors.push("BOS authentication delegation metadata is invalid");
if (handoff?.readiness_result?.representation !== "AUTHENTICATION_READINESS_ONLY" || handoff?.readiness_result?.authority_data !== "EXCLUDED") errors.push("Authentication handoff must return readiness without authority data");

if (marketplace.name !== "my-crm-local" || marketplace.plugins?.length !== 1) errors.push("Local marketplace identity is invalid");
const marketplacePlugin = marketplace.plugins?.[0];
if (marketplacePlugin?.name !== "my-crm" || marketplacePlugin?.source?.source !== "local" || marketplacePlugin?.source?.path !== "./dist/my-crm") errors.push("Local marketplace must install the built My CRM release candidate");
if (marketplacePlugin?.policy?.installation !== "AVAILABLE" || marketplacePlugin?.policy?.authentication !== "ON_USE") errors.push("Local marketplace policy is invalid");

try {
  const conceptualCustomer = await readJson("examples/crm/conceptual-customer.json");
  const journeyContribution = await readJson("examples/crm/journey-contribution.json");
  buildUpdateRequest(await readJson("examples/crm/targeted-update.json"));
  createConceptualCustomer(conceptualCustomer);
  buildCrmContribution(journeyContribution);
  validateJsonSchema(await readJson("contracts/my-crm/v1/live-acceptance-response.schema.json"), "live acceptance response schema");
  const marketplacePromptSchema = await readJson("contracts/my-crm/v1/marketplace-prompt-contracts.schema.json");
  validateJsonSchema(marketplacePromptSchema, "marketplace prompt contracts schema");
  validateJsonValueAgainstSchema(marketplacePromptContracts, marketplacePromptSchema, "marketplace prompt contracts");
  validateJsonValueAgainstSchema(conceptualCustomer, await readJson("contracts/my-crm/v1/conceptual-customer.schema.json"), "conceptual customer example");
  validateJsonValueAgainstSchema(journeyContribution, await readJson("contracts/my-crm/v1/crm-journey-contribution.schema.json"), "CRM journey contribution example");
} catch (error) { errors.push(error.message); }

for (const relative of [
  "LICENSE", "NOTICE", "plugins/my-crm/assets/my-crm-logo.png",
  "contracts/my-crm/v1/conceptual-customer.schema.json",
  "contracts/my-crm/v1/crm-journey-contribution.schema.json",
  "contracts/my-crm/v1/release-dependencies.json",
  "contracts/my-crm/v1/live-acceptance-response.schema.json",
  "contracts/my-crm/v1/marketplace-prompt-contracts.json",
  "contracts/my-crm/v1/marketplace-prompt-contracts.schema.json"
]) {
  try { await access(path.join(root, relative)); } catch { errors.push(`${relative} is missing`); }
}

for (const relative of [
  "plugins/my-crm/.mcp.json", "plugins/my-crm/.app.json", "src/fsm", "contracts/fsm", "examples/fsm",
  "contracts/bos", "contracts/bos-operations-center",
  "scripts/import-bos-contract.mjs", "scripts/import-bos-service-consumer-contract.mjs",
  "scripts/import-boc-client-dependency.mjs", "scripts/import-boc-dependency-contract.mjs"
]) {
  try { await access(path.join(root, relative)); errors.push(`${relative} must be absent`); } catch {}
}

for (const directory of ["contracts/my-crm", "examples", "plugins"]) {
  for (const file of await jsonFiles(path.join(root, directory))) {
    try { JSON.parse(await readFile(file, "utf8")); } catch (error) { errors.push(`${path.relative(root, file)}: ${error.message}`); }
  }
}

const skillsRoot = path.join(root, "plugins/my-crm/skills");
const skillNames = (await readdir(skillsRoot, {withFileTypes: true})).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (skillNames.length !== 8) errors.push("My CRM must package exactly eight source-first skills");
for (const name of skillNames) {
  const content = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  if (!content.startsWith("---\nname:")) errors.push(`${name} has invalid skill frontmatter`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("My CRM-owned contracts and plugin package are valid.");
