import {createHash} from "node:crypto";
import {assertNoPrivateKeys, validateDateTime, validateSourceReference} from "../bos/contracts.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${label} is required`);
  return value;
}
function key(scope) {
  const partition = requireString(scope?.partition, "opaque cache partition");
  const source = scope.source === null || scope.source === undefined ? null : validateSourceReference(scope.source, "cache source");
  const parameters = scope.parameters ?? {};
  const coverage = scope.coverage ?? null;
  assertNoPrivateKeys(parameters, "cache parameters");
  assertNoPrivateKeys(coverage, "cache coverage");
  const contract = {descriptor: requireString(scope.descriptor, "descriptor"), operation: requireString(scope.operation, "operation"), source, parameters, coverage};
  return `${partition}:${createHash("sha256").update(JSON.stringify(stable(contract))).digest("hex")}`;
}

export class CrmCacheClient {
  constructor({adapter, now = Date.now, maxAgeMs}) {
    for (const method of ["read", "publish", "inspect", "invalidate"]) if (typeof adapter?.[method] !== "function") throw new TypeError(`shared cache adapter.${method} is required`);
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new TypeError("maxAgeMs must be non-negative");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.adapter = adapter;
    this.now = now;
    this.maxAgeMs = maxAgeMs;
  }
  async read(scope) {
    const cacheKey = key(scope);
    const entry = await this.adapter.read(cacheKey);
    if (!entry) return null;
    if (entry.status !== "complete" || !Number.isFinite(entry.retrieved_at_ms)) {
      await this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: cacheKey});
      return null;
    }
    try { validateDateTime(entry.retrieved_at, "cache retrieved_at"); } catch {
      await this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: cacheKey});
      return null;
    }
    if (Date.parse(entry.retrieved_at) !== entry.retrieved_at_ms) {
      await this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: cacheKey});
      return null;
    }
    const age = this.now() - entry.retrieved_at_ms;
    if (!Number.isFinite(age) || age < 0 || age > this.maxAgeMs) {
      await this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: cacheKey});
      return null;
    }
    try { assertNoPrivateKeys(entry.value, "cached public result"); } catch {
      await this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: cacheKey});
      return null;
    }
    return {origin: "cached", retrieved_at: entry.retrieved_at, value: structuredClone(entry.value)};
  }
  async publish(scope, value) {
    if (value?.complete !== true) throw new TypeError("Only a complete result can replace a complete cache entry");
    assertNoPrivateKeys(value, "cached public result");
    const retrievedAtMs = this.now();
    const retrieved = new Date(retrievedAtMs).toISOString();
    await this.adapter.publish(key(scope), {status: "complete", retrieved_at: retrieved, retrieved_at_ms: retrievedAtMs, value: structuredClone(value)});
    return {origin: "live", retrieved_at: retrieved, value: structuredClone(value)};
  }
  async refresh(scope, loader) {
    if (typeof loader !== "function") throw new TypeError("cache refresh loader is required");
    const value = await loader();
    return this.publish(scope, value);
  }
  async load(scope, loader) {
    const cached = await this.read(scope);
    if (cached) return cached;
    return this.refresh(scope, loader);
  }
  async inspect(partition) {
    const result = await this.adapter.inspect(requireString(partition, "opaque cache partition"));
    assertNoPrivateKeys(result, "cache inspection");
    return structuredClone(result);
  }
  invalidateCurrentAuthority(partition) { return this.adapter.invalidate({partition: requireString(partition, "opaque cache partition"), scope: "authority"}); }
  invalidateQuery(scope) { return this.adapter.invalidate({partition: requireString(scope?.partition, "opaque cache partition"), scope: "query", key: key(scope)}); }
  invalidateSource({partition, source}) {
    return this.adapter.invalidate({partition: requireString(partition, "opaque cache partition"), scope: "source", source: validateSourceReference(source)});
  }
  invalidateDataset({partition, dataset}) {
    return this.adapter.invalidate({partition: requireString(partition, "opaque cache partition"), scope: "dataset", dataset: requireString(dataset, "dataset")});
  }
  async invalidateAfterMutation({partition, sources = [], datasets = []}) {
    requireString(partition, "opaque cache partition");
    if (!Array.isArray(sources) || !Array.isArray(datasets)) throw new TypeError("mutation invalidation sources and datasets must be arrays");
    const uniqueSources = new Map();
    for (const source of sources) {
      const current = validateSourceReference(source, "mutation invalidation source");
      uniqueSources.set(JSON.stringify(current), current);
    }
    const uniqueDatasets = new Set(datasets.map((dataset) => requireString(dataset, "mutation invalidation dataset")));
    await Promise.all([
      ...[...uniqueSources.values()].map((source) => this.invalidateSource({partition, source})),
      ...[...uniqueDatasets].map((dataset) => this.invalidateDataset({partition, dataset}))
    ]);
  }
}
