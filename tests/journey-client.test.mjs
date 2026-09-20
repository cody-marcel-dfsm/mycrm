import assert from "node:assert/strict";
import test from "node:test";

import { CrmJourneyClient, buildCrmContribution } from "../src/journey/client.mjs";

test("CRM contribution contains domain goals and constraints without BOSL or runtime state", () => {
  const contribution = buildCrmContribution({goal: "Find current customer evidence", concepts: ["customer evidence"], constraints: ["preserve provenance"], requiredEvidence: ["current records"], approvals: [], guarantees: ["point-in-time"], presentation: ["show conflicts"], recovery: ["follow public instruction"]});
  assert.equal(contribution.goal, "Find current customer evidence");
  const serialized = JSON.stringify(contribution).toLowerCase();
  for (const forbidden of ["bosl", "transition", "execution_id", "journey_id", "version", "digest"]) assert.equal(serialized.includes(forbidden), false);
});

test("journey actions are invoked verbatim and null payload schemas stay bodyless", async () => {
  const calls = [];
  const client = new CrmJourneyClient({http: {request: async (request) => { calls.push(request); return {status: 200, body: {status: "completed"}}; }}});
  await client.invokeAction({method: "POST", uri: "https://fixture.invalid/action/step", payload_schema: null});
  assert.deepEqual(calls[0], {method: "POST", uri: "https://fixture.invalid/action/step", headers: {}});
  await assert.rejects(client.invokeAction({method: "POST", uri: "https://fixture.invalid/action/step", payload_schema: null}, {}), /bodyless/);
  await assert.rejects(client.invokeAction({method: "post", uri: "https://fixture.invalid/action/step", payload_schema: null}), /method/);
  await assert.rejects(client.invokeAction({method: "POST", uri: "https://user:password@fixture.invalid/action/step", payload_schema: null}), /credentials/);
  await assert.rejects(client.invokeAction({method: "POST", uri: "https://fixture.invalid/action/step#ignored", payload_schema: null}), /fragment/);
});

test("CRM instructions are bounded and server transitions remain opaque", () => {
  const client = new CrmJourneyClient({http: {request: async () => ({status: 200, body: {}})}});
  const instruction = client.validateInstruction({domain: "crm", goal: "Find current evidence", operation: "search", input_schema: {type: "object"}, actions: {complete: {method: "POST", uri: "https://fixture.invalid/action/complete", payload_schema: {type: "object"}}, failed: {method: "POST", uri: "https://fixture.invalid/action/failed", payload_schema: {type: "object"}}}});
  assert.equal(instruction.domain, "crm");
  assert.throws(() => client.validateInstruction({...instruction, transition: "next"}), /unsupported field/i);
  assert.throws(() => client.validateInstruction({...instruction, access_token: "private"}), /unsupported field/i);
  assert.throws(() => client.validateInstruction({...instruction, actions: {...instruction.actions, retry: instruction.actions.failed}}), /action retry is unsupported/i);
  assert.throws(() => client.validateInstruction({...instruction, actions: []}), /actions are required/i);
});
