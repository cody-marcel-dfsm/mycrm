import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {authenticationCondition, BosContractClient, BosContractError} from "../src/bos/client.mjs";
import {createSyntheticDocuments, startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

function contractClient(options) {
  const http = options.http ?? {
    request: async ({method, uri, body, context_header}) => {
      if (Array.isArray(body?.operations)) return {status: 200, body: await options.discovery.describe(body)};
      return options.bos.invokeDiscoveredOperation({execution: {method, uri, context_header}}, body);
    }
  };
  return new BosContractClient({...options, bos: {verifyExecutionIntent: async () => true, captureExecutionScope: async () => async () => true, recoverAuthentication: async () => ({status: "READY"}), ...options.bos}, http});
}

const unsafeDiscoveredUris = [
  "/bos/synthetic/organizations/{organization}/describe",
  "/bos/synthetic/organizations/%7Borganization%7D/describe",
  "https://fixture.invalid/bos/organizations/synthetic/operation",
  "//fixture.invalid/bos/organizations/synthetic/operation",
  "/synthetic/organizations/synthetic/operation",
  "/bos/../organizations/synthetic/operation",
  "/bos/..?/organizations/synthetic/operation",
  "/bos/%2e%2e/organizations/synthetic/operation",
  "/bos/%2e./organizations/synthetic/operation",
  "/bos/.%2e/organizations/synthetic/operation",
  "/bos/%2e%2e%2forganizations/synthetic/operation",
  "/bos/action%3f/../organizations/synthetic/operation",
  "/bos/organizations/synthetic/operation#fragment",
  "/bos/organizations/synthetic/operation%23fragment",
  "/bos/organizations/synthetic/operation\r\nx-header:value",
  "/bos/organizations/synthetic/operation%0d%0ax-header:value",
  "/bos//organizations/synthetic/operation",
  "/bos/%2forganizations/synthetic/operation",
  "/bos/\\..\\organizations/synthetic/operation"
];
const publicError = (code) => ({
  code,
  message: "Authentication is required.",
  retryable: true,
  correlation_id: "corr-auth-1",
  details: []
});

const exactError = (code, suffix) => ({
  code,
  message: `Exact ${suffix} message.`,
  retryable: code !== "authorization_denied",
  correlation_id: `corr-${suffix}`,
  details: [{field: suffix}]
});

const thrownPublicError = (error, resource = null) => {
  const thrown = new Error("private transport text");
  thrown.body = {error: structuredClone(error)};
  if (resource !== null) thrown.resource = resource;
  return thrown;
};

const isExactPublicFailure = (expected) => (error) => {
  assert.ok(error instanceof BosContractError);
  assert.equal(error.message, expected.message);
  assert.equal(error.code, expected.code);
  assert.equal(error.retryable, expected.retryable);
  assert.equal(error.correlation_id, expected.correlation_id);
  assert.deepEqual(error.details, expected.details);
  assert.deepEqual(error.publicError, expected);
  return true;
};

function composedOperationAdapter({first, second, transport = "throw"}) {
  const counts = {adapter_calls: 0, requests: 0, recoveries: 0, client_recoveries: 0};
  const recoveryRequests = [];
  const operationRequests = [];
  const deliver = (error) => {
    if (transport === "throw") throw thrownPublicError(error, "/bos/protected-resource");
    const status = ["service_unavailable", "SOURCE_TEMPORARILY_UNAVAILABLE"].includes(error.code) ? 503 : error.code === "AUTHENTICATION_REQUIRED" ? 401 : 400;
    return {status, body: {error: structuredClone(error)}};
  };
  return {
    counts,
    recoveryRequests,
    operationRequests,
    bos: {
      recoverAuthentication: async (request) => {
        recoveryRequests.push(structuredClone(request));
        counts.client_recoveries += 1;
        counts.recoveries += 1;
        return {status: "READY"};
      },
      invokeDiscoveredOperation: async (contact, payload) => {
        counts.adapter_calls += 1;
        counts.requests += 1;
        operationRequests.push({contact: structuredClone(contact), payload: structuredClone(payload)});
        return deliver(counts.requests === 1 ? first : second);
      }
    }
  };
}

test("every package-declared authentication condition delegates to BOS", async () => {
  const product = JSON.parse(await readFile(new URL("../plugins/my-crm/.bos-product.json", import.meta.url), "utf8"));
  for (const code of product.authentication_handoff.recognized_condition_categories) {
    assert.deepEqual(authenticationCondition({code}), {
      category: code === "MCP_SESSION_CLOSED" ? "mcp_session" : "authentication",
      code,
      source: "protected_resource"
    });
  }
  assert.deepEqual(authenticationCondition({status: 401}), {
    category: "authentication",
    code: "AUTHORIZATION_REQUIRED",
    source: "protected_resource"
  });
});

test("ordinary MyCRM requests do not activate BOS authentication recovery", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let recoveryCalls = 0;
  const client = contractClient({
    discovery: service.discovery,
    bos: {
      invokeDiscoveredOperation: service.bos.invokeDiscoveredOperation,
      recoverAuthentication: async () => { recoveryCalls += 1; throw new Error("MyCRM must not call recovery"); }
    }
  });
  await client.describe(["search"]);
  await client.execute("search", {text: "Synthetic Person"});
  assert.equal(recoveryCalls, 0);
});

