import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {BosContractClient, BosContractError} from "../src/bos/client.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));
const selectDescribe = (response, operationIds) => ({...structuredClone(response), operations: response.operations.filter(({operation}) => operationIds.includes(operation))});

test("client consumes canonical app.describe and invokes its exact search route template", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const calls = [];
  const client = new BosContractClient({
    discovery: {read: async () => structuredClone(discovery), refresh: async () => structuredClone(discovery)},
    http: {request: async (request) => {
      calls.push(structuredClone(request));
      if (request.uri === discovery.describe.uri) return {status: 200, body: selectDescribe(describe, request.body.operations)};
      if (request.uri === describe.operations[0].execution.uri) return {status: 200, body: structuredClone(examples.search.response)};
      throw new Error("unexpected URI");
    }},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  const contract = await client.describe(["search"]);
  const result = await client.execute("search", {text: "cody.marcel@dfsm.ai"});
  assert.equal(contract.operations[0].operation, "search");
  assert.equal(result.status, 200);
  assert.deepEqual(calls.map(({uri}) => uri), [discovery.describe.uri, describe.operations[0].execution.uri]);
  assert.equal(calls.some(({headers}) => headers?.authorization), false);
});

test("authentication delegates only condition/resource, refreshes, redescribes, and resumes once", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  let executions = 0;
  let refreshes = 0;
  let recoveries = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => { refreshes += 1; return discovery; }},
    http: {request: async ({uri, body}) => {
      if (uri === discovery.describe.uri) return {status: 200, body: selectDescribe(describe, body.operations)};
      executions += 1;
      if (executions === 1) return {status: 401, body: {error: {code: "AUTHENTICATION_REQUIRED"}}};
      return {status: 200, body: structuredClone(examples.search.response)};
    }},
    bos: {recoverAuthentication: async (request) => { recoveries += 1; assert.deepEqual(Object.keys(request).sort(), ["condition", "resource"]); return {status: "READY"}; }}
  });
  await client.describe(["search"]);
  assert.equal((await client.execute("search", {text: "person"})).status, 200);
  assert.equal(recoveries, 1);
  assert.equal(refreshes, 1);
  assert.equal(executions, 2);
});

test("HTTP authentication recovery preserves the affected protected resource", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const recoveries = [];
  let executions = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri, body}) => {
      if (uri === discovery.describe.uri) return {status: 200, body: selectDescribe(describe, body.operations)};
      executions += 1;
      if (executions === 1) return {status: 401, resource: "https://fixture.invalid/protected-resource", body: {error: {code: "AUTHENTICATION_REQUIRED"}}};
      return {status: 200, body: structuredClone(examples.search.response)};
    }},
    bos: {recoverAuthentication: async (request) => { recoveries.push(request); return {status: "READY"}; }}
  });
  await client.describe(["search"]);
  await client.execute("search", {text: "person"});
  assert.deepEqual(recoveries, [{condition: "AUTHENTICATION_REQUIRED", resource: "https://fixture.invalid/protected-resource"}]);
});

test("client distinguishes absent and published not_available operations", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({body}) => ({status: 200, body: selectDescribe(describe, body.operations)})},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await assert.rejects(client.describe(["read"]), (error) => error instanceof BosContractError && error.code === "OPERATION_UNAVAILABLE");
  await client.describe(["calendar_read_event"]);
  await assert.rejects(client.execute("calendar_read_event", {}), (error) => error instanceof BosContractError && error.code === "OPERATION_UNAVAILABLE");
});

test("client never invokes a selected source whose published availability is non-ready", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const unavailable = selectDescribe(describe, ["search"]);
  unavailable.operations[0].sources[0].availability = "configuration_required";
  let executions = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri}) => {
      if (uri === discovery.describe.uri) return {status: 200, body: unavailable};
      executions += 1;
      return {status: 200, body: {records: []}};
    }},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error instanceof BosContractError && error.code === "OPERATION_NOT_READY");
  assert.equal(executions, 0);
});

test("ready source matching is semantic and independent of JSON key order", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const selected = describe.operations[0].sources[0].source;
  let executions = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri, body}) => {
      if (uri === discovery.describe.uri) return {status: 200, body: selectDescribe(describe, body.operations)};
      executions += 1;
      return {status: 200, body: structuredClone(examples.search.response)};
    }},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await client.describe(["search"]);
  await client.execute("search", {text: "person", source: {plugin: selected.plugin, platform: selected.platform, application: selected.application}});
  assert.equal(executions, 1);
});

test("authentication continuation is bounded to one BOS recovery", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  let recoveries = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri, body}) => uri === discovery.describe.uri ? {status: 200, body: selectDescribe(describe, body.operations)} : {status: 401, body: {error: {code: "AUTHENTICATION_REQUIRED"}}}},
    bos: {recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_FAILED");
  assert.equal(recoveries, 1);
});

test("BOSL descriptor changes invalidate cached descriptions", async () => {
  const first = await published("app.describe.example.json");
  const second = structuredClone(first);
  second.bosl.descriptor_etag = "c".repeat(64);
  const describe = await published("describe.response.example.json");
  let current = first;
  const client = new BosContractClient({
    discovery: {read: async () => current, refresh: async () => { current = second; return current; }},
    http: {request: async ({body}) => ({status: 200, body: selectDescribe(describe, body.operations)})},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await client.describe(["search"]);
  await client.refreshDiscovery();
  assert.throws(() => client.getDescription("search"), /not been described/);
  await client.describe(["search"]);
  assert.equal(client.getDescription("search").status, "described");
});

test("Describe authentication recovery refreshes once and retries exact task scope once", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  let describeCalls = 0;
  let recoveries = 0;
  let refreshes = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => { refreshes += 1; return discovery; }},
    http: {request: async ({body}) => {
      describeCalls += 1;
      if (describeCalls === 1) return {status: 401, body: {error: {code: "AUTHENTICATION_REQUIRED"}}};
      return {status: 200, body: selectDescribe(describe, body.operations)};
    }},
    bos: {recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }}
  });
  const result = await client.describe(["search"]);
  assert.deepEqual(result.operations.map(({operation}) => operation), ["search"]);
  assert.equal(describeCalls, 2);
  assert.equal(recoveries, 1);
  assert.equal(refreshes, 1);
});

test("a second thrown authentication failure is bounded and sanitized", async () => {
  const discovery = await published("app.describe.example.json");
  let recoveries = 0;
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async () => { const error = new Error("credential detail"); error.code = "INVALID_TOKEN"; throw error; }},
    bos: {recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }}
  });
  await assert.rejects(client.describe(["search"]), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_FAILED" && !error.message.includes("credential detail"));
  assert.equal(recoveries, 1);
});
