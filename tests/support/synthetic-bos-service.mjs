import {createServer} from "node:http";

const SOURCE = Object.freeze({platform: "bos", application: "lead-director", plugin: "synthetic-crm"});
const NOW = "2030-01-02T03:04:05Z";

const objectSchema = (properties = {}, required = []) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties,
  required,
  "x-bos-fields": []
});

const sourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {platform: {type: "string"}, application: {type: "string"}, plugin: {type: "string"}},
  required: ["platform", "application", "plugin"]
};

const searchInput = objectSchema({text: {type: "string", minLength: 1}, source: {...sourceSchema}}, ["text"]);
const searchOutput = objectSchema({
  contract_version: {type: "string"}, correlation_id: {type: "string"}, complete: {type: "boolean"}, observed_at: {type: "string", format: "date-time"},
  source_results: {type: "array", items: {type: "object", additionalProperties: true}}
}, ["contract_version", "correlation_id", "complete", "observed_at", "source_results"]);
const sourceInput = objectSchema({source: sourceSchema, changes: {type: "object", additionalProperties: true}}, ["source", "changes"]);
const targetsInput = objectSchema({targets: {type: "array", minItems: 1, maxItems: 5, items: {type: "object", additionalProperties: true}}}, ["targets"]);
const mutationOutput = {$schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: true, "x-bos-fields": []};

const limits = Object.freeze({max_targets: 5, max_results_per_source: 5, pagination_supported: false, bulk_supported: false, streaming_supported: false, maximum_duration_seconds: 30, maximum_fan_out: 5});
const guarantees = Object.freeze({read_consistency: "point_in_time", per_source_atomicity: "source_published", cross_source_atomicity: "eventually_consistent", convergence: "eventual", idempotency: "service_owned"});
const error_contract = Object.freeze({schema: "lead-director-public-error/v1", codes: ["SOURCE_TEMPORARILY_UNAVAILABLE", "VALIDATION_FAILED"]});

function operation(operation, effect, input_schema, output_schema, method = "POST") {
  return {
    operation,
    status: "described",
    effect,
    limits: structuredClone(limits),
    guarantees: structuredClone(guarantees),
    execution: {context_header: "X-BOS-Context-Handle", method, uri: `/synthetic/organizations/{organization}/operations/${operation}`},
    input_schema: structuredClone(input_schema),
    output_schema: structuredClone(output_schema),
    sources: [{source: structuredClone(SOURCE), availability: "ready"}],
    error_contract: structuredClone(error_contract)
  };
}