test("client builds the exact raw request from the current discovered execution contact", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const calls = [];
  const bos = {...service.bos, invokeDiscoveredOperation: async (contact, payload) => { calls.push({contact: structuredClone(contact), payload}); return service.bos.invokeDiscoveredOperation(contact, payload); }};
  const client = contractClient({discovery: service.discovery, bos});
  const operation = (await client.describe(["search"])).operations[0];
  await client.execute("search", {text: "Synthetic Person"});
  assert.deepEqual(calls[0], {contact: {execution: operation.execution}, payload: {text: "Synthetic Person"}});
});

test("invalid operation results and undiscovered operations fail closed", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = contractClient({discovery: service.discovery, bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: {}, headers: {authorization: "private"}})}});
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "Synthetic Person"}), /does not satisfy its schema/);
  await assert.rejects(client.execute("unadvertised", {}), (error) => error instanceof BosContractError && !("code" in error));
});

test("thrown operation authentication recovers, refreshes, redescribes, and resumes once", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let executions = 0;
  let recoveries = 0;
  const client = contractClient({
    discovery: service.discovery,
    bos: {
      ...service.bos,
      recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; },
      invokeDiscoveredOperation: async (contact, payload) => {
        executions += 1;
        if (executions === 1) { const error = new Error("private"); error.code = "INVALID_TOKEN"; throw error; }
        return service.bos.invokeDiscoveredOperation(contact, payload);
      }
    }
  });
  await client.describe(["search"]);
  assert.equal((await client.execute("search", {text: "Synthetic Person"})).status, 200);
  assert.equal(executions, 2);
  assert.equal(recoveries, 1);
});

test("MyCRM recovers once and preserves the terminal retry error", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const initial = exactError("invalid_request", "execute-initial");
  const directClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => { throw thrownPublicError(initial); }}
  });
  await directClient.describe(["search"]);
  await assert.rejects(directClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(initial));

  for (const expected of [exactError("service_unavailable", "execute-second-service"), exactError("invalid_request", "execute-second-invalid")]) {
    const adapter = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "execute-first-auth"), second: expected});
    const client = contractClient({
      discovery: service.discovery,
      bos: adapter.bos
    });
    await client.describe(["search"]);
    await assert.rejects(client.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(expected));
    assert.deepEqual(adapter.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});
    assert.equal(adapter.recoveryRequests.length, 1);
    assert.equal(adapter.operationRequests.length, 2);
  }
});

