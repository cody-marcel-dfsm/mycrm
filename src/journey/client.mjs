import {ReturnedActionClient, validateResolvedAction} from "../bos/action-client.mjs";
import {assertNoPrivateKeys, validateJsonSchema} from "../bos/contracts.mjs";

const CONTRIBUTION_KEYS = new Set(["goal", "concepts", "constraints", "requiredEvidence", "approvals", "guarantees", "presentation", "recovery"]);
const INSTRUCTION_KEYS = new Set(["actions", "domain", "goal", "input_schema", "operation"]);
const ACTION_KEYS = new Set(["complete", "failed", "step"]);
const RUNTIME_KEYS = new Set(["bosl", "catch", "digest", "execution_id", "journey_id", "next", "revision", "state", "transition", "version"]);

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required`);
  return value;
}
export function buildCrmContribution(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("CRM contribution must be an object");
  for (const key of Object.keys(input)) if (!CONTRIBUTION_KEYS.has(key) || RUNTIME_KEYS.has(key)) throw new TypeError(`CRM contribution cannot contain runtime field ${key}`);
  requireString(input.goal, "CRM contribution goal");
  const contribution = {goal: input.goal};
  for (const key of [...CONTRIBUTION_KEYS].filter((key) => key !== "goal")) {
    if (!Array.isArray(input[key])) throw new TypeError(`CRM contribution ${key} must be an array`);
    contribution[key] = structuredClone(input[key]);
  }
  assertNoPrivateKeys(contribution, "CRM contribution");
  return contribution;
}

export class CrmJourneyClient {
  constructor({http}) {
    if (typeof http?.request !== "function") throw new TypeError("http.request is required");
    this.actions = new ReturnedActionClient({http});
  }
  validateInstruction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CRM instruction must be an object");
    for (const key of Object.keys(value)) if (!INSTRUCTION_KEYS.has(key) || RUNTIME_KEYS.has(key)) throw new TypeError(`CRM instruction exposes unsupported field ${key}`);
    if (value.domain !== "crm") throw new TypeError("CRM instruction domain must be crm");
    requireString(value.goal, "CRM instruction goal");
    requireString(value.operation, "CRM instruction operation");
    if (!value.input_schema || typeof value.input_schema !== "object") throw new TypeError("CRM instruction input_schema is required");
    validateJsonSchema(value.input_schema, "CRM instruction input_schema");
    if (!value.actions || typeof value.actions !== "object" || Array.isArray(value.actions)) throw new TypeError("CRM instruction actions are required");
    for (const name of Object.keys(value.actions)) if (!ACTION_KEYS.has(name)) throw new TypeError(`CRM instruction action ${name} is unsupported`);
    if (Object.keys(value.actions).length === 0) throw new TypeError("CRM instruction actions must not be empty");
    assertNoPrivateKeys({...value, input_schema: {}, actions: {}}, "CRM instruction");
    const actions = Object.fromEntries(Object.entries(value.actions).map(([name, current]) => [name, validateResolvedAction(current)]));
    return {...structuredClone(value), actions};
  }
  async invokeAction(value, payload) {
    return this.actions.invoke(value, payload);
  }
}
