import {ReturnedActionClient, validateResolvedAction} from "../bos/action-client.mjs";
import {assertNoPrivateKeys, validatePublicError} from "../bos/contracts.mjs";

const CONTRIBUTION_KEYS = new Set(["goal", "concepts", "constraints", "requiredEvidence", "approvals", "guarantees", "presentation", "recovery"]);
const CLIENT_ENVELOPE_KEYS = ["current_step", "identity", "instruction", "status"];
const RESOLUTION_ENVELOPE_KEYS = ["current_step", "error", "identity", "resolution", "status"];
const INSTRUCTION_ACTIONS = new Map([["after_success", "complete"], ["on_failure", "failed"]]);
const RETIRED_INSTRUCTION_KEYS = new Set(["actions", "input_schema"]);
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
  constructor({bos}) {
    if (typeof bos?.invokeReturnedAction !== "function") throw new TypeError("bos.invokeReturnedAction is required");
    this.actions = new ReturnedActionClient({bos});
  }
  validateInstruction(value) {
    return validateCrmInstruction(value);
  }
  async invokeInstructionAction(instruction, name, payload) {
    if (!INSTRUCTION_ACTIONS.has(name)) throw new TypeError(`CRM instruction action ${name} is unsupported`);
    const current = this.validateInstruction(instruction);
    return this.actions.invoke(current[name], payload);
  }
  async invokeResolutionAction(response) {
    const current = validateCrmResolutionEnvelope(response);
    return this.actions.invoke(current.resolution.after_success);
  }
}

export function validateCrmInstruction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CRM instruction must be an object");
  for (const key of Object.keys(value)) {
    if (RETIRED_INSTRUCTION_KEYS.has(key)) throw new TypeError(`CRM instruction field ${key} is not part of the BOS Service envelope`);
    if (RUNTIME_KEYS.has(key)) throw new TypeError(`CRM instruction exposes forbidden runtime field ${key}`);
  }
  requireString(value.goal, "CRM instruction goal");
  requireString(value.message, "CRM instruction message");
  assertNoPrivateKeys(value, "CRM instruction");
  const instruction = structuredClone(value);
  for (const [name, verb] of INSTRUCTION_ACTIONS) {
    const action = validateResolvedAction(value[name]);
    if (action.verb !== verb) throw new TypeError(`CRM instruction ${name} action must use verb ${verb}`);
    instruction[name] = action;
  }
  return instruction;
}

export function validateCrmInstructionEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CRM journey response must be an object");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CLIENT_ENVELOPE_KEYS)) throw new TypeError("CRM awaiting_client response shape is invalid");
  requireString(value.identity, "CRM journey identity");
  if (value.status !== "awaiting_client") throw new TypeError("CRM journey response status must be awaiting_client");
  if (!value.current_step || typeof value.current_step !== "object" || Array.isArray(value.current_step)) throw new TypeError("CRM journey current_step must be an object");
  if (JSON.stringify(Object.keys(value.current_step).sort()) !== JSON.stringify(["code", "type"])) throw new TypeError("CRM journey current_step shape is invalid");
  requireString(value.current_step.code, "CRM journey current_step code");
  if (value.current_step.type !== "client") throw new TypeError("CRM journey current_step type must be client");
  const response = structuredClone(value);
  response.instruction = validateCrmInstruction(value.instruction);
  assertNoPrivateKeys(response, "CRM awaiting_client response");
  return response;
}

export function validateCrmResolution(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CRM journey resolution must be an object");
  const allowed = ["after_success", "approval_scope", "goal", "instruction", "operation", "requires_user_approval"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError("CRM journey resolution contains unsupported fields");
  for (const key of ["after_success", "approval_scope", "goal", "instruction", "requires_user_approval"]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError(`CRM journey resolution ${key} is required`);
  }
  requireString(value.goal, "CRM journey resolution goal");
  requireString(value.instruction, "CRM journey resolution instruction");
  if (value.operation !== undefined && (typeof value.operation !== "string" || !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(value.operation))) {
    throw new TypeError("CRM journey resolution operation is invalid");
  }
  if (typeof value.requires_user_approval !== "boolean") throw new TypeError("CRM journey resolution requires_user_approval must be boolean");
  const approvalScope = value.approval_scope ?? [];
  if (!Array.isArray(approvalScope) || new Set(approvalScope).size !== approvalScope.length || approvalScope.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new TypeError("CRM journey resolution approval_scope is invalid");
  }
  const afterSuccess = validateResolvedAction(value.after_success);
  if (afterSuccess.verb !== "step" || afterSuccess.payload_schema !== null) throw new TypeError("CRM journey resolution after_success must be a bodyless step action");
  const resolution = {...structuredClone(value), approval_scope: structuredClone(approvalScope), after_success: afterSuccess};
  assertNoPrivateKeys(resolution, "CRM journey resolution");
  return resolution;
}

export function validateCrmResolutionEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CRM client_action_required response must be an object");
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RESOLUTION_ENVELOPE_KEYS)) throw new TypeError("CRM client_action_required response shape is invalid");
  requireString(value.identity, "CRM journey identity");
  if (value.identity.length > 160) throw new TypeError("CRM journey identity is too long");
  if (value.status !== "client_action_required") throw new TypeError("CRM journey response status must be client_action_required");
  if (!value.current_step || typeof value.current_step !== "object" || Array.isArray(value.current_step)) throw new TypeError("CRM journey current_step must be an object");
  if (JSON.stringify(Object.keys(value.current_step).sort()) !== JSON.stringify(["code", "operation", "type"])) throw new TypeError("CRM journey current_step shape is invalid");
  requireString(value.current_step.code, "CRM journey current_step code");
  requireString(value.current_step.operation, "CRM journey current_step operation");
  if (value.current_step.type !== "server") throw new TypeError("CRM client_action_required current_step must be server-owned");
  const response = structuredClone(value);
  response.error = validatePublicError(value.error);
  response.resolution = validateCrmResolution(value.resolution);
  assertNoPrivateKeys(response, "CRM client_action_required response");
  return response;
}

export function createAudienceRepairGuidance({instruction, failure, audienceChanged = false} = {}) {
  const current = validateCrmInstruction(instruction);
  const publicFailure = validatePublicError(failure);
  if (current.after_success.verb !== "complete") throw new TypeError("CRM audience repair requires a returned after_success completion action");
  if (typeof audienceChanged !== "boolean") throw new TypeError("audienceChanged must be boolean");
  return {
    goal: current.goal,
    ...(current.operation === undefined ? {} : {operation: current.operation}),
    failure: publicFailure,
    client: {
      discover_current_crm_operation: true,
      correct_or_regenerate_recipient_evidence: true,
      require_user_approval_for_crm_mutation: true,
      send_audience_or_server_reference_in_completion: false,
      invoke_returned_complete_action_only_after_goal_is_satisfied: true
    },
    server: {
      requery_and_rematerialize_audience: true,
      reprepare_campaign: audienceChanged,
      require_fresh_campaign_approval: audienceChanged,
      preserve_proven_successful_deliveries: true
    }
  };
}