test("execute preserves valid unadvertised returned and thrown errors without authentication recovery", async () => {
  const documents = createSyntheticDocuments();
  documents.describe.operations[0].error_contract.codes = ["invalid_request"];
  const discovery = {
    read: async () => structuredClone(documents.discovery),
    refresh: async () => structuredClone(documents.discovery),
    describe: async () => structuredClone({...documents.describe, operations: [documents.describe.operations[0]]})
  };
  for (const mode of ["returned", "thrown"]) {
    for (const expected of [exactError("authorization_denied", `${mode}-authorization`), exactError("service_unavailable", `${mode}-service`), exactError("SOURCE_TEMPORARILY_UNAVAILABLE", `${mode}-uppercase`)]) {
      const adapter = composedOperationAdapter({first: expected, second: exactError("invalid_request", `${mode}-must-not-run`), transport: mode === "thrown" ? "throw" : "return"});
      const client = contractClient({
        discovery,
        bos: adapter.bos
      });
      await client.describe(["search"]);
      await assert.rejects(client.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(expected));
      assert.deepEqual(adapter.counts, {adapter_calls: 1, requests: 1, recoveries: 0, client_recoveries: 0});
    }
  }
});

test("execute preserves canonical nested operation errors while scanning every other output field", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const documents = createSyntheticDocuments();
  const contextHandle = `bos_ctx_v2_${"a".repeat(64)}`;
  const cases = [
    ["search", documents.examples.search.request, {code: "source_temporarily_unavailable", message: "The source is temporarily unavailable.", retryable: true, correlation_id: "corr-nested-search", details: []}, (body, error) => {
      body.source_results[0] = {...body.source_results[0], status: "failed", records: [], error};
    }],
    ["update", documents.examples.update.request, {code: "conflict", message: "The first line is exact.\nThe second line remains exact.", retryable: false, correlation_id: "corr-nested-update", details: []}, (body, error) => {
      Object.assign(body.outcomes[0], {status: "failed", readback: null, receipt: null, error});
    }],
    ["delete", documents.examples.delete.request, {code: "service_unavailable", message: "😀".repeat(2048), retryable: true, correlation_id: "corr-nested-delete", details: []}, (body, error) => {
      Object.assign(body.outcomes[0], {status: "failed", receipt: null, error});
    }]
  ];
  for (const [operation, input, expected, applyFailure] of cases.flatMap(([operation, input, error, applyFailure]) => [
    [operation, input, error, applyFailure],
    [operation, input, {...error, code: error.code.toUpperCase()}, applyFailure]
  ])) {
    const body = structuredClone(documents.examples[operation].response);
    applyFailure(body, structuredClone(expected));
    const client = contractClient({
      discovery: service.discovery,
      bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: structuredClone(body)})}
    });
    await client.describe([operation]);
    const response = await client.execute(operation, input);
    const nested = operation === "search" ? response.body.source_results[0].error : response.body.outcomes[0].error;
    assert.deepEqual(nested, expected);

    const malformed = structuredClone(body);
    const target = operation === "search" ? malformed.source_results[0]
      : malformed.outcomes[0];
    target.error = {...target.error};
    delete target.error.details;
    const malformedClient = contractClient({
      discovery: service.discovery,
      bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: structuredClone(malformed)})}
    });
    await malformedClient.describe([operation]);
    await assert.rejects(malformedClient.execute(operation, input), /public error shape is invalid/);

    const unsafeDetails = structuredClone(body);
    const unsafeTarget = operation === "search" ? unsafeDetails.source_results[0]
      : unsafeDetails.outcomes[0];
    unsafeTarget.error.details = [{value: contextHandle}];
    const unsafeDetailsClient = contractClient({
      discovery: service.discovery,
      bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: structuredClone(unsafeDetails)})}
    });
    await unsafeDetailsClient.describe([operation]);
    await assert.rejects(unsafeDetailsClient.execute(operation, input), /private implementation text/);
  }
});

