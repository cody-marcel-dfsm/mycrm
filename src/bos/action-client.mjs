import {assertNoPrivateKeys, validateJsonSchema, validateJsonValueAgainstSchema} from "./contracts.mjs";

const ACTION_VERBS = new Set(["start", "complete", "step", "failed", "state"]);

function originRelativeHref(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("#") || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
    throw new TypeError(`${label} must be an origin-relative URI without traversal or fragment`);
  }
  return value;
}

export function validateResolvedAction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("returned action must be an object");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["href", "method", "payload_schema", "verb"])) throw new TypeError("returned action contains unsupported fields");
  if (!ACTION_VERBS.has(value.verb)) throw new TypeError("returned action verb is invalid");
  const expectedMethod = value.verb === "state" ? "GET" : "POST";
  if (value.method !== expectedMethod) throw new TypeError(`returned ${value.verb} action method must be ${expectedMethod}`);
  originRelativeHref(value.href, "returned action href");
  if (!(value.payload_schema === null || (value.payload_schema && typeof value.payload_schema === "object" && !Array.isArray(value.payload_schema)))) throw new TypeError("returned action payload_schema must be an object or null");
  if (value.verb === "state" && value.payload_schema !== null) throw new TypeError("returned state action must be bodyless");
  if (value.payload_schema !== null) validateJsonSchema(value.payload_schema, "returned action payload");
  const result = {verb: value.verb, method: value.method, href: value.href, payload_schema: structuredClone(value.payload_schema)};
  assertNoPrivateKeys(result, "returned action");
  return result;
}

export function validateOperationStateAction(value) {
  const action = validateResolvedAction(value);
  if (action.verb !== "state") throw new TypeError("operation state action verb must be state");
  return action;
}

export class ReturnedActionClient {
  constructor({bos}) {
    if (typeof bos?.invokeReturnedAction !== "function") throw new TypeError("bos.invokeReturnedAction is required");
    this.bos = bos;
  }

  async invoke(value, payload) {
    const current = validateResolvedAction(value);
    if (current.verb === "state") throw new TypeError("Use the BOS state-action adapter for a state action");
    if (current.payload_schema === null) {
      if (payload !== undefined) throw new TypeError("A bodyless returned action cannot receive a payload");
      return this.bos.invokeReturnedAction(current);
    }
    if (payload === undefined) throw new TypeError("Returned action payload is required");
    validateJsonValueAgainstSchema(payload, current.payload_schema, "returned action payload");
    assertNoPrivateKeys(payload, "returned action payload");
    return this.bos.invokeReturnedAction(current, structuredClone(payload));
  }
}

export class OperationStateActionClient {
  constructor({bos}) {
    if (typeof bos?.invokeStateAction !== "function") throw new TypeError("bos.invokeStateAction is required");
    this.bos = bos;
  }

  async invoke(value, payload) {
    const current = validateOperationStateAction(value);
    if (payload !== undefined) throw new TypeError("An operation state action is physically bodyless");
    return this.bos.invokeStateAction(current);
  }
}
