import assert from "node:assert/strict";
import test from "node:test";
import { BosMcpClient, BosMcpError, MY_CRM_RESOURCE } from "../src/bos/client.mjs";

function transport(tools, results = {}) {
  const calls = [];
  return {
    calls,
    refreshConnection: async (request) => { calls.push({ method: "refreshConnection", request }); return { ready: true }; },
    listTools: async (request) => { calls.push({ method: "listTools", request }); return { tools }; },
    callTool: async (request) => { calls.push({ method: "callTool", request }); return results[request.name] ?? { structuredContent: { ok: true } }; },
    listResources: async (request) => { calls.push({ method: "listResources", request }); return { resources: [{ uri: "bos://graph/current" }] }; },
    readResource: async (request) => { calls.push({ method: "readResource", request }); return { contents: [{ uri: request.uri }] }; }
  };
}

function bosDependency(
  recoverAuthentication = async () => ({ status: "READY" }),
  waitForAuthenticationReady = async () => ({ status: "READY" })
) {
  return { recoverAuthentication, waitForAuthenticationReady };
}

function mutationReconciler(reconcile = async () => ({ outcome: "retry_safe" })) {
  return { reconcile };
}

const searchTool = {
  name: "crm_search_current",
  semanticOperation: "crm.records.search",
  sideEffect: "read",
  inputSchema: { type: "object" }
};

test("client seals the current My CRM product resource", () => {
  const live = transport([]);
  const client = new BosMcpClient({ transport: live, bosDependency: bosDependency(), mutationReconciler: mutationReconciler() });
  assert.equal(client.resourceUrl, MY_CRM_RESOURCE);
  assert.throws(() => new BosMcpClient({ transport: live }), /required BOS plugin/);
  assert.throws(() => new BosMcpClient({ transport: live, bosDependency: bosDependency(), mutationReconciler: mutationReconciler(), resourceUrl: "https://example.com/mcp" }), /must remain/);
});

test("client uses the product connection only for discovered My CRM operations", async () => {
  const live = transport([searchTool]);
  const client = new BosMcpClient({ transport: live, bosDependency: bosDependency(), mutationReconciler: mutationReconciler() });
  assert.equal(client.getContext, undefined);
  await client.refreshCatalog();
  await client.invoke("crm.records.search", { query: { text: "Ada" } }, { expectedSideEffect: "read" });
  assert.ok(live.calls.every(({ request }) => request.resourceUrl === MY_CRM_RESOURCE));
  assert.equal(live.calls.at(-1).request.name, "crm_search_current");
});

test("live semantic discovery selects the tool and rejects absent or mismatched operations", async () => {
  const client = new BosMcpClient({ transport: transport([searchTool]), bosDependency: bosDependency(), mutationReconciler: mutationReconciler() });
  await client.refreshCatalog();
  assert.equal(client.resolveOperation("crm.records.search").name, "crm_search_current");
  assert.throws(() => client.resolveOperation("crm.records.delete"), (error) => error instanceof BosMcpError && error.code === "operation_unavailable");
  assert.throws(() => client.resolveOperation("crm.records.search", { expectedSideEffect: "write" }), (error) => error.code === "side_effect_mismatch");
});

test("resources are read only from listed host URIs", async () => {
  const live = transport([]);
  const client = new BosMcpClient({ transport: live, bosDependency: bosDependency(), mutationReconciler: mutationReconciler() });
  const inventory = await client.listResources();
  await client.readResource(inventory.resources[0].uri);
  assert.equal(live.calls.at(-1).request.uri, "bos://graph/current");
});

test("structured MCP failures remain typed and credential-free", async () => {
  const denied = { isError: true, structuredContent: { error: { code: "capability_denied", details: { reason: "role" } } } };
  const live = transport([searchTool], { crm_search_current: denied });
  const client = new BosMcpClient({ transport: live, bosDependency: bosDependency(), mutationReconciler: mutationReconciler() });
  await client.refreshCatalog();
  await assert.rejects(client.invoke("crm.records.search", {}), (error) => {
    assert.ok(error instanceof BosMcpError);
    assert.equal(error.code, "capability_denied");
    assert.equal(JSON.stringify(error).includes("token"), false);
    return true;
  });
});

test("authentication challenges delegate to BOS and resume the CRM operation automatically", async () => {
  const recoveries = [];
  let attempts = 0;
  const live = transport([searchTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    if (attempts === 1) {
      return {
        isError: true,
        _meta: { "mcp/www_authenticate": "Bearer resource_metadata=..." },
        structuredContent: { error: { code: "authentication_required" } }
      };
    }
    return { structuredContent: { records: [] } };
  };
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(async (request) => { recoveries.push(request); }),
    mutationReconciler: mutationReconciler()
  });
  await client.refreshCatalog();
  const result = await client.invoke("crm.records.search", {}, { expectedSideEffect: "read" });
  assert.deepEqual(result.structuredContent.records, []);
  assert.equal(recoveries.length, 1);
  assert.deepEqual(Object.keys(recoveries[0]).sort(), ["reason", "resourceUrl"]);
  assert.equal(recoveries[0].reason, "authentication_required");
  assert.equal(attempts, 2);
  assert.equal(live.calls.filter(({ method }) => method === "listTools").length, 2);
  assert.equal(live.calls.filter(({ method }) => method === "refreshConnection").length, 1);
});