test("exact returned canonical error envelopes are failures at every valid transport status", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  for (const status of [100, 200, 201, 299, 302, 400, 503, 599]) {
    const expected = {
      code: "service_unavailable",
      message: `Exact returned message for status ${status}.`,
      retryable: true,
      correlation_id: `corr-returned-${status}`,
      details: [{status}]
    };
    const client = contractClient({
      discovery: service.discovery,
      bos: {...service.bos, invokeDiscoveredOperation: async () => ({status, body: {error: structuredClone(expected)}})}
    });
    await client.describe(["search"]);
    await assert.rejects(client.execute("search", {text: "Synthetic Person"}), (error) => {
      assert.ok(isExactPublicFailure(expected)(error));
      assert.equal(error.status, status);
      return true;
    });
  }

  const siblingError = exactError("authorization_denied", "returned-with-siblings");
  const instruction = {message: "Reconnect the BOS plugin and retry when ready."};
  const siblingClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: {metadata: {kind: "public"}, error: siblingError, instruction}})}
  });
  await siblingClient.describe(["search"]);
  await assert.rejects(siblingClient.execute("search", {text: "Synthetic Person"}), (error) => {
    assert.ok(isExactPublicFailure(siblingError)(error));
    assert.deepEqual(error.instruction, instruction);
    return true;
  });

  const malformedClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 200, body: {metadata: {kind: "public"}, error: {code: "service_unavailable", message: "Incomplete"}}})}
  });
  await malformedClient.describe(["search"]);
  await assert.rejects(malformedClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && !Object.hasOwn(error, "code"));
});

test("schema-permitted error-null business data remains a successful response", async () => {
  const documents = createSyntheticDocuments();
  const operation = structuredClone(documents.describe.operations[0]);
  operation.output_schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    "x-bos-fields": [],
    required: ["error", "metadata"],
    properties: {
      error: {type: "null"},
      metadata: {type: "object", additionalProperties: true}
    }
  };
  const body = {error: null, metadata: {error: {message: "This is ordinary organization-defined business data."}}};
  const client = contractClient({
    discovery: {
      read: async () => structuredClone(documents.discovery),
      refresh: async () => structuredClone(documents.discovery),
      describe: async () => structuredClone({...documents.describe, operations: [operation]})
    },
    bos: {invokeDiscoveredOperation: async () => ({status: 200, body: structuredClone(body)})}
  });
  await client.describe(["search"]);
  assert.deepEqual(await client.execute("search", {text: "Synthetic Person"}), {status: 200, body});
});

test("the MyCRM client consumes challenged HTTP 401 within one recovery budget", async () => {
  const documents = createSyntheticDocuments();
  for (const expected of [exactError("service_unavailable", "returned-second-service"), exactError("authorization_denied", "returned-second-authorization")]) {
    const adapter = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "returned-first-auth"), second: expected, transport: "return"});
    const client = contractClient({
      discovery: {
        read: async () => structuredClone(documents.discovery),
        refresh: async () => structuredClone(documents.discovery),
        describe: async () => structuredClone({...documents.describe, operations: [documents.describe.operations[0]]})
      },
      bos: adapter.bos
    });
    await client.describe(["search"]);
    await assert.rejects(client.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(expected));
    assert.deepEqual(adapter.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});
  }

  const repeated = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "returned-first-auth"), second: exactError("authentication_required", "returned-second-auth"), transport: "return"});
  const repeatedClient = contractClient({
    discovery: {
      read: async () => structuredClone(documents.discovery),
      refresh: async () => structuredClone(documents.discovery),
      describe: async () => structuredClone({...documents.describe, operations: [documents.describe.operations[0]]})
    },
    bos: repeated.bos
  });
  await repeatedClient.describe(["search"]);
  await assert.rejects(repeatedClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_FAILED");
  assert.deepEqual(repeated.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});
});

test("authentication recovery waits through host action to READY and resumes once", async () => {
  const documents = createSyntheticDocuments();
  let requests = 0;
  let waits = 0;
  const client = contractClient({
    discovery: {
      read: async () => structuredClone(documents.discovery),
      refresh: async () => structuredClone(documents.discovery),
      describe: async ({operations}) => structuredClone({...documents.describe, operations: documents.describe.operations.filter(({operation}) => operations.includes(operation))})
    },
    bos: {
      recoverAuthentication: async () => ({status: "HOST_ACTION_REQUIRED"}),
      waitForAuthentication: async ({resource, condition}) => {
        waits += 1;
        assert.equal(resource, "/bos/protected-resource");
        assert.deepEqual(condition, {category: "authentication", code: "AUTHENTICATION_REQUIRED", source: "protected_resource"});
        return {status: "READY"};
      },
      invokeDiscoveredOperation: async (contact, payload) => {
        requests += 1;
        if (requests === 1) return {status: 401, resource: "/bos/protected-resource", body: {error: exactError("AUTHENTICATION_REQUIRED", "host-action")}};
        return {status: 200, body: structuredClone(documents.examples.search.response)};
      }
    }
  });
  await client.describe(["search"]);
  assert.equal((await client.execute("search", {text: "Synthetic Person"})).status, 200);
  assert.equal(waits, 1);
  assert.equal(requests, 2);
});