export function createSyntheticDocuments({variant = "alpha"} = {}) {
  const operations = [
    operation("search", "read", searchInput, searchOutput),
    operation("create", "create", sourceInput, mutationOutput),
    operation("update", "update", targetsInput, mutationOutput),
    operation("delete", "delete", targetsInput, mutationOutput),
    operation("calendar_read_event", "read", objectSchema({}, []), mutationOutput)
  ];
  if (variant === "beta") {
    operations[0].execution.uri = "/synthetic/organizations/{organization}/operations/search-v2";
    operations[0].input_schema.properties.text.maxLength = 512;
  }
  const discovery = {
    application: {platform: "bos", application: "lead-director"},
    describe: {contract_version: "lead-director-describe/v1", method: "POST", uri: "/synthetic/organizations/{organization}/describe", max_operations: 5, operations: operations.map(({operation: id}) => id)},
    bosl: {
      schema_uri: "bos://apps/lead-director/bosl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/schema",
      reference_uri: "bos://apps/lead-director/bosl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/reference",
      examples_uri: "bos://apps/lead-director/bosl/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/examples",
      descriptor_etag: variant === "alpha" ? "b".repeat(64) : "c".repeat(64)
    }
  };
  const examples = {
    search: {
      request: {text: "Synthetic Person"},
      response: {contract_version: "synthetic-search/v1", correlation_id: "corr-synthetic", complete: true, observed_at: NOW, source_results: [{source: structuredClone(SOURCE), status: "succeeded", observed_at: NOW, records: [{display_name: "Synthetic Person", public_selector: "synthetic-selector"}], error: null}]}
    },
    create: {request: {source: structuredClone(SOURCE), changes: {display_name: "Synthetic Person"}}, response: {contract_version: "lead-director-create/v1", correlation_id: "corr-synthetic", complete: true, status: "created", source: structuredClone(SOURCE), observed_at: NOW, record: {display_name: "Synthetic Person", public_selector: "synthetic-selector"}, receipt: {correlation_id: "corr-synthetic", service_id: "receipt-synthetic"}, error: null}},
    update: {request: {targets: [{source: structuredClone(SOURCE), record: {selector: "synthetic-selector"}, changes: {display_name: "Synthetic Person Updated"}}]}, response: {contract_version: "lead-director-update/v1", correlation_id: "corr-synthetic", complete: true, outcomes: [{source: structuredClone(SOURCE), record: {selector: "synthetic-selector"}, status: "updated", observed_at: NOW, readback: {display_name: "Synthetic Person Updated"}, receipt: {correlation_id: "corr-synthetic", service_id: "receipt-synthetic"}, error: null}]}},
    delete: {request: {targets: [{source: structuredClone(SOURCE), record: {selector: "synthetic-selector"}}]}, response: {contract_version: "lead-director-delete/v1", correlation_id: "corr-synthetic", complete: true, outcomes: [{source: structuredClone(SOURCE), record: {selector: "synthetic-selector"}, status: "deleted", observed_at: NOW, receipt: {correlation_id: "corr-synthetic", service_id: "receipt-synthetic"}, error: null}]}}
  };
  return {discovery, describe: {contract_version: "lead-director-describe/v1", metadata_version: `synthetic-${variant}`, observed_at: NOW, operations}, examples, source: structuredClone(SOURCE)};
}

async function json(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export async function startSyntheticBosService(options = {}) {
  const documents = createSyntheticDocuments(options);
  const calls = [];
  const server = createServer(async (request, response) => {
    const body = await json(request);
    calls.push({method: request.method, url: request.url, body: structuredClone(body)});
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/discovery") return response.end(JSON.stringify(documents.discovery));
    if (request.method === "POST" && request.url === "/synthetic/organizations/synthetic/describe") {
      const requested = body?.operations ?? [];
      return response.end(JSON.stringify({...documents.describe, operations: requested.map((id) => documents.describe.operations.find(({operation: current}) => current === id) ?? {operation: id, status: "not_available"})}));
    }
    const match = /^\/synthetic\/organizations\/synthetic\/operations\/(search(?:-v2)?|create|update|delete|calendar_read_event)$/.exec(request.url ?? "");
    if (match) {
      const id = match[1] === "search-v2" ? "search" : match[1];
      const value = documents.examples[id]?.response ?? {};
      return response.end(JSON.stringify(value));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({error: "not_found"}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const discoveryUrl = `http://127.0.0.1:${address.port}/discovery`;
  const fetchJson = async (url, init) => {
    const result = await fetch(url, init);
    return result.json();
  };
  const expand = (uri) => new URL(uri.replace("{organization}", "synthetic"), discoveryUrl).href;
  const discovery = {
    read: async () => fetchJson(discoveryUrl),
    refresh: async () => fetchJson(discoveryUrl, {cache: "no-store"}),
    describe: async (payload) => fetchJson(expand(documents.discovery.describe.uri), {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(payload)})
  };
  const bos = {
    recoverAuthentication: async () => ({status: "READY"}),
    invokeDiscoveredOperation: async (contact, payload) => {
      const init = {method: contact.execution.method, headers: {"content-type": "application/json"}};
      if (contact.execution.method !== "GET") init.body = JSON.stringify(payload);
      const result = await fetch(expand(contact.execution.uri), init);
      return {status: result.status, headers: {"content-type": result.headers.get("content-type")}, body: await result.json()};
    }
  };
  return {discoveryUrl, discovery, bos, calls, documents: structuredClone(documents), close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))};
}
