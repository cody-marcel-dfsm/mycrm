import {access, readFile, readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import process from "node:process";

import {validateApplicationDiscovery, validateDescribeResponse, validateJsonSchema, validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";
import {buildCrmContribution} from "../src/journey/client.mjs";
import {buildUpdateRequest, createConceptualCustomer} from "../src/crm/operations.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
const errors = [];
const leadDirectorReleaseFiles = [
  "api.contract.request.example.json",
  "api.contract.request.schema.json",
  "api.contract.response.example.json",
  "api.contract.response.schema.json",
  "app.describe.example.json",
  "app.describe.schema.json",
  "describe.request.example.json",
  "describe.response.example.json",
  "describe.response.schema.json",
  "operation.examples.json"
];

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

if (pkg.license !== "Apache-2.0" || manifest.license !== "Apache-2.0") errors.push("package and plugin must declare Apache-2.0");
if (pkg.version !== manifest.version || pkg.version !== product.version) errors.push("package, plugin, and product versions must match");
if (manifest.name !== "my-crm" || manifest.interface?.displayName !== "My CRM") errors.push("plugin identity is invalid");
if (manifest.apps !== undefined || manifest.mcpServers !== undefined) errors.push("My CRM must not declare an app mapping or a second MCP connection");
if (product.schema_version !== "2" || product.application_name !== "my-crm") errors.push("My CRM must use the published BOS external-product dependency v2 identity");
if (product.connection_owner !== "bos" || JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"]) || product.authentication !== "bos_dependency") errors.push("My CRM must depend on the BOS-owned connection");
if (product.authorization_scope_policy !== "ONE_ORGANIZATION_APPLICATION_INSTALLATION_ROLE_PER_GRANT") errors.push("My CRM must preserve the published BOS authorization scope policy");
for (const key of ["resource_url", "oauth", "token", "grant", "session", "credential", "mcp_group_name", "mcp_server_name", "codex_mcp_startup_timeout_sec", "codex_mcp_tool_timeout_sec"]) if (product[key] !== undefined) errors.push(`My CRM product metadata must not declare ${key}`);
const handoff = product.authentication_handoff;
if (handoff?.authentication_manager !== "bos" || handoff?.credential_lifecycle_owner !== "host" || handoff?.authorization_enforcement_owner !== "bos-service" || handoff?.delegation_policy !== "AUTOMATIC") errors.push("BOS authentication delegation metadata is invalid");
if (handoff?.readiness_result?.representation !== "AUTHENTICATION_READINESS_ONLY" || handoff?.readiness_result?.authority_data !== "EXCLUDED") errors.push("Authentication handoff must return readiness without authority data");

try {
  const request = await readJson("contracts/bos/lead-director/v1/describe.request.example.json");
  validateApplicationDiscovery(await readJson("contracts/bos/lead-director/v1/app.describe.example.json"));
  validateDescribeResponse(await readJson("contracts/bos/lead-director/v1/describe.response.example.json"), request.operations);
  const releaseManifestPath = path.join(root, "contracts/bos/lead-director/v1/manifest.json");
  const releaseManifestContent = await readFile(releaseManifestPath);
  const release = JSON.parse(releaseManifestContent);
  if (createHash("sha256").update(releaseManifestContent).digest("hex") !== "d6ec68b56d6fb13234a0f6e661e9e434def82c78164284204b3a57002e71134d") errors.push("BOS public contract manifest provenance is invalid");
  if (release.contract !== "bos-public-contract-release/v1" || release.owner !== "bos" || release.auth_impact !== "none" || release.bundle_sha256 !== "96b222b222aa2e71e359f9e0427cfbb5567be77152afdfc82d131277c75c45de") errors.push("BOS public contract release provenance is invalid");
  if (JSON.stringify(release.files.map(({path: filePath}) => filePath).sort()) !== JSON.stringify([...leadDirectorReleaseFiles].sort())) errors.push("BOS public contract release file inventory is invalid");
  const releaseDirectoryFiles = (await readdir(path.join(root, "contracts/bos/lead-director/v1"), {withFileTypes: true}))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(releaseDirectoryFiles) !== JSON.stringify([...leadDirectorReleaseFiles, "manifest.json"].sort())) errors.push("BOS public contract release directory is not the exact eleven-file bundle");
  for (const file of release.files) {
    const content = await readFile(path.join(root, "contracts/bos/lead-director/v1", file.path));
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) errors.push(`BOS public contract digest mismatch: ${file.path}`);
  }
  const apiContractRequest = await readJson("contracts/bos/lead-director/v1/api.contract.request.example.json");
  const apiContractResponse = await readJson("contracts/bos/lead-director/v1/api.contract.response.example.json");
  validateJsonValueAgainstSchema(apiContractRequest, await readJson("contracts/bos/lead-director/v1/api.contract.request.schema.json"), "api.contract.get request example");
  validateJsonValueAgainstSchema(apiContractResponse, await readJson("contracts/bos/lead-director/v1/api.contract.response.schema.json"), "api.contract.get response example");
  if (apiContractResponse.operation !== apiContractRequest.operation || apiContractResponse.cacheScope !== "private" || apiContractResponse.ttlMs !== 0) errors.push("api.contract.get release example parity is invalid");
  validateJsonSchema(apiContractResponse.input_schema, "api.contract.get input schema");
  validateJsonSchema(apiContractResponse.output_schema, "api.contract.get output schema");
  validateJsonSchema(apiContractResponse.receipt_schema, "api.contract.get receipt schema");
  const conceptualCustomer = await readJson("examples/crm/conceptual-customer.json");
  const journeyContribution = await readJson("examples/crm/journey-contribution.json");
  buildUpdateRequest(await readJson("examples/crm/targeted-update.json"));
  createConceptualCustomer(conceptualCustomer);
  buildCrmContribution(journeyContribution);
  validateJsonValueAgainstSchema(conceptualCustomer, await readJson("contracts/my-crm/v1/conceptual-customer.schema.json"), "conceptual customer example");
  validateJsonValueAgainstSchema(journeyContribution, await readJson("contracts/my-crm/v1/crm-journey-contribution.schema.json"), "CRM journey contribution example");
} catch (error) { errors.push(error.message); }

for (const relative of [
  "LICENSE", "NOTICE", "plugins/my-crm/assets/my-crm-logo.png",
  "contracts/bos/lead-director/v1/app.describe.schema.json",
  "contracts/bos/lead-director/v1/api.contract.request.schema.json",
  "contracts/bos/lead-director/v1/api.contract.response.schema.json",
  "contracts/bos/lead-director/v1/describe.response.schema.json",
  "contracts/bos/lead-director/v1/manifest.json",
  "contracts/my-crm/v1/conceptual-customer.schema.json",
  "contracts/my-crm/v1/crm-journey-contribution.schema.json",
  "contracts/my-crm/v1/release-dependencies.json"
]) {
  try { await access(path.join(root, relative)); } catch { errors.push(`${relative} is missing`); }
}
for (const relative of ["plugins/my-crm/.mcp.json", "plugins/my-crm/.app.json", "src/fsm", "contracts/fsm", "examples/fsm"]) {
  try { await access(path.join(root, relative)); errors.push(`${relative} must be absent`); } catch {}
}
for (const directory of ["contracts", "examples", "plugins"]) {
  for (const file of await jsonFiles(path.join(root, directory))) {
    try { JSON.parse(await readFile(file, "utf8")); } catch (error) { errors.push(`${path.relative(root, file)}: ${error.message}`); }
  }
}

const skillsRoot = path.join(root, "plugins/my-crm/skills");
const skillNames = (await readdir(skillsRoot, {withFileTypes: true})).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (skillNames.length !== 7) errors.push("My CRM must package exactly seven source-first skills");
for (const name of skillNames) {
  const content = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  if (!content.startsWith("---\nname:")) errors.push(`${name} has invalid skill frontmatter`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Public contracts and plugin package are valid.");