for (const code of ["missing_grant", "expired_token", "revoked_grant", "mcp_www_authenticate", "mcp_session_closed"]) {
  test(`declared ${code} recovery delegates to BOS and refreshes the connection`, async () => {
    const recoveries = [];
    let attempts = 0;
    const live = transport([searchTool]);
    live.listResources = async (request) => {
      live.calls.push({ method: "listResources", request });
      attempts += 1;
      if (attempts === 1) throw new BosMcpError("recover", { code });
      return { resources: [] };
    };
    const client = new BosMcpClient({
      transport: live,
      bosDependency: bosDependency(async (request) => { recoveries.push(request); }),
      mutationReconciler: mutationReconciler()
    });
    await client.listResources();
    assert.equal(recoveries[0].reason, code);
    assert.deepEqual(Object.keys(recoveries[0]).sort(), ["reason", "resourceUrl"]);
    assert.equal(live.calls.filter(({ method }) => method === "refreshConnection").length, 1);
    assert.equal(live.calls.filter(({ method }) => method === "listTools").length, 1);
    assert.equal(attempts, 2);
  });
}

const writeTool = {
  name: "crm_update_current",
  semanticOperation: "crm.records.update",
  sideEffect: "write",
  inputSchema: { type: "object" }
};

test("an authentication-interrupted mutation returns a reconciled committed result without replay", async () => {
  let attempts = 0;
  const live = transport([writeTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    throw new BosMcpError("expired", { code: "expired_token" });
  };
  const committed = { structuredContent: { updated: true, reconciled: true } };
  const reconciliations = [];
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(),
    mutationReconciler: mutationReconciler(async (request) => {
      reconciliations.push(request);
      return { outcome: "committed", result: committed };
    })
  });
  const result = await client.invoke("crm.records.update", { record: "lead-1" }, { expectedSideEffect: "write" });
  assert.equal(result, committed);
  assert.equal(attempts, 1);
  assert.equal(reconciliations.length, 1);
});

test("an authentication-interrupted mutation replays once only when reconciliation says retry_safe", async () => {
  let attempts = 0;
  const live = transport([writeTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    if (attempts === 1) throw new BosMcpError("expired", { code: "expired_token" });
    return { structuredContent: { updated: true } };
  };
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(),
    mutationReconciler: mutationReconciler()
  });
  await client.invoke("crm.records.update", { record: "lead-1" }, { expectedSideEffect: "write" });
  assert.equal(attempts, 2);
});

test("an authentication-interrupted mutation with an unknown outcome is never replayed", async () => {
  let attempts = 0;
  const live = transport([writeTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    throw new BosMcpError("expired", { code: "expired_token" });
  };
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(),
    mutationReconciler: mutationReconciler(async () => ({ outcome: "unknown" }))
  });
  await assert.rejects(
    client.invoke("crm.records.update", { record: "lead-1" }, { expectedSideEffect: "write" }),
    (error) => error instanceof BosMcpError && error.code === "mutation_reconciliation_required"
  );
  assert.equal(attempts, 1);
});

test("continuation waits for BOS readiness and does not execute while authentication remains unavailable", async () => {
  let attempts = 0;
  let waits = 0;
  const live = transport([searchTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    throw new BosMcpError("expired", { code: "expired_token" });
  };
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(
      async () => ({ status: "HOST_ACTION_REQUIRED" }),
      async () => { waits += 1; return { status: "NOT_READY" }; }
    ),
    mutationReconciler: mutationReconciler()
  });
  await assert.rejects(
    client.invoke("crm.records.search", {}, { expectedSideEffect: "read" }),
    (error) => error instanceof BosMcpError && error.code === "authentication_recovery_pending"
  );
  assert.equal(waits, 1);
  assert.equal(attempts, 1);
  assert.equal(live.calls.filter(({ method }) => method === "refreshConnection").length, 0);
});

test("an interrupted write remains a mutation when refreshed discovery changes its side-effect", async () => {
  let attempts = 0;
  let reconciliations = 0;
  const live = transport([writeTool]);
  live.callTool = async (request) => {
    live.calls.push({ method: "callTool", request });
    attempts += 1;
    throw new BosMcpError("expired", { code: "expired_token" });
  };
  live.listTools = async (request) => {
    live.calls.push({ method: "listTools", request });
    return { tools: attempts === 0 ? [writeTool] : [{ ...writeTool, sideEffect: "read" }] };
  };
  const client = new BosMcpClient({
    transport: live,
    bosDependency: bosDependency(),
    mutationReconciler: mutationReconciler(async () => {
      reconciliations += 1;
      return { outcome: "retry_safe" };
    })
  });
  await assert.rejects(
    client.invoke("crm.records.update", {}, { expectedSideEffect: "write" }),
    (error) => error instanceof BosMcpError && error.code === "side_effect_mismatch"
  );
  assert.equal(reconciliations, 1);
  assert.equal(attempts, 1);
});
