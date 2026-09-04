const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;

export class GraphValidationError extends Error {
  constructor(issues) {
    super(`Invalid CRM automation graph: ${issues.join("; ")}`);
    this.name = "GraphValidationError";
    this.issues = issues;
  }
}

function requiredString(value, label, issues, pattern = null) {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${label} is required`);
    return "";
  }
  const result = value.trim();
  if (pattern && !pattern.test(result)) issues.push(`${label} has an invalid format`);
  return result;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  }
  return value;
}

export function validateCrmFsm(graph, { capabilityIds } = {}) {
  const issues = [];
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return ["graph must be an object"];
  }
  if (graph.schemaVersion !== "bos.fsm/v1") issues.push("schemaVersion must be bos.fsm/v1");
  if (graph.kind !== "CrmAutomation") issues.push("kind must be CrmAutomation");
  requiredString(graph.metadata?.slug, "metadata.slug", issues, ID);
  requiredString(graph.metadata?.name, "metadata.name", issues);
  requiredString(graph.spec?.goal, "spec.goal", issues);
  requiredString(graph.spec?.capabilityContract?.digest, "spec.capabilityContract.digest", issues);
  requiredString(graph.spec?.capabilityContract?.discoveryEpoch, "spec.capabilityContract.discoveryEpoch", issues);
  const discoveredCapabilities = capabilityIds === undefined ? null : new Set(capabilityIds);

  const states = Array.isArray(graph.spec?.states) ? graph.spec.states : [];
  const transitions = Array.isArray(graph.spec?.transitions) ? graph.spec.transitions : [];
  if (states.length === 0) issues.push("spec.states must contain at least one state");

  const stateIds = new Set();
  for (const [index, state] of states.entries()) {
    const id = requiredString(state?.id, `spec.states[${index}].id`, issues, ID);
    if (id && stateIds.has(id)) issues.push(`duplicate state id: ${id}`);
    stateIds.add(id);
    if (!["entry", "normal", "goal", "failure"].includes(state?.type)) {
      issues.push(`spec.states[${index}].type is invalid`);
    }
  }
  const entries = states.filter((state) => state?.type === "entry");
  const goals = states.filter((state) => state?.type === "goal");
  if (entries.length !== 1) issues.push("exactly one entry state is required");
  if (goals.length === 0) issues.push("at least one goal state is required");

  const transitionIds = new Set();
  const adjacency = new Map(states.map((state) => [state.id, []]));
  for (const [index, transition] of transitions.entries()) {
    const id = requiredString(transition?.id, `spec.transitions[${index}].id`, issues, ID);
    if (id && transitionIds.has(id)) issues.push(`duplicate transition id: ${id}`);
    transitionIds.add(id);
    if (!stateIds.has(transition?.from)) issues.push(`transition ${id || index} has unknown from state`);
    if (!stateIds.has(transition?.to)) issues.push(`transition ${id || index} has unknown to state`);
    if (adjacency.has(transition?.from) && stateIds.has(transition?.to)) {
      adjacency.get(transition.from).push(transition.to);
    }
    const effects = transition?.effects === undefined ? [] : transition.effects;
    if (!Array.isArray(effects)) {
      issues.push(`transition ${id || index} effects must be an array`);
      continue;
    }
    for (const [effectIndex, effect] of effects.entries()) {
      const capability = requiredString(effect?.capability, `transition ${id || index} effect ${effectIndex} capability`, issues, CAPABILITY);
      if (capability && discoveredCapabilities && !discoveredCapabilities.has(capability)) {
        issues.push(`transition ${id || index} references an undiscovered capability: ${capability}`);
      }
    }
  }

  if (entries.length === 1) {
    const reachable = new Set([entries[0].id]);
    const queue = [entries[0].id];
    while (queue.length) {
      for (const next of adjacency.get(queue.shift()) ?? []) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }
    for (const state of states) {
      if (!reachable.has(state.id)) issues.push(`state is unreachable: ${state.id}`);
    }
    if (!goals.some((state) => reachable.has(state.id))) issues.push("no goal state is reachable from the entry state");
  }
  return [...new Set(issues)];
}

export function generateCrmFsm(input, { capabilityCatalog } = {}) {
  if (!Array.isArray(capabilityCatalog)) {
    throw new GraphValidationError(["a current discovered capabilityCatalog is required"]);
  }
  const capabilityIds = capabilityCatalog.map((capability) => typeof capability === "string" ? capability : capability?.id);
  if (capabilityIds.some((capability) => typeof capability !== "string" || capability.length === 0)) {
    throw new GraphValidationError(["capabilityCatalog entries require semantic IDs"]);
  }
  const graph = {
    schemaVersion: "bos.fsm/v1",
    kind: "CrmAutomation",
    metadata: {
      slug: input?.slug,
      name: input?.name,
      description: input?.description ?? "",
      labels: sortObject(clone(input?.labels ?? {}))
    },
    spec: {
      goal: input?.goal,
      capabilityContract: {
        digest: input?.capabilityContract?.digest,
        discoveryEpoch: input?.capabilityContract?.discoveryEpoch
      },
      inputs: sortObject(clone(input?.inputs ?? {})),
      states: clone(input?.states ?? []).sort((a, b) => String(a.id).localeCompare(String(b.id))),
      transitions: clone(input?.transitions ?? []).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    }
  };
  const issues = validateCrmFsm(graph, { capabilityIds });
  if (issues.length) throw new GraphValidationError(issues);
  return sortObject(graph);
}

export function stableGraphJson(graph) {
  const issues = validateCrmFsm(graph);
  if (issues.length) throw new GraphValidationError(issues);
  return `${JSON.stringify(sortObject(graph), null, 2)}\n`;
}
