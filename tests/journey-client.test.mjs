import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import { CrmJourneyClient, buildCrmContribution, createAudienceRepairGuidance, validateCrmInstructionEnvelope } from "../src/journey/client.mjs";

const serviceFixture = JSON.parse(await readFile(new URL("./fixtures/bos/journey/awaiting-client.crm.json", import.meta.url), "utf8"));

test("journey client requires the BOS-authenticated action invoker", () => {
  assert.throws(() => new CrmJourneyClient({http: {request: async () => ({status: 200})}}), /bos\.invokeReturnedAction/);
});

test("CRM contribution contains domain goals and constraints without BOSL or runtime state", () => {
  const contribution = buildCrmContribution({goal: "Find current customer evidence", concepts: ["customer evidence"], constraints: ["preserve provenance"], requiredEvidence: ["current records"], approvals: [], guarantees: ["point-in-time"], presentation: ["show conflicts"], recovery: ["follow public instruction"]});
  assert.equal(contribution.goal, "Find current customer evidence");
  const serialized = JSON.stringify(contribution).toLowerCase();
  for (const forbidden of ["bosl", "transition", "execution_id", "journey_id", "version", "digest"]) assert.equal(serialized.includes(forbidden), false);
});

test("published BOS awaiting_client CRM instruction is accepted and delegated unchanged", async () => {
  const calls = [];
  const client = new CrmJourneyClient({bos: {invokeReturnedAction: async (action, payload) => { calls.push({action, payload}); return {status: 200, body: {status: "completed"}}; }}});
  const response = validateCrmInstructionEnvelope(serviceFixture);
  assert.equal(response.status, "awaiting_client");
  assert.equal(response.identity, "crm-attendee-evidence");
  assert.deepEqual(response.current_step, {code: "resolve_crm_evidence", type: "client"});
  const instruction = client.validateInstruction(response.instruction);
  assert.equal(instruction.lookup_text, "cody.marcel@dfsm.ai");
  assert.equal(instruction.student_id, "student-public-42");
  await client.invokeInstructionAction(instruction, "after_success", {acknowledged: true});
  assert.deepEqual(calls, [{action: serviceFixture.instruction.after_success, payload: {acknowledged: true}}]);
});

test("awaiting_client envelope is closed and exposes only the public journey identity", () => {
  assert.throws(() => validateCrmInstructionEnvelope({...serviceFixture, execution_id: "private"}), /shape is invalid/);
  assert.throws(() => validateCrmInstructionEnvelope({...serviceFixture, status: "step_completed"}), /must be awaiting_client/);
  assert.throws(() => validateCrmInstructionEnvelope({...serviceFixture, current_step: {...serviceFixture.current_step, state: "private"}}), /current_step shape is invalid/);
  assert.throws(() => validateCrmInstructionEnvelope({...serviceFixture, identity: ""}), /identity is required/);
});

test("CRM instructions are bounded and server transitions remain opaque", () => {
  const client = new CrmJourneyClient({bos: {invokeReturnedAction: async () => ({status: 200, body: {}})}});
  const instruction = client.validateInstruction(serviceFixture.instruction);
  assert.equal(instruction.goal, "Find current CRM evidence for the meeting attendee.");
  assert.throws(() => client.validateInstruction({...instruction, access_token: "private"}), /forbidden private key/i);
  assert.throws(() => client.validateInstruction({...instruction, actions: {complete: instruction.after_success}}), /not part of the BOS Service envelope/i);
  assert.throws(() => client.validateInstruction({...instruction, input_schema: {type: "object"}}), /not part of the BOS Service envelope/i);
  for (const runtimeField of ["bosl", "catch", "digest", "execution_id", "journey_id", "next", "revision", "state", "transition", "version"]) {
    assert.throws(() => client.validateInstruction({...instruction, [runtimeField]: "private"}), /forbidden runtime field|forbidden private key/i);
  }
  assert.throws(() => client.validateInstruction({...instruction, after_success: {...instruction.after_success, method: "post"}}), /method/);
  assert.throws(() => client.validateInstruction({...instruction, after_success: {...instruction.after_success, href: "//fixture.invalid/action"}}), /origin-relative/);
  assert.throws(() => client.validateInstruction({...instruction, after_success: {...instruction.after_success, href: "/action#ignored"}}), /fragment/);
});

test("exact instruction actions are invoked without client IDs, keys, or state", async () => {
  const calls = [];
  const client = new CrmJourneyClient({bos: {invokeReturnedAction: async (action, payload) => { calls.push({action, payload}); return {status: 200, body: {status: "step_completed"}}; }}});
  const instruction = serviceFixture.instruction;
  await client.invokeInstructionAction(instruction, "after_success", {acknowledged: true});
  assert.deepEqual(calls, [{action: instruction.after_success, payload: {acknowledged: true}}]);
  await assert.rejects(client.invokeInstructionAction(instruction, "after_success", {acknowledged: false}), /schema/);
  assert.equal(calls.length, 1);
  await client.invokeInstructionAction(instruction, "on_failure", {code: "CRM_EVIDENCE_NOT_FOUND", message: "No matching CRM evidence was found."});
  assert.deepEqual(calls[1], {action: instruction.on_failure, payload: {code: "CRM_EVIDENCE_NOT_FOUND", message: "No matching CRM evidence was found."}});
  await assert.rejects(client.invokeInstructionAction(instruction, "step"), /unsupported/);
  await assert.rejects(client.invokeInstructionAction(instruction, "retry"), /unsupported/);
  assert.throws(() => client.validateInstruction({...instruction, after_success: {...instruction.after_success, verb: "step"}}), /must use verb complete/);
  assert.throws(() => client.validateInstruction({...instruction, on_failure: {...instruction.on_failure, verb: "complete"}}), /must use verb failed/);
});

test("CRM audience repair requires server rematerialization, campaign reprepare, and fresh approval", () => {
  const instruction = {
    goal: "Correct invalid campaign recipients",
    message: "Correct the CRM evidence needed to regenerate the campaign audience.",
    after_success: {verb: "complete", method: "POST", href: "/action/complete", payload_schema: null},
    on_failure: {verb: "failed", method: "POST", href: "/action/failed", payload_schema: {type: "object"}}
  };
  const guidance = createAudienceRepairGuidance({
    instruction,
    failure: {code: "RECIPIENT_INVALID", message: "One recipient needs current CRM evidence.", retryable: false, correlation_id: "corr_public", details: []},
    audienceChanged: true
  });
  assert.equal(guidance.client.correct_or_regenerate_recipient_evidence, true);
  assert.equal(guidance.client.send_audience_or_server_reference_in_completion, false);
  assert.equal(guidance.server.requery_and_rematerialize_audience, true);
  assert.equal(guidance.server.reprepare_campaign, true);
  assert.equal(guidance.server.require_fresh_campaign_approval, true);
  assert.equal(guidance.server.preserve_proven_successful_deliveries, true);
  assert.equal(JSON.stringify(guidance).includes("@"), false);
});
