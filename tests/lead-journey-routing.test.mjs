import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import path from "node:path";
import test from "node:test";
import {clientPackages, clientsDirectory} from "../scripts/build-clients.mjs";
import {planDetailDisplay} from "../plugins/my-crm/skills/my-crm-customer-journey/scripts/plan-detail-display.mjs";

const canonicalRoot = new URL("../plugins/my-crm/skills/", import.meta.url);
const skills = ["my-crm", "my-crm-record-operations", "my-crm-customer-journey"];

test("record and router completion resolve the owned journey rule in every client package", async () => {
  const expected = await readFile(new URL("my-crm-customer-journey/references/detail-display.md", canonicalRoot), "utf8");
  const roots = [canonicalRoot, ...Object.values(clientPackages).map(relative =>
    new URL(`file://${path.join(clientsDirectory, relative, "skills")}/`))];
  for (const root of roots) {
    for (const skill of skills) {
      const file = new URL(`${skill}/SKILL.md`, root);
      const text = await readFile(file, "utf8");
      const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+detail-display\.md)\)/g)];
      assert.equal(links.length, 1, `${file.pathname}: missing individual-detail completion handoff`);
      assert.equal(await readFile(new URL(links[0][1], file), "utf8"), expected);
    }
  }
});

// This is an owned presentation projection, not a BOS response/schema copy.
const current = {id: "trial", label: "Trial scheduled"};
const topology = {
  nodes: [current, {id: "approval", label: "Approval pending", gate: "Approval required"},
    {id: "goal", label: "Enrolled", goal: "positive"}, {id: "nurture", label: "Nurture"},
    {id: "declined", label: "Declined", goal: "negative"}],
  edges: [{from: "trial", to: "goal", label: "Enroll"},
    {from: "trial", to: "approval", label: "Request approval"},
    {from: "approval", to: "goal", label: "Approve", condition: "Approval granted"},
    {from: "trial", to: "nurture", label: "Nurture"},
    {from: "nurture", to: "trial", label: "Re-engage"},
    {from: "trial", to: "declined", label: "Decline"}]
};
const detail = {intent: "individual-detail", identity: "exact", current, topology, goal: "goal"};

test("named lookup completion still requires journey evidence after workspace clarification", () => {
  const originalIntent = {intent: "individual-detail", identity: "exact"};
  const afterClarification = {...originalIntent, current};
  assert.deepEqual(planDetailDisplay(afterClarification), {status: "journey_read_required", journey_required: true});
  assert.equal(planDetailDisplay({...afterClarification, identity: "ambiguous"}).status, "identity_required");
  assert.equal(planDetailDisplay({...afterClarification, view: "text"}).journey_required, false);
});

test("compact display selects a shortest positive route from a branching cyclic graph", () => {
  const view = planDetailDisplay({...detail, available_actions: [], history: []});
  assert.equal(view.journey_required, true);
  assert.equal(view.status, "ready");
  assert.deepEqual(view.path, ["trial", "goal"]);
  assert.deepEqual(view.nodes.map(node => node.id), ["trial", "goal"]);
  assert.deepEqual(view.edges.map(edge => [edge.from, edge.to]), [["trial", "goal"]]);
  assert.equal(view.route_kind, "shortest-structural");
  assert.equal(view.eligibility, "unverified");
  assert.equal(view.full_topology, false);
});

test("application ranking preserves intermediate states, gates and conditions", () => {
  const view = planDetailDisplay({...detail, ranked_path: ["trial", "approval", "goal"]});
  assert.deepEqual(view.path, ["trial", "approval", "goal"]);
  assert.equal(view.route_kind, "application-ranked");
  assert.equal(view.nodes[1].gate, "Approval required");
  assert.equal(view.edges[1].condition, "Approval granted");
  assert.equal(view.eligibility, "unverified");
  const shortest = planDetailDisplay({...detail, ranked_path: ["trial", "approval", "goal"], view: "shortest"});
  assert.deepEqual(shortest.path, ["trial", "goal"]);
  assert.equal(shortest.ranking_difference, true);
  assert.equal(planDetailDisplay({...detail, eligibility: {path: ["trial", "goal"], status: "eligible"}}).eligibility, "eligible");
  assert.equal(planDetailDisplay({...detail, ranked_path: ["trial", "approval", "goal"],
    eligibility: {path: ["trial", "goal"], status: "eligible"}}).eligibility, "unverified");
});