test("authentication continuation rejects a changed operation effect before retry", async () => {
  const documents = createSyntheticDocuments();
  let describes = 0;
  let requests = 0;
  const client = contractClient({
    discovery: {
      read: async () => structuredClone(documents.discovery),
      refresh: async () => structuredClone(documents.discovery),
      describe: async ({operations}) => {
        describes += 1;
        const described = structuredClone({...documents.describe, operations: documents.describe.operations.filter(({operation}) => operations.includes(operation))});
        if (describes > 1) described.operations[0].effect = "write";
        return described;
      }
    },
    bos: {
      recoverAuthentication: async () => ({status: "READY"}),
      invokeDiscoveredOperation: async () => {
        requests += 1;
        return {status: 401, body: {error: exactError("AUTHENTICATION_REQUIRED", "effect-change")}};
      }
    }
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "EFFECT_CHANGED");
  assert.equal(requests, 1);
  assert.equal(describes, 2);
});

test("discovery preserves exact non-authentication business failures without recovery", async () => {
  const documents = createSyntheticDocuments();
  for (const expected of [
    exactError("authorization_denied", "discovery-authorization"),
    exactError("service_unavailable", "discovery-service")
  ]) {
    let attempts = 0;
    let recoveries = 0;
    const client = contractClient({
      discovery: {
        read: async () => structuredClone(documents.discovery),
        refresh: async () => {
          attempts += 1;
          throw thrownPublicError(expected, "/discovery");
        },
        describe: async () => structuredClone(documents.describe)
      },
      bos: {recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }, invokeDiscoveredOperation: async () => ({status: 200, body: {}})}
    });
    await assert.rejects(client.refreshDiscovery(), isExactPublicFailure(expected));
    assert.equal(attempts, 1);
    assert.equal(recoveries, 0);
  }
});

test("Describe preserves exact non-authentication business failures without recovery", async () => {
  const documents = createSyntheticDocuments();
  for (const expected of [
    exactError("authorization_denied", "describe-authorization"),
    exactError("service_unavailable", "describe-service")
  ]) {
    let attempts = 0;
    let recoveries = 0;
    const client = contractClient({
      discovery: {
        read: async () => structuredClone(documents.discovery),
        refresh: async () => structuredClone(documents.discovery),
        describe: async () => {
          attempts += 1;
          throw thrownPublicError(expected);
        }
      },
      bos: {recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }, invokeDiscoveredOperation: async () => ({status: 200, body: {}})}
    });
    await assert.rejects(client.describe(["search"]), isExactPublicFailure(expected));
    assert.equal(attempts, 1);
    assert.equal(recoveries, 0);
  }
});

