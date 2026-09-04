import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { generateCrmFsm, GraphValidationError, stableGraphJson, validateCrmFsm } from "../src/fsm/generate.mjs";

const example = JSON.parse(await readFile(new URL("../examples/fsm/lead-follow-up.fsm.json", import.meta.url), "utf8"));
const capabilityCatalog = ["crm.records.search", "crm.activities.create"];

test("reference CRM graph is valid and serializes deterministically", () => {
  assert.deepEqual(validateCrmFsm(example), []);
  const first = stableGraphJson(example);
  const second = stableGraphJson(JSON.parse(first));
  assert.equal(first, second);
});

test("generator normalizes ordering without provider routing", () => {
  const graph = generateCrmFsm({
    slug: example.metadata.slug,
    name: example.metadata.name,
    description: example.metadata.description,
    labels: example.metadata.labels,
    goal: example.spec.goal,
    capabilityContract: example.spec.capabilityContract,
    inputs: example.spec.inputs,
    states: [...example.spec.states].reverse(),
    transitions: [...example.spec.transitions].reverse()
  }, { capabilityCatalog });
  assert.deepEqual(graph.spec.states.map(({ id }) => id), ["new", "qualified", "scheduled", "unqualified"]);
  const keys = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key.toLocaleLowerCase());
      visit(nested);
    }
  };
  visit(graph);
  assert.equal(keys.some((key) => key.includes("provider") || key.includes("credential") || key.includes("route")), false);
});

test("generator requires current discovery and rejects unknown capabilities", () => {
  const input = {
    slug: example.metadata.slug,
    name: example.metadata.name,
    description: example.metadata.description,
    labels: example.metadata.labels,
    goal: example.spec.goal,
    capabilityContract: example.spec.capabilityContract,
    inputs: example.spec.inputs,
    states: example.spec.states,
    transitions: example.spec.transitions
  };
  assert.throws(() => generateCrmFsm(input), /capabilityCatalog/);
  assert.throws(() => generateCrmFsm(input, { capabilityCatalog: ["crm.records.search"] }), (error) => {
    assert.ok(error instanceof GraphValidationError);
    assert.ok(error.issues.some((issue) => issue.includes("undiscovered capability")));
    return true;
  });
});

test("generator rejects duplicate identifiers", () => {
  const invalid = structuredClone(example);
  invalid.spec.states[1].id = invalid.spec.states[0].id;
  assert.throws(() => stableGraphJson(invalid), (error) => {
    assert.ok(error instanceof GraphValidationError);
    assert.ok(error.issues.some((issue) => issue.includes("duplicate state id")));
    return true;
  });
});

test("generator rejects unreachable states and missing reachable goals", () => {
  const invalid = structuredClone(example);
  invalid.spec.transitions = [];
  const issues = validateCrmFsm(invalid);
  assert.ok(issues.some((issue) => issue.includes("unreachable")));
  assert.ok(issues.includes("no goal state is reachable from the entry state"));
});
