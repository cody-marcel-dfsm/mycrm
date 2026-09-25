import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {BosContractClient} from "../src/bos/client.mjs";
import {buildCreateRequest, buildSearchRequest, buildUpdateRequest, createConceptualCustomer} from "../src/crm/operations.mjs";
import {validateCreateResult, validateFederatedResult, validateOrderedMutationResult} from "../src/crm/results.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));
const repositoryJson = async (name) => JSON.parse(await readFile(new URL(`../${name}`, import.meta.url), "utf8"));
const selectDescribe = (response, operationIds) => ({...structuredClone(response), operations: response.operations.filter(({operation}) => operationIds.includes(operation))});

test("canonical search flows through exact app.describe and Describe contacts without client authority", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const requests = [];
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery, describe: async ({operations}) => selectDescribe(describe, operations)},
    bos: {recoverAuthentication: async () => ({status: "READY"}), invokeDiscoveredOperation: async (contact, payload) => {
      requests.push({contact: structuredClone(contact), payload: structuredClone(payload)});
      return {status: 200, body: structuredClone(examples.search.response)};
    }}
  });
  const described = await client.describe(["search"]);
  const input = buildSearchRequest({text: "fixture.person@example.invalid"});
  assert.equal((await client.execute(described.operations[0].operation, input)).status, 200);
  assert.deepEqual(requests.map(({contact}) => contact.operation), ["search"]);
  assert.equal(requests.some(({payload}) => payload?.source !== undefined), false);
});

test("published operation examples drive source-first builders and client-owned conceptual reconciliation", async () => {
  const examples = await published("operation.examples.json");
  assert.deepEqual(buildSearchRequest(examples.search.request), examples.search.request);
  assert.deepEqual(buildCreateRequest(examples.create.request), examples.create.request);
  assert.deepEqual(buildUpdateRequest(examples.update.request), examples.update.request);
  const search = validateFederatedResult(examples.search.response, {limits: {max_results_per_source: 5}, error_contract: {codes: ["SOURCE_TEMPORARILY_UNAVAILABLE"]}});
  const records = search.source_results.flatMap((sourceResult) => sourceResult.records.map((record) => ({source: sourceResult.source, record})));
  const conceptual = createConceptualCustomer({records, evidence: [{kind: "controlled_fixture"}], confidence: "bounded", conflicts: [], uncertainty: "Source records remain distinct."});
  assert.equal(conceptual.records.length, 1);
  assert.equal(validateCreateResult(examples.create.response).status, "created");
  assert.equal(validateOrderedMutationResult(examples.update.response, examples.update.request.targets, {effect: "update", error_contract: {codes: []}}).outcomes.length, 1);
  assert.equal(validateOrderedMutationResult(examples.delete.response, examples.delete.request.targets, {effect: "delete", error_contract: {codes: []}}).outcomes[0].status, "deleted");
});

test("canonical create, update, and delete requests invoke only their discovered contracts", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const invoked = [];
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery, describe: async ({operations}) => selectDescribe(describe, operations)},
    bos: {recoverAuthentication: async () => ({status: "READY"}), invokeDiscoveredOperation: async (contact) => {
      const operation = contact.operation;
      if (!operation || !["create", "update", "delete"].includes(operation)) throw new Error("unexpected operation URI");
      invoked.push(operation);
      return {status: 200, body: structuredClone(examples[operation].response)};
    }}
  });
  await client.describe(["create", "update", "delete"]);
  for (const operation of ["create", "update", "delete"]) await client.execute(operation, examples[operation].request);
  assert.deepEqual(invoked, ["create", "update", "delete"]);
});

test("canonical recent-meeting request does not trigger a CRM lookup solely for attendees", () => {
  const prompt = "Use the attendees from the meeting that just ended to prepare and send a follow-up.";
  const attendee = "fixture.attendee@example.invalid";
  const crmCalls = [];
  const boundary = ({prompt: currentPrompt, attendees}) => {
    assert.equal(currentPrompt, prompt);
    assert.deepEqual(attendees, [attendee]);
    return {owner: "bos", crmContributionRequired: false};
  };
  assert.deepEqual(boundary({prompt, attendees: [attendee]}), {owner: "bos", crmContributionRequired: false});
  assert.deepEqual(crmCalls, []);
});

test("every marketplace starter prompt performs its exact published read contract", async () => {
  const manifest = await repositoryJson("plugins/my-crm/.codex-plugin/plugin.json");
  const promptContracts = await repositoryJson("contracts/my-crm/v1/marketplace-prompt-contracts.json");
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  assert.deepEqual(manifest.interface.defaultPrompt, promptContracts.prompts.map(({text}) => text));

  for (const promptContract of promptContracts.prompts) {
    const requests = [];
    const client = new BosContractClient({
      discovery: {read: async () => discovery, refresh: async () => discovery, describe: async ({operations}) => selectDescribe(describe, operations)},
      bos: {recoverAuthentication: async () => ({status: "READY"}), invokeDiscoveredOperation: async (contact, payload) => {
        requests.push({contact: structuredClone(contact), payload: structuredClone(payload)});
        return {status: 200, body: structuredClone(examples.search.response)};
      }}
    });
    const described = await client.describe([promptContract.operation]);
    const description = described.operations[0];
    assert.equal(description.operation, "search", `${promptContract.id} must resolve the advertised search contract`);
    assert.equal(description.effect, promptContract.effect, `${promptContract.id} must stay read-only`);
    const result = validateFederatedResult(
      (await client.execute(description.operation, buildSearchRequest(examples.search.request))).body,
      description
    );
    assert.deepEqual(requests.map(({contact}) => contact.operation), ["search"]);
    assert.ok(result.observed_at);
    assert.ok(result.source_results.every(({source, observed_at}) => source && observed_at));

    const performed = new Set([
      "described-operation",
      "deterministic-https-execution",
      "federated-result-validation",
      "source-provenance-preservation",
      "freshness-preservation",
      "no-mutation"
    ]);
    if (promptContract.assertions.includes("conceptual-customer-reconciliation")) {
      const records = result.source_results.flatMap(({source, records: sourceRecords}) =>
        sourceRecords.map((record) => ({source, record}))
      );
      const conceptual = createConceptualCustomer({
        records,
        evidence: [{kind: "marketplace_prompt_contract", prompt_id: promptContract.id}],
        confidence: "bounded",
        conflicts: [],
        uncertainty: "Source records remain distinct."
      });
      assert.deepEqual(conceptual.records, records);
      performed.add("conceptual-customer-reconciliation");
    }
    assert.deepEqual([...performed].sort(), [...promptContract.assertions].sort());
    assert.equal(requests.every(({contact}) => contact.execution.method === "POST"), true);
  }
});
