import assert from "node:assert/strict";
import test from "node:test";
import {ProviderNeutralCrmClient} from "../src/crm/client.mjs";
import {CrmJourneyClient} from "../src/journey/client.mjs";
import {BosContractClient} from "../src/bos/client.mjs";
import {createSyntheticDocuments, startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

const documents = createSyntheticDocuments();
function crmBos(verifier) {
  const calls = [];
  return {calls, verifyExecutionIntent: verifier,
    describe: async () => {}, getDescription: operation => documents.describe.operations.find(item => item.operation === operation),
    execute: async (operation, request) => {calls.push({operation, request}); return {status: 200, body: documents.examples[operation].response};},
    invokeStateAction: async () => ({status: 200, body: {}})};
}

test("missing, denied and forged host approval block update/delete before transport", async () => {
  for (const verifier of [undefined, async () => false, async () => ({approved: true})]) {
    const bos = crmBos(verifier);
    const client = new ProviderNeutralCrmClient({bos});
    for (const operation of ["update", "delete"]) await assert.rejects(client[operation](documents.examples[operation].request), /Trusted BOS/);
    assert.equal(bos.calls.length, 0);
  }
});

test("host denies mixed conceptual customers or changed targets", async () => {
  const bos = crmBos(async intent => intent.request.targets.length === 1 && intent.request.targets[0].record.selector === documents.examples.update.request.targets[0].record.selector);
  const client = new ProviderNeutralCrmClient({bos});
  const input = structuredClone(documents.examples.update.request);
  input.targets.push({...structuredClone(input.targets[0]), record: {selector: "synthetic-other-customer"}});
  await assert.rejects(client.update(input), /Trusted BOS/);
  input.targets = [{...input.targets[0], record: {selector: "synthetic-changed-target"}}];
  await assert.rejects(client.update(input), /Trusted BOS/);
  assert.equal(bos.calls.length, 0);
});

test("asynchronous host review cannot mutate the exact dispatched target", async () => {
  const original = structuredClone(documents.examples.update.request);
  const bos = crmBos(async intent => {intent.request.targets[0].record.selector = "synthetic-forged-target"; original.targets[0].record.selector = "synthetic-caller-change"; return true;});
  await new ProviderNeutralCrmClient({bos}).update(original);
  assert.deepEqual(bos.calls[0].request, documents.examples.update.request);
});

test("journey success requires trusted completed-goal verification", async () => {
  const instruction = {goal: "Confirm synthetic goal", message: "Synthetic instruction", after_success: {verb: "complete", method: "POST", href: "/bos/synthetic/complete", payload_schema: {type: "object"}}, on_failure: {verb: "failed", method: "POST", href: "/bos/synthetic/failed", payload_schema: {type: "object"}}};
  let calls = 0;
  for (const verifier of [undefined, async () => false, async () => ({goalCompleted: true})]) {
    const client = new CrmJourneyClient({bos: {verifyExecutionIntent: verifier, invokeReturnedAction: async () => {calls++;}}});
    await assert.rejects(client.invokeInstructionAction(instruction, "after_success", {}), /Trusted BOS/);
  }
  assert.equal(calls, 0);
});

test("scope changes after recovery block refresh/replay and discard cached contracts", async context => {
  const service = await startSyntheticBosService(); context.after(service.close);
  let sameScope = true, executions = 0;
  const client = new BosContractClient({discovery: service.discovery, http: {request: async request => {
    if (Array.isArray(request.body?.operations)) return {status: 200, body: await service.discovery.describe(request.body)};
    executions++; return {status: 401};
  }}, bos: {captureExecutionScope: async () => async () => sameScope, recoverAuthentication: async () => {sameScope = false; return {status: "READY"};}}});
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", documents.examples.search.request), error => error.code === "EXECUTION_SCOPE_CHANGED");
  assert.equal(executions, 1);
  assert.equal(client.discovery, null);
  assert.equal(client.descriptions.size, 0);
});

test("required resolution approval cannot be replaced with a caller confirmation", async () => {
  const response = {identity: "synthetic-journey", status: "client_action_required", current_step: {code: "synthetic-step", type: "server", operation: "synthetic.operation"}, error: {code: "SYNTHETIC_REQUIRED", message: "Synthetic repair required", retryable: false, correlation_id: "synthetic-correlation", details: []}, resolution: {goal: "Complete synthetic repair", instruction: "Review the exact synthetic effect", requires_user_approval: true, approval_scope: ["purpose"], after_success: {verb: "step", method: "POST", href: "/bos/synthetic/step", payload_schema: null}}};
  let calls = 0;
  const client = new CrmJourneyClient({bos: {verifyExecutionIntent: async intent => {assert.equal(intent.requireUserApproval, true); assert.equal(intent.requireGoalCompletion, true); return false;}, invokeReturnedAction: async () => {calls++;}}});
  await assert.rejects(client.invokeResolutionAction(response), /Trusted BOS/);
  assert.equal(calls, 0);
});

test("initial signed-out discovery can bootstrap reads without prior business scope", async context => {
  const service = await startSyntheticBosService(); context.after(service.close);
  const denied = new Error("synthetic authentication required"); denied.status = 401;
  const client = new BosContractClient({discovery: {read: async () => {throw denied;}, refresh: service.discovery.refresh}, http: service.http, bos: {recoverAuthentication: async () => ({status: "READY"})}});
  await client.describe(["search"]);
  assert.equal(client.getDescription("search").operation, "search");
});


test("a one-use host approval is checked once by the mutation helper", async () => {
  let uses = 0;
  const bos = crmBos(async () => ++uses === 1);
  await new ProviderNeutralCrmClient({bos}).delete(documents.examples.delete.request);
  assert.equal(uses, 1);
  assert.equal(bos.calls.length, 1);
});
