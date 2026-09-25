import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {ProviderNeutralCrmClient} from "../src/crm/client.mjs";

const described = JSON.parse(await readFile(new URL("../contracts/bos/lead-director/v1/describe.response.example.json", import.meta.url), "utf8"));
const examples = JSON.parse(await readFile(new URL("../contracts/bos/lead-director/v1/operation.examples.json", import.meta.url), "utf8"));
const descriptions = new Map(described.operations.map((operation) => [operation.operation, operation]));

function fixtureBos() {
  const calls = [];
  return {
    calls,
    describe: async (operations) => { calls.push(["describe", operations]); return {operations: operations.map((operation) => descriptions.get(operation))}; },
    getDescription: (operation) => structuredClone(descriptions.get(operation)),
    execute: async (operation, request) => { calls.push(["execute", operation, request]); return {status: 200, body: structuredClone(examples[operation].response)}; },
    invokeStateAction: async (action) => { calls.push(["state", action]); return {status: 200, body: structuredClone(examples.update.response)}; }
  };
}

test("provider-neutral client composes discovery, exact requests, and public response validation", async () => {
  const bos = fixtureBos();
  const completed = [];
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async (value) => completed.push(value)});
  assert.deepEqual(await client.search(examples.search.request), examples.search.response);
  assert.deepEqual(await client.create(examples.create.request), examples.create.response);
  assert.deepEqual(await client.update(examples.update.request), examples.update.response);
  assert.deepEqual(await client.delete(examples.delete.request), examples.delete.response);
  assert.deepEqual(bos.calls.filter(([kind]) => kind === "describe").map(([, operations]) => operations), [["search"], ["create"], ["update"], ["delete"]]);
  assert.deepEqual(bos.calls.filter(([kind]) => kind === "execute").map(([, operation]) => operation), ["search", "create", "update", "delete"]);
  assert.deepEqual(completed.map(({operation}) => operation), ["create", "update", "delete"]);
});

test("provider-neutral client follows only returned bodyless mutation state actions", async () => {
  const bos = fixtureBos();
  const client = new ProviderNeutralCrmClient({bos});
  const action = {verb: "state", method: "GET", href: "/state/public", payload_schema: null};
  const result = await client.observeUpdate(action, {targets: examples.update.request.targets});
  assert.deepEqual(result, examples.update.response);
  assert.deepEqual(bos.calls, [["state", action]]);
});

test("provider-neutral client sends one ordered mutation across several explicit source records", async () => {
  const bos = fixtureBos();
  const secondSource = {platform: "bos", application: "lead-director", plugin: "crm-secondary"};
  const request = structuredClone(examples.update.request);
  request.targets.push({...structuredClone(request.targets[0]), source: secondSource, record: {selector: "opaque-2"}});
  const response = structuredClone(examples.update.response);
  response.outcomes.push({...structuredClone(response.outcomes[0]), source: secondSource, record: {selector: "opaque-2"}, readback: {...response.outcomes[0].readback, public_selector: "opaque-2"}});
  bos.execute = async (operation, input) => {
    bos.calls.push(["execute", operation, input]);
    return {status: 200, body: response};
  };
  const invalidations = [];
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async (value) => invalidations.push(value)});
  assert.deepEqual((await client.update(request)).outcomes.map(({source}) => source), [examples.update.request.targets[0].source, secondSource]);
  assert.deepEqual(bos.calls.find(([kind]) => kind === "execute").slice(1), ["update", request]);
  assert.deepEqual(invalidations[0].sources, request.targets.map(({source}) => source));
});

test("provider-neutral client fails closed on transport and contract drift", async () => {
  const bos = fixtureBos();
  const client = new ProviderNeutralCrmClient({bos});
  bos.execute = async () => ({status: 503, body: {error: {code: "SOURCE_TEMPORARILY_UNAVAILABLE"}}});
  await assert.rejects(client.search(examples.search.request), /successful public response/);
  bos.execute = async () => ({status: 200, body: {...examples.search.response, internal_id: "private"}});
  await assert.rejects(client.search(examples.search.request), /schema|unsupported field|additionalProperties/);
});

test("provider-neutral client rejects create results from a different source before cache invalidation", async () => {
  const bos = fixtureBos();
  const response = structuredClone(examples.create.response);
  response.source = {platform: "bos", application: "lead-director", plugin: "different-valid-source"};
  bos.execute = async () => ({status: 200, body: response});
  bos.invokeStateAction = async () => ({status: 200, body: response});
  const invalidations = [];
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async (value) => invalidations.push(value)});
  await assert.rejects(client.create(examples.create.request), /does not match the requested source/);
  await assert.rejects(client.observeCreate({verb: "state", method: "GET", href: "/state/public", payload_schema: null}, {source: examples.create.request.source}), /does not match the requested source/);
  assert.deepEqual(invalidations, []);
});
