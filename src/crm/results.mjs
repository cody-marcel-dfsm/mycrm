import {assertNoPrivateKeys, validateDateTime, validatePublicError, validateSourceReference} from "../bos/contracts.mjs";
import {validateOperationStateAction} from "../bos/action-client.mjs";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required`);
  return value;
}
function sameSource(left, right) {
  return left.platform === right.platform && left.application === right.application && left.plugin === right.plugin;
}
function selector(value, label) {
  const record = object(value, label);
  if (JSON.stringify(Object.keys(record)) !== JSON.stringify(["selector"])) throw new TypeError(`${label} must contain only the opaque selector`);
  nonEmpty(record.selector, `${label}.selector`);
  return record;
}
function has(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function validateCorrelationId(value, label) {
  nonEmpty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new TypeError(`${label} is invalid`);
}
function validateContinuation(result, label) {
  if (!Number.isInteger(result.retry_after_seconds) || result.retry_after_seconds < 1) throw new TypeError(`${label} retry_after_seconds must be a positive integer`);
  result.action = validateOperationStateAction(result.action);
}
function rejectTerminalContinuation(result, label) {
  if (result.retry_after_seconds !== undefined && result.retry_after_seconds !== null) throw new TypeError(`${label} cannot expose retry_after_seconds after completion`);
  if (result.action !== undefined && result.action !== null) throw new TypeError(`${label} cannot expose a state action after completion`);
}

export function validateFederatedResult(value, description) {
  const result = object(value, "federated result");
  for (const key of Object.keys(result)) if (!["complete", "contract_version", "correlation_id", "observed_at", "source_results"].includes(key)) throw new TypeError(`federated result contains unsupported field ${key}`);
  if (result.complete !== true || !Array.isArray(result.source_results)) throw new TypeError("federated result must be complete with source_results");
  nonEmpty(result.contract_version, "federated result contract_version");
  nonEmpty(result.correlation_id, "federated result correlation_id");
  try { validateDateTime(result.observed_at, "federated result observed_at"); } catch { throw new TypeError("federated result contract, correlation, and freshness evidence are required"); }
  const maximum = description?.limits?.max_results_per_source;
  for (const [index, sourceResult] of result.source_results.entries()) {
    for (const key of Object.keys(sourceResult)) if (!["error", "observed_at", "records", "source", "status"].includes(key)) throw new TypeError(`source_results[${index}] contains unsupported field ${key}`);
    validateSourceReference(sourceResult.source, `source_results[${index}].source`);
    if (typeof sourceResult.status !== "string" || sourceResult.status === "") throw new TypeError(`source_results[${index}].status is required`);
    if (!Array.isArray(sourceResult.records)) throw new TypeError(`source_results[${index}].records must be an array`);
    if (Number.isInteger(maximum) && sourceResult.records.length > maximum) throw new TypeError(`source_results[${index}] exceeds the advertised result limit`);
    for (const [recordIndex, record] of sourceResult.records.entries()) {
      object(record, `source_results[${index}].records[${recordIndex}]`);
      if (typeof record.public_selector !== "string" || record.public_selector === "") throw new TypeError("source record public_selector is required");
      assertNoPrivateKeys(record, `source_results[${index}].records[${recordIndex}]`);
    }
    try { validateDateTime(sourceResult.observed_at, `source_results[${index}].observed_at`); } catch { throw new TypeError("source result freshness is required"); }
    if (sourceResult.error !== null && sourceResult.error !== undefined) {
      const error = validatePublicError(sourceResult.error);
      const advertised = new Set(description?.error_contract?.codes ?? []);
      if (!advertised.has(error.code)) throw new TypeError(`source_results[${index}] returned an unadvertised public error`);
    }
  }
  return structuredClone(result);
}

export function validateCreateResult(value, description = null) {
  const result = object(value, "create result");
  const allowed = ["action", "complete", "contract_version", "correlation_id", "error", "observed_at", "receipt", "record", "retry_after_seconds", "source", "status"];
  for (const key of Object.keys(result)) if (!allowed.includes(key)) throw new TypeError(`create result contains unsupported field ${key}`);
  for (const key of ["complete", "contract_version", "correlation_id", "error", "observed_at", "receipt", "record", "source", "status"]) if (!has(result, key)) throw new TypeError(`create result ${key} is required`);
  if (typeof result.complete !== "boolean" || !["created", "replayed", "failed", "in_progress"].includes(result.status)) throw new TypeError("create result status is invalid");
  if (result.contract_version !== "lead-director-create/v1") throw new TypeError("create result contract, correlation, and freshness evidence are required");
  validateCorrelationId(result.correlation_id, "create result correlation_id");
  try { validateDateTime(result.observed_at, "create result observed_at"); } catch { throw new TypeError("create result contract, correlation, and freshness evidence are required"); }
  validateSourceReference(result.source, "create result source");
  if (result.complete === false) {
    if (result.status !== "in_progress" || result.record !== null || result.receipt !== null || result.error !== null) throw new TypeError("create in-progress result has inconsistent public evidence");
    validateContinuation(result, "create in-progress result");
    return structuredClone(result);
  }
  if (result.status === "in_progress") throw new TypeError("create terminal result cannot remain in_progress");
  rejectTerminalContinuation(result, "create terminal result");
  const failed = result.status === "failed";
  if (failed ? (result.record !== null || result.receipt !== null || result.error === null) : (result.record === null || result.receipt === null || result.error !== null)) throw new TypeError("create result status does not match its public evidence");
  if (result.record) {
    object(result.record, "create result record");
    if (typeof result.record.public_selector !== "string" || result.record.public_selector === "") throw new TypeError("create result public_selector is required");
    assertNoPrivateKeys(result.record, "create result record");
  }
  if (result.receipt) {
    object(result.receipt, "create result receipt");
    assertNoPrivateKeys(result.receipt, "create result receipt");
  }
  if (result.error) {
    const error = validatePublicError(result.error);
    if (description && !(description.error_contract?.codes ?? []).includes(error.code)) throw new TypeError("create result returned an unadvertised public error");
  }
  return structuredClone(result);
}

export function validateOrderedMutationResult(value, targets, description) {
  const result = object(value, "mutation result");
  if (!description || !["update", "delete"].includes(description.effect) || !Array.isArray(description.error_contract?.codes)) throw new TypeError("current update or delete operation description is required");
  for (const key of Object.keys(result)) if (!["action", "complete", "contract_version", "correlation_id", "outcomes", "retry_after_seconds"].includes(key)) throw new TypeError(`mutation result contains unsupported field ${key}`);
  for (const key of ["complete", "contract_version", "correlation_id", "outcomes"]) if (!has(result, key)) throw new TypeError(`mutation result ${key} is required`);
  if (typeof result.complete !== "boolean" || typeof result.contract_version !== "string") throw new TypeError("mutation result contract and completion evidence are required");
  validateCorrelationId(result.correlation_id, "mutation result correlation_id");
  if (result.contract_version !== `lead-director-${description.effect}/v1`) throw new TypeError("mutation result contract_version is invalid");
  if (!Array.isArray(targets) || !Array.isArray(result.outcomes) || result.outcomes.length !== targets.length) throw new TypeError("mutation result must contain one ordered outcome per target");
  if (result.complete) rejectTerminalContinuation(result, "terminal mutation result");
  else validateContinuation(result, "in-progress mutation result");
  result.outcomes.forEach((outcome, index) => {
    for (const key of Object.keys(outcome)) if (!["source", "record", "status", "observed_at", "readback", "receipt", "error"].includes(key)) throw new TypeError(`mutation outcome ${index} contains unsupported field ${key}`);
    for (const key of ["source", "record", "status", "observed_at", "receipt", "error"]) if (!has(outcome, key)) throw new TypeError(`mutation outcome ${index} ${key} is required`);
    const expected = targets[index];
    const outcomeSource = validateSourceReference(outcome.source, `mutation outcome ${index} source`);
    const outcomeRecord = selector(outcome.record, `mutation outcome ${index} record`);
    const expectedSource = validateSourceReference(expected?.source, `target ${index} source`);
    const expectedRecord = selector(expected?.record, `target ${index} record`);
    if (!sameSource(outcomeSource, expectedSource) || outcomeRecord.selector !== expectedRecord.selector) throw new TypeError(`mutation outcome ${index} does not match its target`);
    if (typeof outcome.status !== "string" || outcome.status === "") throw new TypeError(`mutation outcome ${index} status is required`);
    try { validateDateTime(outcome.observed_at, `mutation outcome ${index} observed_at`); } catch { throw new TypeError(`mutation outcome ${index} freshness is required`); }
    const allowedStatuses = description.effect === "delete" ? new Set(["deleted", "replayed", "failed", "in_progress"]) : new Set(["updated", "replayed", "failed", "in_progress"]);
    if (!allowedStatuses.has(outcome.status)) throw new TypeError(`mutation outcome ${index} status is invalid`);
    if (outcome.status === "in_progress") {
      if (result.complete || outcome.readback != null || outcome.receipt !== null || outcome.error !== null) throw new TypeError(`mutation outcome ${index} in-progress evidence is invalid`);
    } else if (outcome.status === "failed") {
      if (outcome.readback != null || outcome.receipt !== null || outcome.error === null) throw new TypeError(`mutation outcome ${index} failure evidence is invalid`);
    } else if (outcome.receipt === null || outcome.error !== null) throw new TypeError(`mutation outcome ${index} success evidence is invalid`);
    if (outcome.error) {
      const error = validatePublicError(outcome.error);
      if (!description.error_contract.codes.includes(error.code)) throw new TypeError(`mutation outcome ${index} returned an unadvertised public error`);
    }
    if (outcome.readback) {
      object(outcome.readback, `mutation outcome ${index} readback`);
      assertNoPrivateKeys(outcome.readback, `mutation outcome ${index} readback`);
    }
    if (outcome.receipt) {
      object(outcome.receipt, `mutation outcome ${index} receipt`);
      assertNoPrivateKeys(outcome.receipt, `mutation outcome ${index} receipt`);
    }
  });
  return structuredClone(result);
}
