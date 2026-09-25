import assert from "node:assert/strict";
import test from "node:test";

import {BosContractClient} from "../src/bos/client.mjs";
import {validateJsonValueAgainstSchema, validatePublicError} from "../src/bos/contracts.mjs";
import {startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

test("discovery URL returns operation-scoped Describe contracts and runtime schemas", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  const described = await client.describe(["search", "update"]);
  assert.deepEqual(described.operations.map(({operation}) => operation), ["search", "update"]);
  for (const operation of described.operations) {
    validateJsonValueAgainstSchema(operation.operation === "search" ? {text: "Synthetic Person"} : service.documents.examples.update.request, operation.input_schema, `${operation.operation} input`);
  }
});

test("operations absent from discovery cannot be described or executed", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  await assert.rejects(client.describe(["unknown_operation"]), /not present in current discovery/);
  await assert.rejects(client.execute("unknown_operation", {}), /not been described/);
});

test("discovered schemas enforce current scalar constraints", async (context) => {
  const service = await startSyntheticBosService({variant: "beta"});
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, bos: service.bos});
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: ""}), /does not satisfy its schema/);
  await assert.rejects(client.execute("search", {text: "x".repeat(513)}), /does not satisfy its schema/);
});

test("public errors reject provider and internal leakage", () => {
  assert.throws(() => validatePublicError({code: "FAILED", message: "SQLSTATE private", retryable: false, correlation_id: "corr"}), /private implementation/);
  assert.throws(() => validatePublicError({code: "FAILED", message: "Safe", retryable: false, correlation_id: "corr", details: [{access_token: "private"}]}), /private key/);
});
