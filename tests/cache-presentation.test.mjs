import assert from "node:assert/strict";
import test from "node:test";

import { CrmCacheClient } from "../src/cache/client.mjs";
import { presentResult } from "../src/crm/presentation.mjs";

function adapter() {
  const entries = new Map();
  const calls = [];
  return {
    calls,
    read: async (key) => { calls.push(["read", key]); return entries.get(key) ?? null; },
    publish: async (key, value) => { calls.push(["publish", key]); entries.set(key, structuredClone(value)); },
    inspect: async (partition) => [...entries.entries()].filter(([key]) => key.startsWith(`${partition}:`)),
    invalidate: async (request) => { calls.push(["invalidate", request]); for (const key of [...entries.keys()]) if (key.startsWith(`${request.partition}:`)) entries.delete(key); }
  };
}

test("cache delegates storage to shared BOS cache and partitions by opaque current authority", async () => {
  const shared = adapter();
  let now = Date.parse("2026-09-19T16:00:00Z");
  const cache = new CrmCacheClient({adapter: shared, now: () => now, maxAgeMs: 60_000});
  const scope = {partition: "partition-a", descriptor: "descriptor-a", operation: "search", source: null, parameters: {text: "person"}};
  await cache.publish(scope, {complete: true, source_results: []});
  assert.equal((await cache.read(scope)).origin, "cached");
  assert.equal((await cache.read({...scope, partition: "partition-b"})), null);
  now += 60_001;
  assert.equal(await cache.read(scope), null);
  assert.ok(shared.calls.some(([method]) => method === "publish"));
  assert.ok(shared.calls.some(([method, request]) => method === "invalidate" && request.scope === "query"));
});

test("cache load uses a fresh shared entry and automatically refreshes a miss", async () => {
  const shared = adapter();
  const cache = new CrmCacheClient({adapter: shared, now: () => 1, maxAgeMs: 100});
  const scope = {partition: "p", descriptor: "d", operation: "o", source: null, parameters: {text: "person"}};
  let loads = 0;
  const first = await cache.load(scope, async () => { loads += 1; return {complete: true, source_results: []}; });
  const second = await cache.load(scope, async () => { loads += 1; return {complete: true, source_results: []}; });
  assert.equal(first.origin, "live");
  assert.equal(second.origin, "cached");
  assert.equal(loads, 1);
});

test("partial refresh cannot replace a complete cache entry", async () => {
  const shared = adapter();
  const cache = new CrmCacheClient({adapter: shared, now: () => 1, maxAgeMs: 100});
  const scope = {partition: "p", descriptor: "d", operation: "o", source: null, parameters: {}};
  await cache.publish(scope, {complete: true, source_results: []});
  await assert.rejects(cache.publish(scope, {complete: false, source_results: []}), /complete/);
  assert.equal((await cache.read(scope)).value.complete, true);
  await assert.rejects(cache.refresh(scope, async () => ({complete: false, source_results: []})), /complete/);
  assert.equal((await cache.read(scope)).value.complete, true);
});

