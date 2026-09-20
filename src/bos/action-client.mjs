import {assertNoPrivateKeys, validateJsonSchema, validateJsonValueAgainstSchema} from "./contracts.mjs";

function absoluteHttpsUri(value, label) {
  let uri;
  try { uri = new URL(value); } catch { throw new TypeError(`${label} must be absolute HTTPS`); }
  if (uri.protocol !== "https:") throw new TypeError(`${label} must be absolute HTTPS`);
  if (uri.username || uri.password) throw new TypeError(`${label} must not contain credentials`);
  if (uri.hash) throw new TypeError(`${label} must not contain a fragment`);
  return value;
}

export function validateResolvedAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("returned action must be an object");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["method", "payload_schema", "uri"])) throw new TypeError("returned action contains unsupported fields");
  const method = value.method;
  if (!["DELETE", "GET", "PATCH", "POST", "PUT"].includes(method)) throw new TypeError("returned action method is invalid");
  absoluteHttpsUri(value.uri, "returned action URI");
  if (!(value.payload_schema === null || (value.payload_schema && typeof value.payload_schema === "object" && !Array.isArray(value.payload_schema)))) throw new TypeError("returned action payload_schema must be an object or null");
  if (value.payload_schema !== null) validateJsonSchema(value.payload_schema, "returned action payload");
  const result = {method, uri: value.uri, payload_schema: structuredClone(value.payload_schema)};
  assertNoPrivateKeys(result, "returned action");
  return result;
}

export function validateOperationStateAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("operation state action must be an object");
  const allowed = new Set(["body", "method", "uri", "verb"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`operation state action contains unsupported field ${key}`);
  if (!("uri" in value)) throw new TypeError("operation state action uri is required");
  if (value.verb !== undefined && value.verb !== "state") throw new TypeError("operation state action verb must be state");
  if (value.method !== undefined && value.method !== "GET") throw new TypeError("operation state action method must be GET");
  if (value.body !== undefined && value.body !== null) throw new TypeError("operation state action body must be null");
  const result = {verb: value.verb ?? "state", method: value.method ?? "GET", uri: absoluteHttpsUri(value.uri, "operation state action URI"), body: null};
  assertNoPrivateKeys(result, "operation state action");
  return result;
}

export class ReturnedActionClient {
  constructor({http}) {
    if (typeof http?.request !== "function") throw new TypeError("http.request is required");
    this.http = http;
  }

  async invoke(value, payload) {
    const current = validateResolvedAction(value);
    if (current.payload_schema === null) {
      if (payload !== undefined) throw new TypeError("A bodyless returned action cannot receive a payload");
      return this.http.request({method: current.method, uri: current.uri, headers: {}});
    }
    if (payload === undefined) throw new TypeError("Returned action payload is required");
    validateJsonValueAgainstSchema(payload, current.payload_schema, "returned action payload");
    return this.http.request({method: current.method, uri: current.uri, headers: {"content-type": "application/json"}, body: structuredClone(payload)});
  }
}

export class OperationStateActionClient {
  constructor({http}) {
    if (typeof http?.request !== "function") throw new TypeError("http.request is required");
    this.http = http;
  }

  async invoke(value, payload) {
    const current = validateOperationStateAction(value);
    if (payload !== undefined) throw new TypeError("An operation state action is physically bodyless");
    return this.http.request({method: current.method, uri: current.uri, headers: {}});
  }
}
