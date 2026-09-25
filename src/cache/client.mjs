import {createRequire} from "node:module";

import {assertNoPrivateKeys, validateDateTime, validateJsonValueAgainstSchema, validateSourceReference} from "../bos/contracts.mjs";

const require = createRequire(import.meta.url);
const CACHE_REQUEST_SCHEMA = require("../../contracts/bos-operations-center/bos-client-dependency/v1/shared-cache.request.schema.json");
const CACHE_RESULTS_SCHEMA = require("../../contracts/bos-operations-center/bos-client-dependency/v1/shared-cache.results.schema.json");

const SCHEMA_VERSION = "bos.shared-cache-consumer/v1";
const REFRESH_STATES = new Set(["cold", "catch_up", "refresh_required"]);

function requireMethod(owner, name) {
  if (typeof owner?.[name] !== "function") throw new TypeError(`shared cache consumer.${name} is required`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
  return value;
}

function validateWindow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("cache window is required");
  validateDateTime(value.from, "cache window.from");
  validateDateTime(value.through, "cache window.through");
  if (Date.parse(value.from) > Date.parse(value.through)) throw new TypeError("cache window must be ordered");
  return {from: value.from, through: value.through};
}

function validateFreshnessPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("cache freshness_policy must be an object");
  const maxAgeSeconds = nonNegativeInteger(value.max_age_seconds, "cache freshness_policy.max_age_seconds");
  if (maxAgeSeconds > 31536000) throw new TypeError("cache freshness_policy.max_age_seconds must be at most 31536000");
  const policy = {
    max_age_seconds: maxAgeSeconds
  };
  if (value.allow_stale_on_error !== undefined) {
    if (typeof value.allow_stale_on_error !== "boolean") throw new TypeError("cache freshness_policy.allow_stale_on_error must be boolean");
    policy.allow_stale_on_error = value.allow_stale_on_error;
  }
  return policy;
}

function request(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new TypeError("cache scope is required");
  const selector = structuredClone(scope.selector);
  if (selector === undefined) throw new TypeError("cache selector is required");
  assertNoPrivateKeys(selector, "cache selector");
  const result = {
    schema_version: SCHEMA_VERSION,
    source: validateSourceReference(scope.source, "cache source"),
    query: {
      operation: requireString(scope.operation, "cache operation"),
      resource_kind: requireString(scope.resource_kind, "cache resource_kind"),
      selector,
      descriptor_token: requireString(scope.descriptor_token, "cache descriptor_token")
    },
    window: validateWindow(scope.window),
    refresh_through: validateDateTime(scope.refresh_through, "cache refresh_through")
  };
  if (scope.freshness_policy !== undefined) result.freshness_policy = validateFreshnessPolicy(scope.freshness_policy);
  assertNoPrivateKeys(result, "shared cache request");
  return validateJsonValueAgainstSchema(result, CACHE_REQUEST_SCHEMA, "shared cache request");
}

function validateRequest(value) {
  return validateJsonValueAgainstSchema(value, CACHE_REQUEST_SCHEMA, "shared cache request");
}

function validateResult(method, value) {
  const key = new Map([
    ["begin", "begin"], ["commit", "commit"], ["abort", "abort"], ["read", "read"], ["inspect", "inspect"],
    ["invalidateExact", "invalidate_exact"], ["invalidateDataset", "invalidate_dataset"],
    ["invalidateSource", "invalidate_source"], ["invalidateCurrentAuthority", "invalidate_current_authority"]
  ]).get(method);
  if (!key) throw new TypeError(`unsupported shared cache result ${method}`);
  validateJsonValueAgainstSchema({[key]: value}, CACHE_RESULTS_SCHEMA, `shared cache ${method} result`);
  return value;
}

function publicResult(value, {documents = false} = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("shared cache result must be an object");
  const result = {};
  for (const key of ["state", "origin", "freshness_status", "stale", "age_seconds", "max_age_seconds", "allow_stale_on_error", "retry_after_ms", "cached_resource_count", "document_count", "tombstone_count", "invalidated_query_count", "sync_completed_at", "lease_expires_at", "scope", "coverage_gaps", "change_gap", "cursor"]) {
    if (value[key] !== undefined) result[key] = structuredClone(value[key]);
  }
  if (documents && value.documents !== undefined) {
    if (!Array.isArray(value.documents)) throw new TypeError("shared cache documents must be an array");
    result.documents = structuredClone(value.documents);
  }
  assertNoPrivateKeys(result, "shared cache public result");
  return result;
}

