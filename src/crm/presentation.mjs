import {assertNoPrivateKeys, validateDateTime} from "../bos/contracts.mjs";

export function presentResult(result, {origin, locale, timeZone, conflicts = [], uncertainty = []} = {}) {
  if (!["cached", "live"].includes(origin)) throw new TypeError("Result origin must be live or cached");
  const observed = result?.observed_at ?? result?.retrieved_at;
  try { validateDateTime(observed, "result freshness"); } catch { throw new TypeError("Result freshness timestamp is required"); }
  const lastUpdated = new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short", timeZone}).format(new Date(observed));
  const view = {origin, last_updated_local: lastUpdated, complete: result.complete, source_results: structuredClone(result.source_results ?? []), coverage: structuredClone(result.coverage ?? null), conflicts: structuredClone(conflicts), uncertainty: structuredClone(uncertainty), usage: structuredClone(result.usage ?? {status: "unavailable"})};
  assertNoPrivateKeys(view, "CRM presentation");
  return view;
}
