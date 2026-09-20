const INTENTS = [
  {kind: "delete", words: ["delete", "erase", "remove"]},
  {kind: "update", words: ["change", "edit", "set", "update"]},
  {kind: "create", words: ["add", "create", "new"]},
  {kind: "read", words: ["get", "read", "show"]},
  {kind: "search", words: ["find", "list", "look up", "search"]},
  {kind: "journey", words: ["automation", "journey", "workflow"]},
  {kind: "cache", words: ["cache", "freshness", "refresh"]}
];

export function interpretCrmIntent(prompt) {
  if (typeof prompt !== "string" || prompt.trim() === "") throw new TypeError("CRM request text is required");
  const normalized = prompt.toLocaleLowerCase();
  const explicitExplain = /\b(explain|plan|preview)\b/.test(normalized);
  const matches = INTENTS.filter(({words}) => words.some((word) => new RegExp(`(?:^|[^a-z0-9])${word.replace(" ", "\\s+")}(?:$|[^a-z0-9])`, "u").test(normalized)));
  return {kind: matches.length === 1 ? matches[0].kind : "unknown", explain: explicitExplain, text: prompt.trim()};
}

export function selectDiscoveredOperation(intent, operations) {
  if (!intent || typeof intent.kind !== "string") throw new TypeError("Normalized CRM intent is required");
  if (!Array.isArray(operations)) throw new TypeError("Current operation descriptions are required");
  if (intent.kind === "unknown") return null;
  const promptTerms = new Set(intent.text.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2));
  const semanticTerms = new Set(["cache", "create", "delete", "journey", "read", "search", "update"]);
  const candidates = operations.filter((operation) => {
    if (operation.status !== "described") return false;
    const effectMatches = intent.kind === "search" || intent.kind === "read" ? operation.effect === "read" : operation.effect === intent.kind;
    if (!effectMatches) return false;
    const operationTerms = String(operation.operation ?? "").toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const qualifiers = operationTerms.filter((term) => !semanticTerms.has(term));
    return qualifiers.length === 0 || qualifiers.some((term) => promptTerms.has(term));
  });
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return structuredClone(candidates[0]);
  const ranked = candidates.map((operation) => {
    const description = `${operation.operation ?? ""} ${operation.title ?? ""} ${operation.description ?? ""}`.toLocaleLowerCase();
    return {operation, score: [...promptTerms].filter((term) => description.includes(term)).length};
  }).sort((left, right) => right.score - left.score);
  if (ranked[0].score === ranked[1].score) return null;
  return structuredClone(ranked[0].operation);
}