function validateDocuments(documents) {
  if (!Array.isArray(documents)) throw new TypeError("cache documents must be an array");
  return documents.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`cache documents[${index}] must be an object`);
    const document = {
      resource_id: requireString(value.resource_id, `cache documents[${index}].resource_id`),
      version: requireString(value.version, `cache documents[${index}].version`),
      modified_at: validateDateTime(value.modified_at, `cache documents[${index}].modified_at`)
    };
    const keys = Object.keys(value).sort();
    const payloadKeys = ["modified_at", "payload", "resource_id", "version"];
    const tombstoneKeys = ["deleted", "modified_at", "resource_id", "version"];
    const payloadWithDeletedKeys = ["deleted", ...payloadKeys].sort();
    if (JSON.stringify(keys) === JSON.stringify(payloadKeys) || (JSON.stringify(keys) === JSON.stringify(payloadWithDeletedKeys) && value.deleted === false)) {
      assertNoPrivateKeys(value.payload, `cache documents[${index}].payload`);
      document.payload = structuredClone(value.payload);
      if (value.deleted === false) document.deleted = false;
    } else if (JSON.stringify(keys) === JSON.stringify(tombstoneKeys) && value.deleted === true) {
      document.deleted = true;
    } else throw new TypeError(`cache documents[${index}] must contain exactly one payload or a deleted tombstone`);
    return document;
  });
}

function validateCoveredIntervals(intervals) {
  if (intervals === undefined) return undefined;
  if (!Array.isArray(intervals)) throw new TypeError("cache covered_intervals must be an array");
  return intervals.map(validateWindow);
}

export class CrmCacheClient {
  constructor({consumer}) {
    for (const method of ["begin", "commit", "abort", "read", "inspect", "invalidateExact", "invalidateDataset", "invalidateSource", "invalidateCurrentAuthority"]) requireMethod(consumer, method);
    this.consumer = consumer;
  }

  async begin(scope) {
    const value = validateResult("begin", await this.consumer.begin(request(scope)));
    return publicResult(value);
  }

  async read(scope) {
    const value = validateResult("read", await this.consumer.read(request(scope)));
    return publicResult(value, {documents: true});
  }

  async inspect(scope) {
    return publicResult(validateResult("inspect", await this.consumer.inspect(request(scope))));
  }

  async commit(scope, {lease_token, documents, covered_intervals, next_cursor} = {}) {
    const input = {...request(scope), lease_token: requireString(lease_token, "cache lease_token"), documents: validateDocuments(documents)};
    const intervals = validateCoveredIntervals(covered_intervals);
    if (intervals !== undefined) input.covered_intervals = intervals;
    if (next_cursor !== undefined) {
      if (next_cursor !== null && (typeof next_cursor !== "string" || next_cursor === "")) throw new TypeError("cache next_cursor is invalid");
      input.next_cursor = next_cursor;
    }
    return publicResult(validateResult("commit", await this.consumer.commit(validateRequest(input))));
  }

  async abort(scope, leaseToken) {
    const input = validateRequest({...request(scope), lease_token: requireString(leaseToken, "cache lease_token")});
    return publicResult(validateResult("abort", await this.consumer.abort(input)));
  }

  async refresh(scope, loader) {
    if (typeof loader !== "function") throw new TypeError("cache refresh loader is required");
    const plan = validateResult("begin", await this.consumer.begin(request(scope)));
    if (plan?.state === "current") return this.read(scope);
    if (plan?.state === "busy") return publicResult(plan);
    if (!REFRESH_STATES.has(plan?.state) || typeof plan?.lease_token !== "string" || plan.lease_token === "") throw new TypeError("shared cache refresh plan is invalid");
    let replacement;
    try {
      replacement = await loader(publicResult(plan));
      await this.commit(scope, {...replacement, lease_token: plan.lease_token});
    } catch (error) {
      await this.abort(scope, plan.lease_token);
      throw error;
    }
    return this.read(scope);
  }

  async load(scope, loader) {
    const cached = await this.read(scope);
    if (cached.state === "current" && cached.stale !== true) return cached;
    try {
      return await this.refresh(scope, loader);
    } catch (error) {
      if (scope?.freshness_policy?.allow_stale_on_error === true && Array.isArray(cached.documents) && cached.documents.length > 0) return cached;
      throw error;
    }
  }

  invalidateQuery(scope) { return this.consumer.invalidateExact(request(scope)).then((value) => publicResult(validateResult("invalidateExact", value))); }
  invalidateDataset(scope) { return this.consumer.invalidateDataset(request(scope)).then((value) => publicResult(validateResult("invalidateDataset", value))); }
  invalidateSource(scope) { return this.consumer.invalidateSource(request(scope)).then((value) => publicResult(validateResult("invalidateSource", value))); }
  invalidateCurrentAuthority(scope) { return this.consumer.invalidateCurrentAuthority(request(scope)).then((value) => publicResult(validateResult("invalidateCurrentAuthority", value))); }

  async invalidateAfterMutation(scopes) {
    if (!Array.isArray(scopes) || scopes.length < 1) throw new TypeError("mutation invalidation scopes must be a non-empty array");
    const unique = new Map(scopes.map((scope) => [JSON.stringify(request(scope)), scope]));
    return Promise.all([...unique.values()].map((scope) => this.invalidateSource(scope)));
  }
}
