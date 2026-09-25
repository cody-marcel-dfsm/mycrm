import {assertNoPrivateKeys, validateDateTime, validatePublicError} from "../bos/contracts.mjs";

export function presentResult(result, {origin, locale, timeZone, conflicts = [], uncertainty = []} = {}) {
  if (!["cached", "live"].includes(origin)) throw new TypeError("Result origin must be live or cached");
  const observed = result?.observed_at ?? result?.retrieved_at;
  try { validateDateTime(observed, "result freshness"); } catch { throw new TypeError("Result freshness timestamp is required"); }
  const lastUpdated = new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short", timeZone}).format(new Date(observed));
  const view = {origin, last_updated_local: lastUpdated, complete: result.complete, source_results: structuredClone(result.source_results ?? []), coverage: structuredClone(result.coverage ?? null), conflicts: structuredClone(conflicts), uncertainty: structuredClone(uncertainty), usage: structuredClone(result.usage ?? {status: "unavailable"})};
  assertNoPrivateKeys(view, "CRM presentation");
  return view;
}

export function presentPublicFailure(failure, {operation = null, instruction = null} = {}) {
  const error = validatePublicError(failure);
  if (operation !== null && (typeof operation !== "string" || operation.trim() === "")) throw new TypeError("Failure operation must be a non-empty string or null");
  if (instruction !== null && (!instruction || typeof instruction !== "object" || Array.isArray(instruction))) throw new TypeError("Failure instruction must be an object or null");
  if (instruction !== null) assertNoPrivateKeys(instruction, "failure recovery instruction");
  const view = {
    operation,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    correlation_id: error.correlation_id,
    details: structuredClone(error.details ?? []),
    recovery: instruction === null ? null : structuredClone(instruction)
  };
  assertNoPrivateKeys({...view, correlation_id: undefined}, "CRM public failure presentation");
  return view;
}
