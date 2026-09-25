import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {BosContractClient} from "../src/bos/client.mjs";
import {buildSearchRequest, buildUpdateRequest, createConceptualCustomer} from "../src/crm/operations.mjs";
import {validateFederatedResult, validateOrderedMutationResult} from "../src/crm/results.mjs";
import {startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

test("client begins with one BOS discovery URL and executes only the advertised search contact", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  const described = await client.describe(["search"]);
  const request = buildSearchRequest({text: "Synthetic Person"});
  const response = await client.execute(described.operations[0].operation, request);
  const result = validateFederatedResult(response.body, described.operations[0]);
  assert.equal(service.discoveryUrl.endsWith("/discovery"), true);
  assert.equal(result.source_results[0].records[0].display_name, "Synthetic Person");
  assert.deepEqual(service.calls.map(({url}) => url), ["/discovery", "/synthetic/organizations/synthetic/describe", "/synthetic/organizations/synthetic/operations/search"]);
  assert.equal(service.calls[2].body.source, undefined);
});

test("the same client follows changed routes and schemas returned by a second discovery service", async (context) => {
  const service = await startSyntheticBosService({variant: "beta"});
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  await client.describe(["search"]);
  await client.execute("search", {text: "Synthetic Person"});
  assert.equal(service.calls.at(-1).url, "/synthetic/organizations/synthetic/operations/search-v2");
  await assert.rejects(client.execute("search", {text: "x".repeat(513)}), /does not satisfy its schema/);
});

test("discovered update semantics preserve explicit targets and ordered outcomes", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  const described = await client.describe(["update"]);
  const request = buildUpdateRequest(service.documents.examples.update.request);
  const response = await client.execute("update", request);
  assert.equal(validateOrderedMutationResult(response.body, request.targets, described.operations[0]).outcomes[0].status, "updated");
});

test("client-owned conceptual reconciliation preserves every discovered source record", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  const description = (await client.describe(["search"])).operations[0];
  const result = validateFederatedResult((await client.execute("search", {text: "Synthetic Person"})).body, description);
  const records = result.source_results.flatMap(({source, records: values}) => values.map((record) => ({source, record})));
  const conceptual = createConceptualCustomer({records, evidence: [{kind: "synthetic"}], confidence: "bounded", conflicts: [], uncertainty: "Source records remain distinct."});
  assert.deepEqual(conceptual.records, records);
});

test("every marketplace starter prompt resolves through current discovery as a read", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const manifest = JSON.parse(await readFile(new URL("../plugins/my-crm/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const promptContracts = JSON.parse(await readFile(new URL("../contracts/my-crm/v1/marketplace-prompt-contracts.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.interface.defaultPrompt, promptContracts.prompts.map(({text}) => text));
  for (const prompt of promptContracts.prompts) {
    const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
    const operation = (await client.describe([prompt.operation])).operations[0];
    assert.equal(operation.effect, "read");
    await client.execute(operation.operation, {text: "Synthetic Person"});
  }
});
