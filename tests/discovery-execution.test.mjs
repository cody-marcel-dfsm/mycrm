import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {authenticationCondition, BosContractClient, BosContractError} from "../src/bos/client.mjs";
import {startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

test("all declared authentication conditions delegate to BOS", async () => {
  const product = JSON.parse(await readFile(new URL("../plugins/my-crm/.bos-product.json", import.meta.url), "utf8"));
  for (const code of product.authentication_handoff.recognized_condition_categories) assert.ok(authenticationCondition({code}));
  assert.equal(authenticationCondition({status: 403, code: "PERMISSION_DENIED"}), null);
});

test("client passes the exact current discovered contact to the BOS connection", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const calls = [];
  const bos = {...service.bos, invokeDiscoveredOperation: async (contact, payload) => { calls.push({contact: structuredClone(contact), payload}); return service.bos.invokeDiscoveredOperation(contact, payload); }};
  const client = new BosContractClient({discovery: service.discovery, bos});
  const operation = (await client.describe(["search"])).operations[0];
  await client.execute("search", {text: "Synthetic Person"});
  assert.deepEqual(calls[0].contact, operation);
});

test("invalid transport envelopes and undiscovered operations fail closed", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: {}, headers: {authorization: "private"}})}});
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "TRANSPORT_FAILURE");
  await assert.rejects(client.execute("unadvertised", {}), (error) => error instanceof BosContractError && error.code === "OPERATION_UNAVAILABLE");
});

test("authentication recovery refreshes discovery and retries Describe once", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let attempts = 0;
  let refreshes = 0;
  const discovery = {...service.discovery, refresh: async () => { refreshes += 1; return service.discovery.refresh(); }, describe: async (payload) => {
    attempts += 1;
    if (attempts === 1) { const error = new Error("private"); error.code = "MCP_SESSION_CLOSED"; error.resource = service.discoveryUrl; throw error; }
    return service.discovery.describe(payload);
  }};
  const recoveries = [];
  const client = new BosContractClient({discovery, bos: {...service.bos, recoverAuthentication: async (request) => { recoveries.push(request); return {status: "READY"}; }}});
  assert.equal((await client.describe(["search"])).operations[0].operation, "search");
  assert.equal(refreshes, 1);
  assert.equal(recoveries[0].resource, service.discoveryUrl);
});

test("discovery schema changes invalidate stale descriptions", async (context) => {
  const first = await startSyntheticBosService({variant: "alpha"});
  const second = await startSyntheticBosService({variant: "beta"});
  context.after(first.close); context.after(second.close);
  let current = first;
  const discovery = {read: () => current.discovery.read(), refresh: () => current.discovery.refresh(), describe: (payload) => current.discovery.describe(payload)};
  const client = new BosContractClient({discovery, bos: first.bos});
  await client.describe(["search"]);
  current = second;
  await client.refreshDiscovery();
  assert.throws(() => client.getDescription("search"), /has not been described/);
});