test("discovery and Describe delegate uppercase handoff and challenged HTTP 401 through READY once", async () => {
  const documents = createSyntheticDocuments();
  const recoveryRequests = [];
  let readyCallbacks = 0;
  let refreshAttempts = 0;
  let describeAttempts = 0;
  const discoveryCondition = new Error("private discovery condition");
  discoveryCondition.code = "mcp_session_closed";
  discoveryCondition.resource = "/bos/discovery";
  const describeCondition = new Error("private Describe challenge");
  describeCondition.status = 401;
  describeCondition.resource = "/bos/describe";
  const client = contractClient({
    discovery: {
      read: async () => structuredClone(documents.discovery),
      refresh: async () => {
        refreshAttempts += 1;
        if (refreshAttempts === 1) throw discoveryCondition;
        return structuredClone(documents.discovery);
      },
      describe: async ({operations}) => {
        describeAttempts += 1;
        if (describeAttempts === 1) throw describeCondition;
        return structuredClone({...documents.describe, operations: documents.describe.operations.filter(({operation}) => operations.includes(operation))});
      }
    },
    bos: {
      recoverAuthentication: async (request) => { recoveryRequests.push(structuredClone(request)); return {status: "READY"}; },
      invokeDiscoveredOperation: async () => ({status: 200, body: {}})
    },
    onAuthenticationReady: async () => { readyCallbacks += 1; }
  });

  await client.refreshDiscovery();
  await client.describe(["search"]);
  assert.equal(refreshAttempts, 3);
  assert.equal(describeAttempts, 2);
  assert.equal(readyCallbacks, 2);
  assert.deepEqual(recoveryRequests, [
    {resource: "/bos/discovery", condition: {category: "mcp_session", code: "MCP_SESSION_CLOSED", source: "protected_resource"}},
    {resource: "/bos/describe", condition: {category: "authentication", code: "AUTHORIZATION_REQUIRED", source: "protected_resource"}}
  ]);
});

test("canonical non-authentication terminal failures remain exact", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const documents = createSyntheticDocuments();

  const executeFailure = exactError("authorization_denied", "execute-terminal-authorization");
  const executeClient = contractClient({
    discovery: service.discovery,
    bos: {invokeDiscoveredOperation: async () => { throw thrownPublicError(executeFailure); }}
  });
  await executeClient.describe(["search"]);
  await assert.rejects(executeClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(executeFailure));

  const discoveryFailure = exactError("authorization_denied", "discovery-terminal-authorization");
  const discoveryClient = contractClient({
    discovery: {read: async () => structuredClone(documents.discovery), refresh: async () => { throw thrownPublicError(discoveryFailure); }, describe: async () => structuredClone(documents.describe)},
    bos: {invokeDiscoveredOperation: async () => ({status: 200, body: {}})}
  });
  await assert.rejects(discoveryClient.refreshDiscovery(), isExactPublicFailure(discoveryFailure));

  const describeFailure = exactError("service_unavailable", "describe-terminal-service");
  const describeClient = contractClient({
    discovery: {read: async () => structuredClone(documents.discovery), refresh: async () => structuredClone(documents.discovery), describe: async () => { throw thrownPublicError(describeFailure); }},
    bos: {invokeDiscoveredOperation: async () => ({status: 200, body: {}})}
  });
  await assert.rejects(describeClient.describe(["search"]), isExactPublicFailure(describeFailure));
});

test("safe service-owned message content and newlines remain exact across discovery, execute, and recovery", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const documents = createSyntheticDocuments();
  const message = "The service could not complete the request.\nContact support with the correlation reference.";
  const failure = (code, correlation_id) => ({code, message, retryable: true, correlation_id, details: [{field: "message"}]});

  const discoveryFailure = failure("authorization_denied", "corr-message-discovery");
  const discoveryClient = contractClient({
    discovery: {read: async () => structuredClone(documents.discovery), refresh: async () => { throw thrownPublicError(discoveryFailure); }, describe: async () => structuredClone(documents.describe)},
    bos: {recoverAuthentication: async () => ({status: "READY"}), invokeDiscoveredOperation: async () => ({status: 200, body: {}})}
  });
  await assert.rejects(discoveryClient.refreshDiscovery(), isExactPublicFailure(discoveryFailure));

  const returnedFailure = failure("service_unavailable", "corr-message-returned");
  const returnedClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 503, body: {error: returnedFailure}})}
  });
  await returnedClient.describe(["search"]);
  await assert.rejects(returnedClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(returnedFailure));

  const unavailableFailure = failure("authentication_required", "corr-message-unavailable");
  const unavailableClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, recoverAuthentication: async () => ({status: "NOT_READY"}), invokeDiscoveredOperation: async () => { throw thrownPublicError(unavailableFailure); }}
  });
  await unavailableClient.describe(["search"]);
  await assert.rejects(unavailableClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_PENDING");

  const secondFailure = failure("service_unavailable", "corr-message-second");
  const adapter = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "message-first-auth"), second: secondFailure});
  const recoveredClient = contractClient({
    discovery: service.discovery,
    bos: adapter.bos
  });
  await recoveredClient.describe(["search"]);
  await assert.rejects(recoveredClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(secondFailure));
  assert.deepEqual(adapter.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});
});

