import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

// Pure CRM presentation planning over caller-projected public observations.
// This local shape is not an API schema and creates no operation or authority.
export function planDetailDisplay(input) {
  if (input?.intent !== "individual-detail") throw new TypeError("Individual-detail intent is required");
  const view = input.view ?? "compact";
  if (!["compact", "shortest", "full", "text"].includes(view)) throw new TypeError("Unknown display view");
  if (view === "text") return {status: "text", journey_required: false};
  if (input.identity !== "exact") return {status: "identity_required", journey_required: true};
  const current = input.current;
  if (!current || typeof current.id !== "string" || !current.id || typeof current.label !== "string" || !current.label) {
    return {status: "current_state_required", journey_required: true, missing_evidence: input.read_failure ?? null};
  }
  if (!input.topology) {
    if (typeof input.read_failure !== "string" || !input.read_failure.trim()) {
      return {status: "journey_read_required", journey_required: true};
    }
    return {status: "partial", journey_required: true, nodes: [structuredClone(current)], edges: [],
      missing_evidence: input.read_failure, eligibility: "unverified"};
  }
  const {nodes, edges} = input.topology;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new TypeError("Verified nodes and edges are required");
  const byId = new Map();
  for (const node of nodes) {
    if (!node || typeof node.id !== "string" || !node.id || typeof node.label !== "string" || !node.label || byId.has(node.id)) {
      throw new TypeError("Graph nodes require unique public references and labels");
    }
    byId.set(node.id, node);
  }
  if (!byId.has(current.id) || byId.get(current.id).label !== current.label) throw new TypeError("Current node disagrees with verified topology");
  for (const edge of edges) {
    if (!edge || !byId.has(edge.from) || !byId.has(edge.to)) throw new TypeError("Graph edge has an unverified endpoint");
  }
  const positive = nodes.filter(node => node.goal === "positive");
  const goal = input.goal ?? (positive.length === 1 ? positive[0].id : null);
  if (goal !== null && !byId.has(goal)) throw new TypeError("Goal has an unverified endpoint");
  const outgoing = new Map(nodes.map(node => [node.id, []]));
  for (const edge of edges) outgoing.get(edge.from).push(edge.to);
  const distances = new Map([[current.id, 0]]);
  const parents = new Map();
  const ways = new Map([[current.id, 1]]);
  const queue = [current.id];
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index];
    // Parallel transitions are separate conditions on one structural step.
    for (const to of new Set(outgoing.get(from))) {
      const next = distances.get(from) + 1;
      if (!distances.has(to)) {
        distances.set(to, next); parents.set(to, from); ways.set(to, ways.get(from)); queue.push(to);
      } else if (distances.get(to) === next) {
        ways.set(to, Math.min(2, ways.get(to) + ways.get(from)));
      }
    }
  }
  if (goal === null) {
    if (view !== "full") return {status: "goal_resolution_required", journey_required: true};
    const reachable = new Set(queue);
    return {status: "ready", journey_required: true, full_topology: true, current: current.id,
      goal: null, path: [], route_kind: "unresolved-goal", eligibility: "unverified",
      nodes: structuredClone(nodes.filter(node => reachable.has(node.id))),
      edges: structuredClone(edges.filter(edge => reachable.has(edge.from) && reachable.has(edge.to)))};
  }
  const shortest = [];
  if (distances.has(goal)) {
    for (let cursor = goal; cursor !== undefined; cursor = parents.get(cursor)) shortest.unshift(cursor);
  }
  const ranked = input.ranked_path ?? null;
  if (ranked !== null) {
    if (!Array.isArray(ranked) || !ranked.length || ranked[0] !== current.id || ranked.at(-1) !== goal) {
      throw new TypeError("Ranked path must connect the current node to the resolved goal");
    }
    if (new Set(ranked).size !== ranked.length || ranked.some(id => !byId.has(id))) {
      throw new TypeError("Ranked path must preserve verified distinct states");
    }
    if (ranked.slice(1).some((to, index) => !outgoing.get(ranked[index]).includes(to))) {
      throw new TypeError("Ranked path contains an unverified transition");
    }
  }
  if (!shortest.length) {
    if (view === "full") {
      const reachable = new Set(queue);
      return {status: "ready", journey_required: true, full_topology: true, current: current.id,
        goal, goal_reachable: false, unreachable_goal: structuredClone(byId.get(goal)),
        path: [], route_kind: "unreachable-goal", eligibility: "unverified",
        nodes: structuredClone(nodes.filter(node => reachable.has(node.id))),
        edges: structuredClone(edges.filter(edge => reachable.has(edge.from) && reachable.has(edge.to)))};
    }
    return {status: "unreachable", journey_required: true, nodes: structuredClone([byId.get(current.id), byId.get(goal)]),
      edges: [], path: [], eligibility: "unverified"};
  }
  const selected = ranked !== null && view !== "shortest" ? ranked : shortest;
  let eligibility = "unverified";
  if (input.eligibility !== undefined) {
    if (!["eligible", "blocked", "unverified"].includes(input.eligibility?.status) || !Array.isArray(input.eligibility?.path)) {
      throw new TypeError("Eligibility evidence requires its verified path and status");
    }
    if (JSON.stringify(input.eligibility.path) === JSON.stringify(selected)) eligibility = input.eligibility.status;
  }
  const full = view === "full";
  const shown = full ? new Set(queue) : new Set(selected);
  const selectedEdges = full ? edges.filter(edge => shown.has(edge.from) && shown.has(edge.to))
    : selected.slice(1).flatMap((to, index) => edges.filter(edge => edge.from === selected[index] && edge.to === to));
  return {
    status: "ready", journey_required: true, full_topology: full,
    current: current.id, goal, path: [...selected],
    nodes: structuredClone(full ? nodes.filter(node => shown.has(node.id)) : selected.map(id => byId.get(id))),
    edges: structuredClone(selectedEdges),
    route_kind: ranked !== null && view !== "shortest" ? "application-ranked" : "shortest-structural",
    shortest_path_tie: ways.get(goal) > 1,
    ranking_difference: ranked !== null && JSON.stringify(ranked) !== JSON.stringify(selected),
    eligibility
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    process.stdout.write(`${JSON.stringify(planDetailDisplay(JSON.parse(raw)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
