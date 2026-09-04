import assert from "node:assert/strict";
import test from "node:test";
import { BosMcpClient, BosMcpError, MY_CRM_RESOURCE } from "../src/bos/client.mjs";

function transport(tools, results = {}) {
  const calls = [];
  return {
    calls,
    listTools: async (request) => { calls.push({ method: "listTools", request }); return { tools }; },
    callTool: async (request) => { calls.push({ method: "callTool", request }); return results[request.name] ?? { structuredContent: { ok: true } }; },
    listResources: async (request) => { calls.push({ method: "listResources", request }); return { resources: [{ uri: "bos://graph/current" }] }; },
    readResource: async (request) => { calls.push({ method: "readResource", request }); return { contents: [{ uri: request.uri }] }; }
  };
}

const contextTool = { name: "bos_get_context", inputSchema: { type: "object" } };
const searchTool = {
  name: "crm_search_current",
  semanticOperation: "crm.records.search",
  sideEffect: "read",
  inputSchema: { type: "object" }
};

test("client seals the current My CRM product resource", () => {
  const live = transport([]);
  const client = new BosMcpClient({ transport: live });
  assert.equal(client.resourceUrl, MY_CRM_RESOURCE);
  assert.throws(() => new BosMcpClient({ transport: live, resourceUrl: "https://example.com/mcp" }), /must remain/);
});

test("context and operations use the same product connection", async () => {
  const live = transport([contextTool, searchTool], { bos_get_context: { structuredContent: { contexts: [] } } });
  const client = new BosMcpClient({ transport: live });
  await client.getContext();
  await client.invoke("crm.records.search", { context_id: "opaque", query: { text: "Ada" } }, { expectedSideEffect: "read" });
  assert.ok(live.calls.every(({ request }) => request.resourceUrl === MY_CRM_RESOURCE));
  assert.equal(live.calls.at(-1).request.name, "crm_search_current");
});

test("live semantic discovery selects the tool and rejects absent or mismatched operations", async () => {
  const client = new BosMcpClient({ transport: transport([contextTool, searchTool]) });
  await client.refreshCatalog();
  assert.equal(client.resolveOperation("crm.records.search").name, "crm_search_current");
  assert.throws(() => client.resolveOperation("crm.records.delete"), (error) => error instanceof BosMcpError && error.code === "operation_unavailable");
  assert.throws(() => client.resolveOperation("crm.records.search", { expectedSideEffect: "write" }), (error) => error.code === "side_effect_mismatch");
});

test("resources are read only from listed host URIs", async () => {
  const live = transport([contextTool]);
  const client = new BosMcpClient({ transport: live });
  const inventory = await client.listResources();
  await client.readResource(inventory.resources[0].uri);
  assert.equal(live.calls.at(-1).request.uri, "bos://graph/current");
});

test("structured MCP failures remain typed and credential-free", async () => {
  const denied = { isError: true, structuredContent: { error: { code: "capability_denied", details: { reason: "role" } } } };
  const live = transport([contextTool, searchTool], { crm_search_current: denied });
  const client = new BosMcpClient({ transport: live });
  await client.refreshCatalog();
  await assert.rejects(client.invoke("crm.records.search", {}), (error) => {
    assert.ok(error instanceof BosMcpError);
    assert.equal(error.code, "capability_denied");
    assert.equal(JSON.stringify(error).includes("token"), false);
    return true;
  });
});