test("message whitespace and Unicode code-point limits remain exact across execution recovery states", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const whitespaceFailure = {code: "service_unavailable", message: " \n\t ", retryable: true, correlation_id: "corr-whitespace", details: []};
  const directClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 503, body: {error: whitespaceFailure}})}
  });
  await directClient.describe(["search"]);
  await assert.rejects(directClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(whitespaceFailure));

  const maximumMessage = "😀".repeat(2048);
  const unavailableFailure = {code: "authentication_required", message: maximumMessage, retryable: true, correlation_id: "corr-unicode-unavailable", details: []};
  const unavailableClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, recoverAuthentication: async () => ({status: "NOT_READY"}), invokeDiscoveredOperation: async () => { throw thrownPublicError(unavailableFailure); }}
  });
  await unavailableClient.describe(["search"]);
  await assert.rejects(unavailableClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_PENDING");

  const postRecoveryFailure = {code: "service_unavailable", message: maximumMessage, retryable: true, correlation_id: "corr-unicode-second", details: []};
  const postRecoveryAdapter = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "unicode-first-auth"), second: postRecoveryFailure});
  const recoveredClient = contractClient({
    discovery: service.discovery,
    bos: postRecoveryAdapter.bos
  });
  await recoveredClient.describe(["search"]);
  await assert.rejects(recoveredClient.execute("search", {text: "Synthetic Person"}), isExactPublicFailure(postRecoveryFailure));
  assert.deepEqual(postRecoveryAdapter.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});

  const excessiveFailure = {code: "service_unavailable", message: "😀".repeat(2049), retryable: true, correlation_id: "corr-unicode-too-long", details: []};
  const isLocalUncoded = (error) => error instanceof BosContractError && !Object.hasOwn(error, "code") && error.publicError === null;
  const excessiveDirectClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 503, body: {error: excessiveFailure}})}
  });
  await excessiveDirectClient.describe(["search"]);
  await assert.rejects(excessiveDirectClient.execute("search", {text: "Synthetic Person"}), isLocalUncoded);

  let unavailableRecoveries = 0;
  const excessiveUnavailableClient = contractClient({
    discovery: service.discovery,
    bos: {
      ...service.bos,
      recoverAuthentication: async () => { unavailableRecoveries += 1; return {status: "NOT_READY"}; },
      invokeDiscoveredOperation: async () => { throw thrownPublicError({...excessiveFailure, code: "authentication_required"}); }
    }
  });
  await excessiveUnavailableClient.describe(["search"]);
  await assert.rejects(excessiveUnavailableClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_PENDING");
  assert.equal(unavailableRecoveries, 1);

  const excessivePostAdapter = composedOperationAdapter({first: exactError("AUTHENTICATION_REQUIRED", "excessive-first-auth"), second: excessiveFailure});
  const excessivePostClient = contractClient({
    discovery: service.discovery,
    bos: excessivePostAdapter.bos
  });
  await excessivePostClient.describe(["search"]);
  await assert.rejects(excessivePostClient.execute("search", {text: "Synthetic Person"}), isLocalUncoded);
  assert.deepEqual(excessivePostAdapter.counts, {adapter_calls: 2, requests: 2, recoveries: 1, client_recoveries: 1});
});

