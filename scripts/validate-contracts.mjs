import {access, readFile, readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import process from "node:process";

import {validateApplicationDiscovery, validateDescribeResponse, validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";
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

if (pkg.license !== "Apache-2.0" || manifest.license !== "Apache-2.0") errors.push("package and plugin must declare Apache-2.0");
if (pkg.version !== manifest.version || pkg.version !== product.version) errors.push("package, plugin, and product versions must match");
if (manifest.name !== "my-crm" || manifest.interface?.displayName !== "My CRM") errors.push("plugin identity is invalid");
if (manifest.apps !== undefined || manifest.mcpServers !== undefined) errors.push("My CRM must not declare an app mapping or a second MCP connection");
if (product.connection_owner !== "bos" || JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"])) errors.push("My CRM must depend on the BOS-owned connection");
for (const key of ["resource_url", "authentication", "oauth", "mcp_group_name", "application_name"]) if (product[key] !== undefined) errors.push(`My CRM product metadata must not declare ${key}`);
const handoff = product.authentication_handoff;
if (handoff?.authentication_manager !== "bos" || handoff?.credential_lifecycle_owner !== "host" || handoff?.authorization_enforcement_owner !== "bos-service" || handoff?.delegation_policy !== "AUTOMATIC") errors.push("BOS authentication delegation metadata is invalid");
if (handoff?.readiness_result?.representation !== "AUTHENTICATION_READINESS_ONLY" || handoff?.readiness_result?.authority_data !== "EXCLUDED") errors.push("Authentication handoff must return readiness without authority data");

try {
  const request = await readJson("contracts/bos/lead-director/v1/describe.request.example.json");
  validateApplicationDiscovery(await readJson("contracts/bos/lead-director/v1/app.describe.example.json"));
  validateDescribeResponse(await readJson("contracts/bos/lead-director/v1/describe.response.example.json"), request.operations);
  const release = await readJson("contracts/bos/lead-director/v1/manifest.json");
  if (release.contract !== "bos-public-contract-release/v1" || release.bundle_sha256 !== "fd73779783242b4420dc72d7d8ade232f5adbc318ae69261b584b2b5dcfd5367") errors.push("BOS public contract release provenance is invalid");
  for (const file of release.files) {
    const content = await readFile(path.join(root, "contracts/bos/lead-director/v1", file.path));
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) errors.push(`BOS public contract digest mismatch: ${file.path}`);
  }
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