test("full reachable topology is an explicit view and retains alternate outcomes", () => {
  const view = planDetailDisplay({...detail, view: "full"});
  assert.equal(view.full_topology, true);
  assert.deepEqual(new Set(view.nodes.map(node => node.id)), new Set(topology.nodes.map(node => node.id)));
  assert.deepEqual(view.edges, topology.edges);
  assert.deepEqual(view.path, ["trial", "goal"]);
  const unknownGoal = planDetailDisplay({...detail, goal: null, view: "full",
    topology: {...topology, nodes: topology.nodes.map(node => ({...node, goal: undefined}))}});
  assert.equal(unknownGoal.goal, null);
  assert.deepEqual(unknownGoal.edges, topology.edges);
  assert.equal(unknownGoal.route_kind, "unresolved-goal");
});

test("an unreachable resolved goal preserves the explicit full reachable graph", () => {
  const disconnected = {...detail, topology: {
    nodes: topology.nodes,
    edges: topology.edges.filter(edge => edge.to !== "goal")
  }, view: "full"};
  const full = planDetailDisplay(disconnected);
  assert.equal(full.full_topology, true);
  assert.equal(full.goal_reachable, false);
  assert.equal(full.unreachable_goal.label, "Enrolled");
  assert.deepEqual(full.path, []);
  assert.equal(full.nodes.some(node => node.id === "nurture"), true);
  assert.equal(full.nodes.some(node => node.id === "goal"), false);
  assert.deepEqual(full.edges, disconnected.topology.edges);
  assert.equal(planDetailDisplay({...disconnected, view: "compact"}).status, "unreachable");
});

test("partial evidence preserves current state and the specific failed read", () => {
  const partial = planDetailDisplay({intent: "individual-detail", identity: "exact", current, read_failure: "topology_unavailable"});
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.nodes, [current]);
  assert.deepEqual(partial.edges, []);
  assert.equal(partial.missing_evidence, "topology_unavailable");
  assert.equal(planDetailDisplay({...detail, goal: null, topology: {...topology, nodes: topology.nodes.map(node => ({...node, goal: undefined}))}}).status, "goal_resolution_required");
});

test("invalid topology and invented ranked shortcuts are rejected", () => {
  assert.throws(() => planDetailDisplay({...detail, topology: {...topology, edges: [...topology.edges, {from: "trial", to: "unknown"}]}}), /unverified endpoint/);
  assert.throws(() => planDetailDisplay({...detail, ranked_path: ["trial", "nurture", "goal"]}), /unverified transition/);
  assert.throws(() => planDetailDisplay({...detail, ranked_path: ["approval", "goal"]}), /current node/);
});

test("shortest path ties retain uncertainty and required route states", () => {
  const twoRoutes = {...topology, edges: topology.edges.filter(edge => !(edge.from === "trial" && edge.to === "goal"))
    .concat({from: "nurture", to: "goal", label: "Enroll"})};
  const view = planDetailDisplay({...detail, topology: twoRoutes});
  assert.equal(view.shortest_path_tie, true);
  assert.equal(view.path.length, 3);
  assert.equal(view.nodes.length, 3);
  assert.equal(view.edges.length, 2);
  assert.equal(view.eligibility, "unverified");
});

test("each generated domain planner runs independently with the same completion and path behavior", () => {
  for (const relative of Object.values(clientPackages)) {
    const script = path.join(clientsDirectory, relative, "skills/my-crm-customer-journey/scripts/plan-detail-display.mjs");
    const result = JSON.parse(execFileSync(process.execPath, [script], {input: JSON.stringify(detail), encoding: "utf8"}));
    assert.deepEqual(result, planDetailDisplay(detail), relative);
    const pending = JSON.parse(execFileSync(process.execPath, [script], {input: JSON.stringify({intent: "individual-detail", identity: "exact", current}), encoding: "utf8"}));
    assert.equal(pending.status, "journey_read_required", relative);
  }
});
