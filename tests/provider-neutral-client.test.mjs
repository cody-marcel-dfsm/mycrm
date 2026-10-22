import assert from "node:assert/strict";
import test from "node:test";

import {CrmCacheMaintenanceError, ProviderNeutralCrmClient} from "../src/crm/client.mjs";
import {createSyntheticDocuments} from "./support/synthetic-bos-service.mjs";

const {describe: described, examples} = createSyntheticDocuments();
const descriptions = new Map(described.operations.map((operation) => [operation.operation, operation]));

function fixtureBos() {
  const calls = [];
  return {
    calls,
    verifyExecutionIntent: async () => true,
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
  const action = {verb: "state", method: "GET", href: "/bos/state/public", payload_schema: null};
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
  bos.execute = async () => ({status: 503, body: {error: {code: "source_temporarily_unavailable"}}});
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
  await assert.rejects(client.observeCreate({verb: "state", method: "GET", href: "/bos/state/public", payload_schema: null}, {source: examples.create.request.source}), /does not match the requested source/);
  assert.deepEqual(invalidations, []);
});

function partialMutation() {
  const request = structuredClone(examples.update.request);
  const secondSource = {...request.targets[0].source, plugin: "synthetic-secondary"};
  request.targets.push({source: secondSource, record: {selector: "synthetic-second"}, changes: {display_name: "Synthetic Updated"}});
  const result = {...structuredClone(examples.update.response), complete: false, retry_after_seconds: 1,
    action: {verb: "state", method: "GET", href: "/bos/synthetic/state", payload_schema: null}};
  result.outcomes.push({...structuredClone(result.outcomes[0]), source: secondSource, record: {selector: "synthetic-second"},
    status: "in_progress", receipt: null, readback: null, error: null});
  return {request, result};
}

test("confirmed partial commits are handed off before returning pending outcomes", async () => {
  const {request, result} = partialMutation(), bos = fixtureBos(), handoffs = [];
  bos.execute = async () => ({status: 202, body: structuredClone(result)});
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => handoffs.push(event)});
  assert.deepEqual(await client.update(request), result);
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0].result, result);
  assert.deepEqual(handoffs[0].sources, [request.targets[0].source]);
  assert.deepEqual(handoffs[0].confirmations, [{source: result.outcomes[0].source, record: result.outcomes[0].record, receipt: result.outcomes[0].receipt}]);
});

test("state observations hand off only newly confirmed receipts and ignore repeated confirmations", async () => {
  const {request, result} = partialMutation(), bos = fixtureBos(), handoffs = [];
  bos.execute = async () => ({status: 202, body: structuredClone(result)});
  let current = result;
  bos.invokeStateAction = async () => ({status: current.complete ? 200 : 202, body: structuredClone(current)});
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => handoffs.push(event)});
  await client.update(request);
  await client.observeUpdate(result.action, {targets: request.targets});
  const terminal = structuredClone(result);
  terminal.complete = true; delete terminal.action; delete terminal.retry_after_seconds;
  terminal.outcomes[0].status = "replayed";
  terminal.outcomes[0].receipt = Object.fromEntries(Object.entries(terminal.outcomes[0].receipt).reverse());
  terminal.outcomes[1] = {...structuredClone(terminal.outcomes[0]), source: request.targets[1].source,
    record: request.targets[1].record, status: "updated", receipt: {service_id: "synthetic-second-receipt"}};
  current = terminal;
  await client.observeUpdate(result.action, {targets: request.targets});
  await client.observeUpdate(result.action, {targets: request.targets});
  assert.equal(handoffs.length, 2);
  assert.deepEqual(handoffs[1].sources, [request.targets[1].source]);
  assert.deepEqual(handoffs[1].confirmations.map(({record}) => record), [request.targets[1].record]);
});

test("terminal partial failures hand off successful targets and retain public failures", async () => {
  const {request, result} = partialMutation(), bos = fixtureBos(), handoffs = [];
  result.complete = true; delete result.action; delete result.retry_after_seconds;
  result.outcomes[1].status = "failed";
  result.outcomes[1].error = {code: "source_temporarily_unavailable", message: "Synthetic failure", retryable: true, correlation_id: "synthetic-failure", details: []};
  bos.execute = async () => ({status: 200, body: structuredClone(result)});
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => handoffs.push(event)});
  assert.deepEqual(await client.update(request), result);
  assert.equal(handoffs[0].confirmations.length, 1);
  assert.deepEqual(handoffs[0].sources, [request.targets[0].source]);
});