test("cache maintenance exposes bounded query, source, dataset, and current-authority invalidation", async () => {
  const shared = adapter();
  const cache = new CrmCacheClient({adapter: shared, now: () => 1, maxAgeMs: 100});
  const scope = {partition: "p", descriptor: "d", operation: "o", source: null, parameters: {text: "person"}};
  await cache.invalidateQuery(scope);
  await cache.invalidateSource({partition: "p", source: {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source"}});
  assert.throws(() => cache.invalidateSource({partition: "p", source: {plugin: "fixture-source"}}), /source/);
  await cache.invalidateDataset({partition: "p", dataset: "crm-records"});
  await cache.invalidateCurrentAuthority("p");
  await cache.invalidateAfterMutation({
    partition: "p",
    sources: [
      {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source"},
      {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source"}
    ],
    datasets: ["crm-records", "crm-records"]
  });
  assert.deepEqual(shared.calls.filter(([method]) => method === "invalidate").map(([, request]) => request.scope), ["query", "source", "dataset", "authority", "source", "dataset"]);
});

test("cache keys accept only complete structured source references", async () => {
  const shared = adapter();
  const cache = new CrmCacheClient({adapter: shared, now: () => 1, maxAgeMs: 100});
  const invalid = {partition: "p", descriptor: "d", operation: "search", source: {plugin: "fixture-source"}, parameters: {text: "person"}};
  await assert.rejects(cache.publish(invalid, {complete: true}), /source/);
  await assert.rejects(cache.read(invalid), /source/);
  assert.throws(() => cache.invalidateQuery(invalid), /source/);
});

test("cache keys and values reject nested credentials, authority, and internal identifiers", async () => {
  const shared = adapter();
  const cache = new CrmCacheClient({adapter: shared, now: () => 1, maxAgeMs: 100});
  const base = {partition: "p", descriptor: "d", operation: "search", source: null, parameters: {text: "person"}};
  await assert.rejects(cache.publish({...base, parameters: {text: "person", access_token: "secret"}}, {complete: true}), /forbidden private key/);
  await assert.rejects(cache.publish({...base, coverage: {principal_context: "hidden"}}, {complete: true}), /forbidden private key/);
  await assert.rejects(cache.publish(base, {complete: true, nested: {internal_id: "hidden"}}), /forbidden private key/);
  assert.equal((await cache.publish(base, {complete: true, nested: {student_id: "student-public-42"}})).value.nested.student_id, "student-public-42");
  const unsafe = adapter();
  unsafe.read = async () => ({status: "complete", retrieved_at: "1970-01-01T00:00:00.001Z", retrieved_at_ms: 1, value: {complete: true, provider_error: "hidden"}});
  const unsafeCache = new CrmCacheClient({adapter: unsafe, now: () => 1, maxAgeMs: 100});
  assert.equal(await unsafeCache.read(base), null);
  assert.ok(unsafe.calls.some(([method, request]) => method === "invalidate" && request.scope === "query"));
});

test("cache reads reject malformed, inconsistent, or future freshness evidence", async () => {
  const scope = {partition: "p", descriptor: "d", operation: "search", source: null, parameters: {}};
  const entry = {status: "complete", retrieved_at: "not-a-date", retrieved_at_ms: 100, value: {complete: true}};
  const shared = adapter();
  shared.read = async () => structuredClone(entry);
  const cache = new CrmCacheClient({adapter: shared, now: () => 100, maxAgeMs: 100});
  assert.equal(await cache.read(scope), null);
  entry.retrieved_at = "1970-01-01T00:00:00.100Z";
  entry.retrieved_at_ms = 200;
  assert.equal(await cache.read(scope), null);
  entry.retrieved_at = "1970-01-01T00:00:00.200Z";
  assert.equal(await cache.read(scope), null);
  entry.retrieved_at = "1970-01-01T00:00:00.100Z";
  entry.retrieved_at_ms = 100;
  assert.equal((await cache.read(scope)).origin, "cached");
  shared.inspect = async () => [{value: {access_token: "hidden"}}];
  await assert.rejects(cache.inspect("p"), /forbidden private key/);
});

test("presentation labels origin, local freshness, provenance, coverage, conflicts, and usage truthfully", () => {
  const view = presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [], usage: {status: "unavailable"}}, {origin: "live", locale: "en-US", timeZone: "America/Denver"});
  assert.equal(view.origin, "live");
  assert.match(view.last_updated_local, /2026/);
  assert.deepEqual(view.usage, {status: "unavailable"});
  const organizationField = presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [{records: [{student_id: "student-public-42"}]}]}, {origin: "live", locale: "en-US", timeZone: "America/Denver"});
  assert.equal(organizationField.source_results[0].records[0].student_id, "student-public-42");
  assert.throws(() => presentResult({complete: true, observed_at: "2026-09-19", source_results: []}, {origin: "live", locale: "en-US", timeZone: "America/Denver"}), /timestamp/);
  assert.throws(() => presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [{records: [{internal_id: "hidden"}]}]}, {origin: "live", locale: "en-US", timeZone: "America/Denver"}), /forbidden private key/);
});
