import {access, lstat, readFile, readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import process from "node:process";

import {validateApplicationDiscovery, validateDescribeResponse, validateJsonSchema, validateJsonValueAgainstSchema} from "../src/bos/contracts.mjs";
import {buildCrmContribution, validateCrmInstructionEnvelope, validateCrmResolutionEnvelope} from "../src/journey/client.mjs";
import {buildUpdateRequest, createConceptualCustomer} from "../src/crm/operations.mjs";
import {sha256File} from "./release-utils.mjs";

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
  "JOURNEY-CLIENT-CONTRACT.md",
  "journey.client-action-required.example.json",
  "journey.client-action-required.schema.json",
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
const marketplacePromptContracts = await readJson("contracts/my-crm/v1/marketplace-prompt-contracts.json");
const marketplace = await readJson(".agents/plugins/marketplace.json");
const bocDependencySchemaPath = "contracts/bos-operations-center/external-product-dependency/v2/external-product-dependency.v2.schema.json";
const bocDependencyContractPath = "contracts/bos-operations-center/external-product-dependency/v2/external-product-dependency.v2.md";
const bocDependencyProvenancePath = "contracts/bos-operations-center/external-product-dependency/v2/import-provenance.json";
const bocDependencySchema = await readJson(bocDependencySchemaPath);
const bocDependencyProvenance = await readJson(bocDependencyProvenancePath);
const bocDependencySchemaBytes = await readFile(path.join(root, bocDependencySchemaPath));
const bocDependencyContractBytes = await readFile(path.join(root, bocDependencyContractPath));
const bocClientRoot = "contracts/bos-operations-center/bos-client-dependency/v1";
const bocClientProvenancePath = "contracts/bos-operations-center/bos-client-dependency/import-provenance.json";
const bocClientManifest = await readJson(`${bocClientRoot}/manifest.json`);
const bocClientProvenance = await readJson(bocClientProvenancePath);
const bocClientFiles = [
  "README.md",
  "discovered-operation.request.example.json",
  "discovered-operation.request.schema.json",
  "discovered-operation.response.example.json",
  "discovered-operation.response.schema.json",
  "shared-cache.request.example.json",
  "shared-cache.request.schema.json",
  "shared-cache.results.example.json",
  "shared-cache.results.schema.json"
];
const bocClientExecutables = [
  ["external_dependency_adapter", "skills/bos-external-dependency-adapter/scripts/external-dependency-adapter.mjs"],
  ["external_dependency_schema_runtime", "skills/bos-external-dependency-adapter/scripts/vendor/ajv2020.bundle.mjs"],
  ["external_dependency_discovered_operation_schema", "skills/bos-external-dependency-adapter/scripts/discovered-operation-request.schema.mjs"],
  ["shared_cache_consumer", "skills/bos-mcp-client/scripts/shared-cache-consumer.mjs"]
];
const bosServiceJourneyRoot = "contracts/bos/service-journey/v1";
const bosServiceJourneyFiles = ["JOURNEY-CLIENT-CONTRACT.md", "PROVENANCE.json", "journey.client-action-required.example.json", "journey.client-action-required.schema.json"];
const bosServiceJourneyProvenancePath = "contracts/bos/service-journey/import-provenance.json";
const bosServiceJourneyProvenance = await readJson(bosServiceJourneyProvenancePath);
const bosServiceSourceProvenance = await readJson(`${bosServiceJourneyRoot}/PROVENANCE.json`);

if (pkg.license !== "Apache-2.0" || manifest.license !== "Apache-2.0") errors.push("package and plugin must declare Apache-2.0");
if (pkg.version !== manifest.version || pkg.version !== product.version) errors.push("package, plugin, and product versions must match");
if (manifest.name !== "my-crm" || manifest.interface?.displayName !== "My CRM") errors.push("plugin identity is invalid");
if (JSON.stringify(manifest.interface?.defaultPrompt) !== JSON.stringify(marketplacePromptContracts.prompts?.map(({text}) => text))) errors.push("plugin starter prompts must exactly match their marketplace prompt contracts");
if (manifest.interface?.defaultPrompt?.some((prompt) => /meeting that just ended/i.test(prompt))) errors.push("unaccepted meeting-follow-up workflow must not be advertised as a My CRM starter prompt");
if (manifest.apps !== undefined || manifest.mcpServers !== undefined) errors.push("My CRM must not declare an app mapping or a second MCP connection");
if (product.schema_version !== "2" || product.application_name !== "my-crm") errors.push("My CRM must use the published BOS external-product dependency v2 identity");
if (product.connection_owner !== "bos" || JSON.stringify(product.dependency_products) !== JSON.stringify(["bos"]) || product.authentication !== "bos_dependency") errors.push("My CRM must depend on the BOS-owned connection");
if (product.authorization_scope_policy !== "ONE_ORGANIZATION_APPLICATION_INSTALLATION_ROLE_PER_GRANT") errors.push("My CRM must preserve the published BOS authorization scope policy");
try { validateJsonValueAgainstSchema(product, bocDependencySchema, "My CRM BOS dependency metadata"); } catch (error) { errors.push(error.message); }
if (bocDependencyProvenance.schema !== "my-crm.boc-contract-import/v1" || !/^[a-f0-9]{40}$/.test(bocDependencyProvenance.source_revision ?? "") || !/^\d+\.\d+\.\d+$/.test(bocDependencyProvenance.boc_version ?? "") || !/^[a-f0-9]{64}$/.test(bocDependencyProvenance.adapter_source_sha256 ?? "")) errors.push("BOC dependency contract provenance is invalid");
if (createHash("sha256").update(bocDependencySchemaBytes).digest("hex") !== bocDependencyProvenance.schema_sha256 || createHash("sha256").update(bocDependencyContractBytes).digest("hex") !== bocDependencyProvenance.contract_sha256) errors.push("BOC dependency contract provenance does not match the copied public artifacts");
if (bocDependencySchema.$id !== "bos://contracts/external-product-dependency/v2" || !bocDependencyContractBytes.toString("utf8").startsWith("# BOS-owned connection dependency contract v2\n")) errors.push("BOC dependency contract identity is invalid");
if (bocClientManifest.contract !== "bos-client-dependency-release/v1" || bocClientManifest.contract_id !== "bos-client-dependency" || bocClientManifest.contract_version !== "bos-client-dependency/v1" || bocClientManifest.owner !== "bos-operations-center" || bocClientManifest.authentication_impact !== "preserves-single-bos-connection") errors.push("BOC client dependency contract identity is invalid");
if (JSON.stringify(bocClientManifest.files?.map(({path: relative}) => relative).sort()) !== JSON.stringify([...bocClientFiles].sort())) errors.push("BOC client dependency manifest inventory is invalid");
if (JSON.stringify(bocClientManifest.executable_files?.map(({id, path: relative}) => [id, relative])) !== JSON.stringify(bocClientExecutables)) errors.push("BOC client dependency executable inventory is invalid");
const bocClientDirectoryEntries = await readdir(path.join(root, bocClientRoot), {withFileTypes: true});
if (JSON.stringify(bocClientDirectoryEntries.map(({name}) => name).sort()) !== JSON.stringify([...bocClientFiles, "manifest.json"].sort())) errors.push("BOC client dependency directory inventory is invalid");
for (const entry of bocClientDirectoryEntries) {
  const metadata = await lstat(path.join(root, bocClientRoot, entry.name));
  if (!entry.isFile() || entry.isSymbolicLink() || !metadata.isFile() || metadata.isSymbolicLink()) errors.push(`BOC client dependency directory entry is not a regular non-link file: ${entry.name}`);
}
if (bocClientProvenance.schema !== "my-crm.boc-client-dependency-import/v1" || bocClientProvenance.status !== "candidate_review" || !/^[a-f0-9]{40}$/.test(bocClientProvenance.source_revision ?? "") || !/^\d+\.\d+\.\d+$/.test(bocClientProvenance.boc_version ?? "") || !/^[a-f0-9]{64}$/.test(bocClientProvenance.archive_sha256 ?? "") || bocClientProvenance.bundle_sha256 !== bocClientManifest.bundle_sha256) errors.push("BOC client dependency import provenance is invalid");
if (await sha256File(path.join(root, `${bocClientRoot}/manifest.json`)) !== bocClientProvenance.manifest_sha256) errors.push("BOC client dependency manifest provenance is invalid");
for (const file of bocClientManifest.files ?? []) if (await sha256File(path.join(root, bocClientRoot, file.path)) !== file.sha256) errors.push(`BOC client dependency digest mismatch: ${file.path}`);
const bocClientBundleRows = [
  ...(bocClientManifest.files ?? []).map(({path: relative, sha256}) => `contract\0${relative}\0${sha256}`),
  ...(bocClientManifest.executable_files ?? []).map(({path: relative, sha256}) => `executable\0${relative}\0${sha256}`)
];
if ((bocClientManifest.executable_files ?? []).some(({sha256}) => !/^[a-f0-9]{64}$/.test(sha256)) || createHash("sha256").update(bocClientBundleRows.join("\n")).digest("hex") !== bocClientManifest.bundle_sha256) errors.push("BOC client dependency executable-bound bundle digest is invalid");
try {
  validateJsonValueAgainstSchema(await readJson(`${bocClientRoot}/discovered-operation.request.example.json`), await readJson(`${bocClientRoot}/discovered-operation.request.schema.json`), "BOC discovered-operation request example");
  validateJsonValueAgainstSchema(await readJson(`${bocClientRoot}/discovered-operation.response.example.json`), await readJson(`${bocClientRoot}/discovered-operation.response.schema.json`), "BOC discovered-operation response example");
  validateJsonValueAgainstSchema(await readJson(`${bocClientRoot}/shared-cache.request.example.json`), await readJson(`${bocClientRoot}/shared-cache.request.schema.json`), "BOC shared-cache request example");
  validateJsonValueAgainstSchema(await readJson(`${bocClientRoot}/shared-cache.results.example.json`), await readJson(`${bocClientRoot}/shared-cache.results.schema.json`), "BOC shared-cache result example");
} catch (error) { errors.push(error.message); }
const serviceStatus = bosServiceJourneyProvenance.artifact_status;
const serviceDeploymentValid = serviceStatus === "candidate_un_deployed"
  ? bosServiceJourneyProvenance.deployed_revision === null && bosServiceJourneyProvenance.image_digest === null
  : serviceStatus === "deployed_staging" && /^lead-director-backend-[a-z0-9-]+$/.test(bosServiceJourneyProvenance.deployed_revision ?? "") && /^sha256:[a-f0-9]{64}$/.test(bosServiceJourneyProvenance.image_digest ?? "");
if (bosServiceJourneyProvenance.schema !== "my-crm.bos-service-consumer-import/v1" || !serviceDeploymentValid || !/^[a-f0-9]{40}$/.test(bosServiceJourneyProvenance.source_revision ?? "") || !/^[a-f0-9]{64}$/.test(bosServiceJourneyProvenance.archive_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(bosServiceJourneyProvenance.bundle_sha256 ?? "")) errors.push("BOS Service consumer import provenance is invalid");
if (bosServiceSourceProvenance.artifact_status !== serviceStatus || bosServiceSourceProvenance.source_revision !== bosServiceJourneyProvenance.source_revision || bosServiceSourceProvenance.deployed_revision !== bosServiceJourneyProvenance.deployed_revision || bosServiceSourceProvenance.deployed_image_digest !== bosServiceJourneyProvenance.image_digest || bosServiceSourceProvenance.embedded_bundle_sha256 !== bosServiceJourneyProvenance.bundle_sha256) errors.push("BOS Service source provenance does not match the imported artifact");
for (const relative of bosServiceJourneyFiles.filter((name) => !["PROVENANCE.json"].includes(name))) if (await sha256File(path.join(root, bosServiceJourneyRoot, relative)) !== await sha256File(path.join(root, "contracts/bos/lead-director/v1", relative))) errors.push(`BOS Service consumer digest mismatch: ${relative}`);
try {
  const schema = await readJson(`${bosServiceJourneyRoot}/journey.client-action-required.schema.json`);
  const example = await readJson(`${bosServiceJourneyRoot}/journey.client-action-required.example.json`);
  validateJsonValueAgainstSchema(example, schema, "BOS Service client_action_required example");
  validateCrmResolutionEnvelope(example);
} catch (error) { errors.push(error.message); }
for (const key of ["resource_url", "oauth", "token", "grant", "session", "credential", "mcp_group_name", "mcp_server_name", "codex_mcp_startup_timeout_sec", "codex_mcp_tool_timeout_sec"]) if (product[key] !== undefined) errors.push(`My CRM product metadata must not declare ${key}`);
const handoff = product.authentication_handoff;
if (handoff?.authentication_manager !== "bos" || handoff?.credential_lifecycle_owner !== "host" || handoff?.authorization_enforcement_owner !== "bos-service" || handoff?.delegation_policy !== "AUTOMATIC") errors.push("BOS authentication delegation metadata is invalid");
if (handoff?.readiness_result?.representation !== "AUTHENTICATION_READINESS_ONLY" || handoff?.readiness_result?.authority_data !== "EXCLUDED") errors.push("Authentication handoff must return readiness without authority data");
if (marketplace.name !== "my-crm-local" || marketplace.plugins?.length !== 1) errors.push("Local marketplace identity is invalid");
const marketplacePlugin = marketplace.plugins?.[0];
if (marketplacePlugin?.name !== "my-crm" || marketplacePlugin?.source?.source !== "local" || marketplacePlugin?.source?.path !== "./dist/my-crm") errors.push("Local marketplace must install the built My CRM release candidate");
if (marketplacePlugin?.policy?.installation !== "AVAILABLE" || marketplacePlugin?.policy?.authentication !== "ON_USE") errors.push("Local marketplace policy is invalid");

try {
  const request = await readJson("contracts/bos/lead-director/v1/describe.request.example.json");
  validateApplicationDiscovery(await readJson("contracts/bos/lead-director/v1/app.describe.example.json"));
  validateDescribeResponse(await readJson("contracts/bos/lead-director/v1/describe.response.example.json"), request.operations);
  const releaseManifestPath = path.join(root, "contracts/bos/lead-director/v1/manifest.json");
  const releaseManifestContent = await readFile(releaseManifestPath);
  const release = JSON.parse(releaseManifestContent);
  const provenance = await readJson("contracts/bos/lead-director/import-provenance.json");
  if (provenance.schema !== "my-crm.bos-contract-import/v1" || !/^[a-f0-9]{64}$/.test(provenance.archive_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(provenance.manifest_sha256 ?? "") || !/^[a-f0-9]{64}$/.test(provenance.bundle_sha256 ?? "")) errors.push("BOS public contract import provenance is invalid");
  if (provenance.source_revision === null) {
    if (!/^[a-f0-9]{40}$/.test(provenance.consumer_import_commit ?? "")) errors.push("Legacy BOS contract provenance must identify its consumer import commit");
  } else if (!/^[a-f0-9]{40}$/.test(provenance.source_revision ?? "") || provenance.consumer_import_commit !== undefined) errors.push("Imported BOS contract provenance must identify exactly one source revision");
  if (createHash("sha256").update(releaseManifestContent).digest("hex") !== provenance.manifest_sha256 || release.bundle_sha256 !== provenance.bundle_sha256) errors.push("BOS public contract manifest does not match import provenance");
  if (release.contract !== "bos-public-contract-release/v1" || release.contract_id !== "lead-director-describe" || release.contract_version !== "lead-director-describe/v1" || release.owner !== "bos" || release.auth_impact !== "owner-approved-auth-adjacent-context-selection" || release.preserved_auth_contract !== "oauth-login-token-grant-callback-session-unchanged") errors.push("BOS public contract release provenance is invalid");
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
  const journeyFixture = await readJson("tests/fixtures/bos/journey/awaiting-client.crm.json");
  buildUpdateRequest(await readJson("examples/crm/targeted-update.json"));
  createConceptualCustomer(conceptualCustomer);
  buildCrmContribution(journeyContribution);
  validateCrmInstructionEnvelope(journeyFixture);
  validateJsonSchema(await readJson("contracts/my-crm/v1/live-acceptance-response.schema.json"), "live acceptance response schema");
  const marketplacePromptSchema = await readJson("contracts/my-crm/v1/marketplace-prompt-contracts.schema.json");
  validateJsonSchema(marketplacePromptSchema, "marketplace prompt contracts schema");
  validateJsonValueAgainstSchema(marketplacePromptContracts, marketplacePromptSchema, "marketplace prompt contracts");
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
  "contracts/bos/lead-director/import-provenance.json",
  "contracts/my-crm/v1/conceptual-customer.schema.json",
  "contracts/my-crm/v1/crm-journey-contribution.schema.json",
  "contracts/my-crm/v1/release-dependencies.json",
  "contracts/my-crm/v1/live-acceptance-response.schema.json",
  "contracts/my-crm/v1/marketplace-prompt-contracts.json",
  "contracts/my-crm/v1/marketplace-prompt-contracts.schema.json",
  bocDependencySchemaPath,
  bocDependencyContractPath,
  bocDependencyProvenancePath,
  ...bocClientFiles.map((file) => `${bocClientRoot}/${file}`),
  `${bocClientRoot}/manifest.json`,
  bocClientProvenancePath,
  ...bosServiceJourneyFiles.map((file) => `${bosServiceJourneyRoot}/${file}`),
  bosServiceJourneyProvenancePath,
  "tests/fixtures/bos/journey/awaiting-client.crm.json"
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
if (skillNames.length !== 8) errors.push("My CRM must package exactly eight source-first skills");
for (const name of skillNames) {
  const content = await readFile(path.join(skillsRoot, name, "SKILL.md"), "utf8");
  if (!content.startsWith("---\nname:")) errors.push(`${name} has invalid skill frontmatter`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else console.log("Public contracts and plugin package are valid.");