test("maintenance failure preserves results and retries only cache work before later reads", async () => {
  const {request, result} = partialMutation(), bos = fixtureBos();
  let writes = 0, attempts = 0, failing = true;
  bos.execute = async operation => { if (operation === "update") writes++; return {status: 202, body: structuredClone(result)}; };
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => {
    attempts++; event.result.outcomes[0].status = "failed";
    if (failing) throw new Error("synthetic-private-maintenance-detail");
  }});
  await assert.rejects(client.update(request), error => {
    assert.ok(error instanceof CrmCacheMaintenanceError);
    assert.deepEqual(error.result, result);
    assert.equal(error.reason, "callback_failed");
    assert.equal(error.pendingConfirmations, 1);
    assert.equal(JSON.stringify(error).includes("synthetic-private-maintenance-detail"), false);
    error.result.outcomes.length = 0;
    return true;
  });
  await assert.rejects(client.search(examples.search.request), error => error.code === "CACHE_MAINTENANCE_INCOMPLETE" && error.result.outcomes.length === 2);
  assert.equal(bos.calls.length, 1); // Only the original Describe reached the BOS fixture.
  assert.equal(writes, 1);
  failing = false;
  assert.deepEqual(await client.retryCacheMaintenance(), {complete: true, pendingConfirmations: 0});
  await client.retryCacheMaintenance();
  assert.equal(attempts, 3);
  assert.equal(writes, 1);
});

test("pending handoffs retain original scope and completed deduplication resets for a new scope", async () => {
  const bos = fixtureBos(), handoffs = [];
  let scope = "synthetic-first", failing = true;
  bos.captureExecutionScope = async () => { const captured = scope; return async () => scope === captured; };
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => {
    handoffs.push(event); if (failing) throw new Error("Synthetic cache unavailable");
  }});
  await assert.rejects(client.update(examples.update.request), CrmCacheMaintenanceError);
  scope = "synthetic-second";
  await assert.rejects(client.retryCacheMaintenance(), error => error.reason === "scope_changed");
  assert.equal(handoffs.length, 1);
  scope = "synthetic-first"; failing = false;
  await client.retryCacheMaintenance();
  scope = "synthetic-second";
  await client.update(examples.update.request);
  assert.equal(handoffs.length, 3);
});

test("concurrent observations and repeated create receipts each hand off a confirmation once", async () => {
  const bos = fixtureBos(), handoffs = [];
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => { await Promise.resolve(); handoffs.push(event); }});
  const action = {verb: "state", method: "GET", href: "/bos/synthetic/state", payload_schema: null};
  await Promise.all([client.observeUpdate(action, {targets: examples.update.request.targets}), client.observeUpdate(action, {targets: examples.update.request.targets})]);
  assert.equal(handoffs.length, 1);
  await client.create(examples.create.request);
  bos.invokeStateAction = async () => ({status: 200, body: {...structuredClone(examples.create.response), status: "replayed"}});
  await client.observeCreate(action, {source: examples.create.request.source});
  assert.equal(handoffs.length, 2);
});

test("unknown pending targets create no cache work until a confirmed receipt arrives", async () => {
  const {request, result} = partialMutation(), bos = fixtureBos(), handoffs = [];
  const pending = structuredClone(result);
  pending.outcomes[0] = {...pending.outcomes[0], status: "in_progress", readback: null, receipt: null};
  bos.execute = async () => ({status: 202, body: structuredClone(pending)});
  bos.invokeStateAction = async () => ({status: 202, body: structuredClone(result)});
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async event => handoffs.push(event)});
  assert.deepEqual(await client.update(request), pending);
  assert.equal(handoffs.length, 0);
  assert.deepEqual(await client.observeUpdate(pending.action, {targets: request.targets}), result);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].confirmations.length, 1);
});

test("scope changes during a callback preserve pending maintenance for original-scope retry", async () => {
  const bos = fixtureBos(); let scope = "synthetic-first", calls = 0;
  bos.captureExecutionScope = async () => { const captured = scope; return async () => scope === captured; };
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async () => {
    calls++; if (calls === 1) scope = "synthetic-second";
  }});
  await assert.rejects(client.update(examples.update.request), error => error.reason === "scope_changed" && error.result.outcomes[0].status === "updated");
  scope = "synthetic-first";
  await client.retryCacheMaintenance();
  assert.equal(calls, 2);
  assert.equal(bos.calls.filter(([kind]) => kind === "execute").length, 1);
});

test("callback-owned error types cannot replace the confirmed mutation result", async () => {
  const bos = fixtureBos();
  const client = new ProviderNeutralCrmClient({bos, onMutationComplete: async () => {
    throw new CrmCacheMaintenanceError({operation: "synthetic-other", result: {}, pendingConfirmations: 0, reason: "synthetic-other"});
  }});
  await assert.rejects(client.update(examples.update.request), error => error instanceof CrmCacheMaintenanceError
    && error.operation === "update" && error.reason === "callback_failed"
    && JSON.stringify(error.result) === JSON.stringify(examples.update.response));
});
