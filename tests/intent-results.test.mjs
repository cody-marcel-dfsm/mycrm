import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {interpretCrmIntent, selectDiscoveredOperation} from "../src/crm/intent.mjs";
import {validateCreateResult, validateFederatedResult, validateOrderedMutationResult} from "../src/crm/results.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));

test("natural-language intent selects only a current described operation", async () => {
  const described = await published("describe.response.example.json");
  const intent = interpretCrmIntent("Find the current customer by email");
  assert.equal(intent.kind, "search");
  assert.equal(selectDiscoveredOperation(intent, described.operations).operation, "search");
  const unknown = interpretCrmIntent("Please handle this customer situation");
  assert.equal(unknown.kind, "unknown");
  assert.equal(selectDiscoveredOperation(unknown, described.operations), null);
  assert.equal(interpretCrmIntent("Target this account for review").kind, "unknown");
  assert.equal(interpretCrmIntent("Find and delete this record").kind, "unknown");
  assert.equal(selectDiscoveredOperation(interpretCrmIntent("Show the current customer"), [{operation: "calendar_read_event", status: "described", effect: "read"}]), null);
  assert.equal(selectDiscoveredOperation(interpretCrmIntent("Show the calendar event"), [{operation: "calendar_read_event", status: "described", effect: "read"}]).operation, "calendar_read_event");
});

test("published federated search results preserve source records and advertised limits", async () => {
  const described = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  assert.equal(validateFederatedResult(examples.search.response, described.operations[0]).source_results.length, 1);
  const excessive = structuredClone(examples.search.response);
  excessive.source_results[0].records = Array.from({length: 6}, () => structuredClone(examples.search.response.source_results[0].records[0]));
  assert.throws(() => validateFederatedResult(excessive, described.operations[0]), /advertised result limit/);
  assert.throws(() => validateFederatedResult({...examples.search.response, provider_error: "raw"}, described.operations[0]), /unsupported field/);
  const nestedLeak = structuredClone(examples.search.response);
  nestedLeak.source_results[0].records[0].internal_id = "raw";
  assert.throws(() => validateFederatedResult(nestedLeak, described.operations[0]), /forbidden private key/);
  assert.throws(() => validateFederatedResult({...examples.search.response, observed_at: "2026-09-19"}, described.operations[0]), /freshness/);
  const createLeak = structuredClone(examples.create.response);
  createLeak.record.provider_id = "raw";
  assert.throws(() => validateCreateResult(createLeak), /forbidden private key/);
});

test("mutation outcomes remain ordered and preserve public success/error evidence", async () => {
  const examples = await published("operation.examples.json");
  const {request, response} = examples.update;
  const description = {effect: "update", error_contract: {codes: ["CONFLICT"]}};
  assert.equal(validateOrderedMutationResult(response, request.targets, description).outcomes.length, 1);
  const source = request.targets[0].source;
  const second = {source, record: {selector: "opaque-2"}, changes: {display_name: "Second"}};
  const partial = {...structuredClone(response), outcomes: [response.outcomes[0], {source, record: {selector: "opaque-2"}, status: "failed", observed_at: response.outcomes[0].observed_at, readback: null, receipt: null, error: {code: "CONFLICT", message: "The current value changed.", retryable: false, correlation_id: "corr-example", details: []}}]};
  assert.equal(validateOrderedMutationResult(partial, [...request.targets, second], description).outcomes.length, 2);
  const reorderedSourceKeys = structuredClone(response);
  reorderedSourceKeys.outcomes[0].source = {plugin: source.plugin, platform: source.platform, application: source.application};
  assert.equal(validateOrderedMutationResult(reorderedSourceKeys, request.targets, description).outcomes.length, 1);
  assert.throws(() => validateOrderedMutationResult({...partial, outcomes: [...partial.outcomes].reverse()}, [...request.targets, second], description), /does not match/);
  assert.throws(() => validateOrderedMutationResult({...partial, outcomes: [{...partial.outcomes[0], provider_error: "raw"}, partial.outcomes[1]]}, [...request.targets, second], description), /unsupported field/);
  const recordLeak = structuredClone(response);
  recordLeak.outcomes[0].record.internal_id = "raw";
  assert.throws(() => validateOrderedMutationResult(recordLeak, request.targets, description), /opaque selector/);
  const readbackLeak = structuredClone(response);
  readbackLeak.outcomes[0].readback.provider_error = "raw";
  assert.throws(() => validateOrderedMutationResult(readbackLeak, request.targets, description), /forbidden private key/);
  const bogus = structuredClone(response);
  bogus.contract_version = "lead-director-evil/v1";
  bogus.outcomes[0].status = "succeeded";
  assert.throws(() => validateOrderedMutationResult(bogus, request.targets), /operation description/);
  assert.throws(() => validateOrderedMutationResult(bogus, request.targets, description), /contract_version/);
});

test("mutation result validators consume canonical in-progress state actions and terminal null recovery", async () => {
  const examples = await published("operation.examples.json");
  const descriptions = await published("describe.response.example.json");
  const createDescription = descriptions.operations.find(({operation}) => operation === "create");
  const updateDescription = descriptions.operations.find(({operation}) => operation === "update");
  const stateAction = {verb: "state", method: "GET", uri: "https://fixture.invalid/operations/corr-example", body: null};
  const inProgressCreate = {...structuredClone(examples.create.response), complete: false, status: "in_progress", record: null, receipt: null, error: null, retry_after_seconds: 2, action: stateAction};
  assert.equal(validateCreateResult(inProgressCreate, createDescription).action.verb, "state");
  assert.equal(validateCreateResult({...examples.create.response, retry_after_seconds: null, action: null}, createDescription).complete, true);
  const inProgressUpdate = {...structuredClone(examples.update.response), complete: false, retry_after_seconds: 2, action: stateAction};
  inProgressUpdate.outcomes[0] = {...inProgressUpdate.outcomes[0], status: "in_progress", readback: null, receipt: null, error: null};
  assert.equal(validateOrderedMutationResult(inProgressUpdate, examples.update.request.targets, updateDescription).action.method, "GET");
  assert.equal(validateOrderedMutationResult({...examples.update.response, retry_after_seconds: null, action: null}, examples.update.request.targets, updateDescription).complete, true);
  assert.throws(() => validateCreateResult({...inProgressCreate, retry_after_seconds: 0}, createDescription), /positive integer/);
  assert.throws(() => validateCreateResult({...examples.create.response, action: stateAction}, createDescription), /after completion/);
  assert.throws(() => validateOrderedMutationResult({...inProgressUpdate, complete: true}, examples.update.request.targets, updateDescription), /after completion|in-progress/);
});
