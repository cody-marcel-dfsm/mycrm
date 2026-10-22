import {buildCreateRequest, buildDeleteRequest, buildSearchRequest, buildUpdateRequest} from "./operations.mjs";
import {validateCreateResult, validateFederatedResult, validateOrderedMutationResult} from "./results.mjs";

const OPERATIONS = Object.freeze({search: "search", create: "create", update: "update", delete: "delete"});

function requireMethod(owner, name) {
  if (typeof owner?.[name] !== "function") throw new TypeError(`bos.${name} is required`);
}

function body(response, operation) {
  if (!response || typeof response !== "object" || !Number.isInteger(response.status)) throw new TypeError(`${operation} transport response is invalid`);
  if (response.status < 200 || response.status > 299) throw new TypeError(`${operation} transport must return a successful public response`);
  return response.body;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export class CrmCacheMaintenanceError extends Error {
  constructor({operation, result, pendingConfirmations, reason}) {
    super("The mutation result is preserved; retry only the pending cache maintenance.");
    this.name = "CrmCacheMaintenanceError";
    this.code = "CACHE_MAINTENANCE_INCOMPLETE";
    this.operation = operation;
    this.result = structuredClone(result);
    this.pendingConfirmations = pendingConfirmations;
    this.reason = reason;
  }
}

export class ProviderNeutralCrmClient {
  #handledConfirmations = new Set();
  #pendingHandoffs = new Map();
  #maintenanceTail = Promise.resolve();
  #scopeVerifier = null;

  constructor({bos, onMutationComplete = async () => {}}) {
    for (const method of ["describe", "execute", "getDescription", "invokeStateAction"]) requireMethod(bos, method);
    if (typeof onMutationComplete !== "function") throw new TypeError("onMutationComplete must be a function");
    this.bos = bos;
    this.onMutationComplete = onMutationComplete;
  }

  async search(input) {
    await this.retryCacheMaintenance();
    const description = await this.#describe(OPERATIONS.search);
    return validateFederatedResult(body(await this.bos.execute(OPERATIONS.search, buildSearchRequest(input)), OPERATIONS.search), description);
  }

  async create(input) {
    await this.retryCacheMaintenance();
    const description = await this.#describe(OPERATIONS.create);
    const request = buildCreateRequest(input);
    const verifyScope = await this.#captureMaintenanceScope();
    const result = validateCreateResult(body(await this.bos.execute(OPERATIONS.create, request), OPERATIONS.create), description, request.source);
    await this.#afterMutation(OPERATIONS.create, result, verifyScope);
    return result;
  }

  async update(input) {
    return this.#orderedMutation(OPERATIONS.update, buildUpdateRequest(input));
  }

  async delete(input) {
    return this.#orderedMutation(OPERATIONS.delete, buildDeleteRequest(input));
  }

  async observeCreate(action, {source}) {
    const description = this.bos.getDescription(OPERATIONS.create);
    const verifyScope = await this.#captureMaintenanceScope();
    const result = validateCreateResult(body(await this.bos.invokeStateAction(action), OPERATIONS.create), description, source);
    await this.#afterMutation(OPERATIONS.create, result, verifyScope);
    return result;
  }

  async observeUpdate(action, {targets}) {
    return this.#observeOrderedMutation(OPERATIONS.update, action, targets);
  }

  async observeDelete(action, {targets}) {
    return this.#observeOrderedMutation(OPERATIONS.delete, action, targets);
  }

  async #describe(operation) {
    await this.bos.describe([operation]);
    return this.bos.getDescription(operation);
  }

  async #orderedMutation(operation, request) {
    await this.retryCacheMaintenance();
    const description = await this.#describe(operation);
    if (typeof this.bos.verifyExecutionIntent !== "function" ||
        await this.bos.verifyExecutionIntent({operation, effect: description.effect,
          request: structuredClone(request), requireOneConceptualRecord: true,
          requireUserApproval: operation === OPERATIONS.delete}) !== true) {
      throw new TypeError("Trusted BOS execution review is required; prepare the exact request for review");
    }
    const verifyScope = await this.#captureMaintenanceScope();
    const result = validateOrderedMutationResult(body(await this.bos.execute(operation, request), operation), request.targets, description);
    await this.#afterMutation(operation, result, verifyScope);
    return result;
  }

  async #observeOrderedMutation(operation, action, targets) {
    const description = this.bos.getDescription(operation);
    const verifyScope = await this.#captureMaintenanceScope();
    const result = validateOrderedMutationResult(body(await this.bos.invokeStateAction(action), operation), targets, description);
    await this.#afterMutation(operation, result, verifyScope);
    return result;
  }

  async #captureMaintenanceScope() {
    if (typeof this.bos.captureExecutionScope !== "function") return null;
    if (this.#scopeVerifier && await this.#scopeVerifier() !== true) {
      const pending = this.#pendingHandoffs.values().next().value;
      if (pending) throw this.#maintenanceError(pending, "scope_changed");
      this.#handledConfirmations.clear();
    }
    const verifyScope = await this.bos.captureExecutionScope();
    if (typeof verifyScope !== "function" || await verifyScope() !== true) throw new TypeError("Trusted BOS scope verification is required for cache maintenance");
    this.#scopeVerifier = verifyScope;
    return verifyScope;
  }

  #serializeMaintenance(action) {
    const pending = this.#maintenanceTail.then(action);
    this.#maintenanceTail = pending.catch(() => {});
    return pending;
  }

  async retryCacheMaintenance() {
    return this.#serializeMaintenance(async () => {
      await this.#flushMaintenance();
      return {complete: true, pendingConfirmations: 0};
    });
  }

  #maintenanceError(handoff, reason, current = handoff) {
    return new CrmCacheMaintenanceError({operation: current.operation, result: current.result,
      pendingConfirmations: this.#pendingHandoffs.size, reason});
  }

  async #flushMaintenance(current) {
    for (const handoff of new Set(this.#pendingHandoffs.values())) {
      try {
        if (handoff.verifyScope && await handoff.verifyScope() !== true) throw this.#maintenanceError(handoff, "scope_changed", current);
        await this.onMutationComplete(structuredClone({operation: handoff.operation,
          result: handoff.result, sources: handoff.sources, confirmations: handoff.confirmations}));
        if (handoff.verifyScope && await handoff.verifyScope() !== true) throw this.#maintenanceError(handoff, "scope_changed", current);
      } catch (error) {
        if (error instanceof CrmCacheMaintenanceError) throw error;
        throw this.#maintenanceError(handoff, "callback_failed", current);
      }
      for (const key of handoff.keys) {
        this.#handledConfirmations.add(key);
        this.#pendingHandoffs.delete(key);
      }
    }
  }

  async #afterMutation(operation, result, verifyScope) {
    return this.#serializeMaintenance(async () => {
      const confirmed = operation === OPERATIONS.create
        ? (["created", "replayed"].includes(result.status) ? [{source: result.source,
          record: {selector: result.record.public_selector}, receipt: result.receipt}] : [])
        : result.outcomes.filter(({status}) => ["updated", "deleted", "replayed"].includes(status))
          .map(({source, record, receipt}) => ({source, record, receipt}));
      const entries = confirmed.map(confirmation => ({confirmation,
        key: JSON.stringify(canonical({operation, ...confirmation}))}))
        .filter(({key}) => !this.#handledConfirmations.has(key) && !this.#pendingHandoffs.has(key));
      if (entries.length) {
        const sources = [...new Map(entries.map(({confirmation: {source}}) => [JSON.stringify(canonical(source)), source])).values()];
        const handoff = {operation, result: structuredClone(result), verifyScope,
          sources: structuredClone(sources), confirmations: structuredClone(entries.map(({confirmation}) => confirmation)),
          keys: entries.map(({key}) => key)};
        for (const key of handoff.keys) this.#pendingHandoffs.set(key, handoff);
      }
      await this.#flushMaintenance({operation, result});
    });
  }
}
