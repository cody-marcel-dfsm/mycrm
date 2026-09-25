import assert from "node:assert/strict";
import test from "node:test";

import {CrmCacheClient} from "../src/cache/client.mjs";
import {presentPublicFailure, presentResult} from "../src/crm/presentation.mjs";

const source = {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source"};
const scope = {
  source,
  operation: "search",
  resource_kind: "crm-records",
  selector: {text: "person"},
  descriptor_token: "descriptor-a",
  window: {from: "2026-09-24T15:00:00Z", through: "2026-09-24T16:00:00Z"},
  refresh_through: "2026-09-24T16:00:00Z",
  freshness_policy: {max_age_seconds: 300, allow_stale_on_error: false}
};

function plan(state = "current", extra = {}) {
  const refreshing = ["cold", "catch_up", "refresh_required"].includes(state);
  return {
    state,
    authority_key: "private-authority-digest",
    source_key: "private-source-digest",
    query_key: "private-query-digest",
    coverage_gaps: refreshing ? [scope.window] : [],
    change_gap: refreshing ? {after: null, through: scope.refresh_through} : null,
    cursor: null,
    cached_resource_count: refreshing ? 0 : 1,
    sync_completed_at: refreshing ? null : scope.refresh_through,
    origin: refreshing ? null : "cache",
    freshness_status: refreshing ? "missing" : "fresh",
    age_seconds: refreshing ? null : 0,
    max_age_seconds: 300,
    allow_stale_on_error: false,
    stale: false,
    ...(refreshing ? {lease_token: "lease-private", lease_expires_at: "2026-09-24T16:01:00Z"} : {}),
    ...extra
  };
}

function readPlan(state = "current", extra = {}) {
  const value = plan(state, extra);
  delete value.lease_token;
  delete value.lease_expires_at;
  return value;
}

function consumer(overrides = {}) {
  const calls = [];
  const methods = {};
  for (const name of ["begin", "commit", "abort", "read", "inspect", "invalidateExact", "invalidateDataset", "invalidateSource", "invalidateCurrentAuthority"]) {
    methods[name] = async (request) => {
      calls.push([name, structuredClone(request)]);
      if (name === "begin") return plan();
      if (name === "read") return {...readPlan(), documents: [{resource_id: "public-record", version: "v1", modified_at: "2026-09-24T16:00:00Z", payload: {complete: true}}]};
      if (name === "inspect") return {...readPlan(), document_count: 1};
      if (name === "commit") return {state: "committed", authority_key: "private-authority-digest", query_key: "private-query-digest", document_count: 1, tombstone_count: 0, cached_resource_count: 1, sync_completed_at: scope.refresh_through};
      if (name === "abort") return {state: "aborted", authority_key: "private-authority-digest", query_key: "private-query-digest"};
      if (name === "invalidateExact") return {state: "invalidated", authority_key: "private-authority-digest", source_key: "private-source-digest", query_key: "private-query-digest"};
      if (name === "invalidateDataset") return {state: "invalidated", scope: "dataset", authority_key: "private-authority-digest", source_key: "private-source-digest", invalidated_query_count: 1};
      if (name === "invalidateSource") return {state: "invalidated", scope: "source", authority_key: "private-authority-digest", invalidated_query_count: 1};
      if (name === "invalidateCurrentAuthority") return {state: "invalidated", scope: "current_authority", authority_key: "private-authority-digest"};
      throw new Error(`unexpected method ${name}`);
    };
  }
  return {calls, ...methods, ...overrides};
}

test("cache sends only public Describe scope and BOS privately owns authority binding", async () => {
  const shared = consumer();
  const cache = new CrmCacheClient({consumer: shared});
  const result = await cache.read(scope);
  assert.equal(result.origin, "cache");
  assert.equal(result.documents[0].payload.complete, true);
  assert.equal(result.authority_key, undefined);
  const sent = shared.calls[0][1];
  assert.deepEqual(sent.source, source);
  assert.deepEqual(sent.query, {operation: "search", resource_kind: "crm-records", selector: {text: "person"}, descriptor_token: "descriptor-a"});
  assert.equal(JSON.stringify(sent).includes("authority"), false);
  assert.equal(JSON.stringify(sent).includes("partition"), false);
});

test("cache freshness policy is optional and applies the published default when omitted", async () => {
  const shared = consumer();
  const cache = new CrmCacheClient({consumer: shared});
  await cache.read({...scope, freshness_policy: undefined});
  assert.equal(Object.hasOwn(shared.calls[0][1], "freshness_policy"), false);
  await cache.read({...scope, freshness_policy: {max_age_seconds: 31536000}});
  assert.deepEqual(shared.calls[1][1].freshness_policy, {max_age_seconds: 31536000});
  await assert.rejects(cache.read({...scope, freshness_policy: {max_age_seconds: 31536001}}), /at most 31536000/);
});

test("cache refresh uses one BOS lease and commits complete documents before reading", async () => {
  const shared = consumer({
    begin: async (request) => { shared.calls.push(["begin", request]); return plan("refresh_required", {stale: true, freshness_status: "stale"}); }
  });
  const cache = new CrmCacheClient({consumer: shared});
  const result = await cache.refresh(scope, async (plan) => {
    assert.equal(plan.state, "refresh_required");
    assert.equal(plan.lease_token, undefined);
    return {documents: [{resource_id: "public-record", version: "v2", modified_at: "2026-09-24T16:00:00Z", payload: {complete: true}}], covered_intervals: [scope.window], next_cursor: null};
  });
  assert.equal(result.state, "current");
  assert.deepEqual(shared.calls.map(([name]) => name), ["begin", "commit", "read"]);
  assert.equal(shared.calls[1][1].lease_token, "lease-private");
});

test("failed refresh aborts its BOS lease and preserves the prior complete cache value", async () => {
  const shared = consumer({
    begin: async (request) => { shared.calls.push(["begin", request]); return plan("cold"); }
  });
  const cache = new CrmCacheClient({consumer: shared});
  await assert.rejects(cache.refresh(scope, async () => { throw new Error("source refresh failed"); }), /source refresh failed/);
  assert.deepEqual(shared.calls.map(([name]) => name), ["begin", "abort"]);
  assert.equal(shared.calls[1][1].lease_token, "lease-private");
});

test("cache maintenance delegates exact, dataset, source, and current-authority invalidation without private keys", async () => {
  const shared = consumer();
  const cache = new CrmCacheClient({consumer: shared});
  await cache.inspect(scope);
  await cache.invalidateQuery(scope);
  await cache.invalidateDataset(scope);
  await cache.invalidateSource(scope);
  await cache.invalidateCurrentAuthority(scope);
  await cache.invalidateAfterMutation([scope, structuredClone(scope)]);
  assert.deepEqual(shared.calls.map(([name]) => name), ["inspect", "invalidateExact", "invalidateDataset", "invalidateSource", "invalidateCurrentAuthority", "invalidateSource"]);
  assert.equal(shared.calls.every(([, request]) => !JSON.stringify(request).includes("authority")), true);
});

test("cache requests and documents reject private state, malformed sources, and incomplete refresh material", async () => {
  const shared = consumer();
  const cache = new CrmCacheClient({consumer: shared});
  await assert.rejects(cache.read({...scope, source: {plugin: "fixture-source"}}), /source/);
  await assert.rejects(cache.read({...scope, selector: {access_token: "private"}}), /forbidden private key/);
  await assert.rejects(cache.commit(scope, {lease_token: "lease", documents: [{resource_id: "r", version: "v", modified_at: "2026-09-24T16:00:00Z"}]}), /payload or a deleted tombstone/);
  await assert.rejects(cache.commit(scope, {lease_token: "lease", documents: [{resource_id: "r", version: "v", modified_at: "2026-09-24T16:00:00Z", deleted: true, payload: {}}]}), /payload or a deleted tombstone/);
  await cache.commit(scope, {lease_token: "lease", documents: [{resource_id: "r", version: "v", modified_at: "2026-09-24T16:00:00Z", deleted: true}]});
});

test("load uses a fresh BOS read and refreshes only a stale or missing entry", async () => {
  const shared = consumer();
  const cache = new CrmCacheClient({consumer: shared});
  let loads = 0;
  assert.equal((await cache.load(scope, async () => { loads += 1; return {documents: []}; })).origin, "cache");
  assert.equal(loads, 0);
  shared.read = async (request) => { shared.calls.push(["read", request]); return {...readPlan("cold"), documents: []}; };
  shared.begin = async (request) => { shared.calls.push(["begin", request]); return plan("cold"); };
  await cache.load(scope, async () => { loads += 1; return {documents: [{resource_id: "r", version: "v", modified_at: "2026-09-24T16:00:00Z", payload: {complete: true}}]}; });
  assert.equal(loads, 1);
});

test("load uses stale public documents after a failed refresh only when current policy permits it", async () => {
  const stale = {...readPlan(), freshness_status: "stale", stale: true, documents: [{resource_id: "r", version: "v", modified_at: "2026-09-24T16:00:00Z", payload: {complete: true}}]};
  const shared = consumer({
    read: async (request) => { shared.calls.push(["read", request]); return stale; },
    begin: async (request) => { shared.calls.push(["begin", request]); return plan("refresh_required"); }
  });
  const cache = new CrmCacheClient({consumer: shared});
  const permissive = {...scope, freshness_policy: {...scope.freshness_policy, allow_stale_on_error: true}};
  assert.equal((await cache.load(permissive, async () => { throw new Error("offline"); })).stale, true);
  await assert.rejects(cache.load(scope, async () => { throw new Error("offline"); }), /offline/);
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

test("public failure presentation preserves actionable sanitized recovery without inventing provider detail", () => {
  const failure = {code: "CRM_EVIDENCE_REQUIRED", message: "Current CRM evidence is required.", retryable: false, correlation_id: "corr_public", details: [{field: "email"}]};
  const instruction = {message: "Correct the current CRM evidence and continue.", effect: "update"};
  const view = presentPublicFailure(failure, {operation: "crm.records.update", instruction});
  assert.equal(view.code, "CRM_EVIDENCE_REQUIRED");
  assert.equal(view.correlation_id, "corr_public");
  assert.deepEqual(view.recovery, instruction);
  assert.equal(JSON.stringify(view).includes("provider"), false);
  assert.throws(() => presentPublicFailure({...failure, message: "SQLSTATE 23505"}), /private implementation detail/);
  assert.throws(() => presentPublicFailure(failure, {instruction: {access_token: "private"}}), /forbidden private key/);
});