test("malformed execute, discovery, and Describe failures remain local and uncoded", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const malformed = {...exactError("invalid_request", "malformed"), details: null};
  const executeClient = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => { throw thrownPublicError(malformed); }}
  });
  await executeClient.describe(["search"]);
  await assert.rejects(executeClient.execute("search", {text: "Synthetic Person"}), (error) => error instanceof BosContractError && !Object.hasOwn(error, "code") && error.publicError === null);

  const documents = createSyntheticDocuments();
  const localBos = {recoverAuthentication: async () => ({status: "READY"}), invokeDiscoveredOperation: async () => ({status: 200, body: {}})};
  const discoveryClient = contractClient({
    discovery: {read: async () => structuredClone(documents.discovery), refresh: async () => { throw thrownPublicError(malformed); }, describe: async () => structuredClone(documents.describe)},
    bos: localBos
  });
  await assert.rejects(discoveryClient.refreshDiscovery(), (error) => error instanceof BosContractError && !Object.hasOwn(error, "code") && error.publicError === null);
  const describeClient = contractClient({
    discovery: {read: async () => structuredClone(documents.discovery), refresh: async () => structuredClone(documents.discovery), describe: async () => { throw thrownPublicError(malformed); }},
    bos: localBos
  });
  await assert.rejects(describeClient.describe(["search"]), (error) => error instanceof BosContractError && !Object.hasOwn(error, "code") && error.publicError === null);
});

test("MyCRM does not replay terminal non-authentication Describe failures or refresh discovery implicitly", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let attempts = 0;
  let refreshes = 0;
  const discovery = {...service.discovery, refresh: async () => { refreshes += 1; return service.discovery.refresh(); }, describe: async (payload) => {
    attempts += 1;
    const error = new Error("private"); error.body = {error: publicError("service_unavailable")}; error.resource = service.discoveryUrl; throw error;
  }};
  let recoveries = 0;
  const client = contractClient({discovery, bos: {...service.bos, recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }}});
  await assert.rejects(client.describe(["search"]), (error) => error.code === "service_unavailable");
  assert.equal(attempts, 1);
  assert.equal(refreshes, 0);
  assert.equal(recoveries, 0);
});

test("discovery schema changes invalidate stale descriptions", async (context) => {
  const first = await startSyntheticBosService({variant: "alpha"});
  const second = await startSyntheticBosService({variant: "beta"});
  context.after(first.close); context.after(second.close);
  let current = first;
  const discovery = {read: () => current.discovery.read(), refresh: () => current.discovery.refresh(), describe: (payload) => current.discovery.describe(payload)};
  const client = contractClient({discovery, bos: first.bos});
  await client.describe(["search"]);
  current = second;
  await client.refreshDiscovery();
  assert.throws(() => client.getDescription("search"), /has not been described/);
});

test("unsafe Describe contacts fail before Describe or operation transport", async () => {
  for (const uri of unsafeDiscoveredUris) {
    const documents = createSyntheticDocuments();
    documents.discovery.describe.uri = uri;
    let describeCalls = 0;
    let operationCalls = 0;
    const client = contractClient({
      discovery: {
        read: async () => structuredClone(documents.discovery),
        refresh: async () => structuredClone(documents.discovery),
        describe: async () => { describeCalls += 1; return structuredClone(documents.describe); }
      },
      bos: {
        recoverAuthentication: async () => ({status: "READY"}),
        invokeDiscoveredOperation: async () => { operationCalls += 1; return {status: 200, body: {}}; }
      }
    });
    await assert.rejects(client.describe(["search"]), /safe origin-relative \/bos\/ URI/);
    assert.equal(describeCalls, 0, uri);
    assert.equal(operationCalls, 0, uri);
  }
});

test("unsafe operation contacts fail before operation transport", async () => {
  for (const uri of unsafeDiscoveredUris) {
    const documents = createSyntheticDocuments();
    documents.describe.operations[0].execution.uri = uri;
    let operationCalls = 0;
    const client = contractClient({
      discovery: {
        read: async () => structuredClone(documents.discovery),
        refresh: async () => structuredClone(documents.discovery),
        describe: async () => structuredClone({...documents.describe, operations: [documents.describe.operations[0]]})
      },
      bos: {
        recoverAuthentication: async () => ({status: "READY"}),
        invokeDiscoveredOperation: async () => { operationCalls += 1; return {status: 200, body: {}}; }
      }
    });
    await assert.rejects(client.describe(["search"]), /safe origin-relative \/bos\/ URI/);
    assert.equal(operationCalls, 0, uri);
  }
});
