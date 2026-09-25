import {
  assertNoPrivateKeys,
  validateApplicationDiscovery,
  validateDescribeResponse,
  validateJsonSchema,
  validateJsonValueAgainstSchema,
  validateOperationIds,
  validatePublicError
} from "./contracts.mjs";
import {OperationStateActionClient, ReturnedActionClient, validateResolvedAction} from "./action-client.mjs";

const AUTHENTICATION_CODES = new Set([
  "AUTHENTICATION_EXPIRED", "AUTHENTICATION_REQUIRED", "AUTHORIZATION_REQUIRED",
  "EXPIRED_TOKEN", "INVALID_CLIENT", "INVALID_GRANT", "INVALID_TOKEN",
  "MCP_SESSION_CLOSED", "MCP_WWW_AUTHENTICATE", "MISSING_GRANT",
  "PROVIDER_AUTHORIZATION_REQUIRED", "REAUTHENTICATION_REQUIRED", "RESOURCE_MISMATCH",
  "REVOKED_GRANT", "TOKEN_EXPIRED", "UNAUTHENTICATED"
]);
const PUBLIC_INSTRUCTION_KEYS = new Set(["action", "approval_schema", "effect", "message", "review"]);

function validatePublicInstruction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("public instruction must be an object");
  for (const key of Object.keys(value)) if (!PUBLIC_INSTRUCTION_KEYS.has(key)) throw new TypeError(`public instruction contains unsupported field ${key}`);
  if (Object.keys(value).length === 0) throw new TypeError("public instruction must not be empty");
  const instruction = structuredClone(value);
  if (instruction.effect !== undefined && (typeof instruction.effect !== "string" || instruction.effect.trim() === "")) throw new TypeError("public instruction effect is invalid");
  if (instruction.message !== undefined && (typeof instruction.message !== "string" || instruction.message.trim() === "" || instruction.message.length > 2048)) throw new TypeError("public instruction message is invalid");
  if (instruction.review !== undefined && (!instruction.review || typeof instruction.review !== "object" || Array.isArray(instruction.review))) throw new TypeError("public instruction review is invalid");
  if (instruction.approval_schema !== undefined) instruction.approval_schema = validateJsonSchema(instruction.approval_schema, "public instruction approval_schema");
  if (instruction.action !== undefined) instruction.action = validateResolvedAction(instruction.action);
  assertNoPrivateKeys({...instruction, action: {}}, "public instruction");
  return instruction;
}

export class BosContractError extends Error {
  constructor(message, {code = "CONTRACT_ERROR", status = null, operation = null, publicError = null, instruction = null} = {}) {
    super(message);
    this.name = "BosContractError";
    this.code = code;
    this.status = status;
    this.operation = operation;
    this.publicError = publicError;
    this.instruction = instruction;
  }
}

function authenticationCondition(responseOrError) {
  const status = Number(responseOrError?.status ?? responseOrError?.details?.status);
  const code = String(responseOrError?.body?.error?.code ?? responseOrError?.code ?? "").toUpperCase();
  if (status === 401 || AUTHENTICATION_CODES.has(code)) {
    const publicCode = AUTHENTICATION_CODES.has(code) ? code : "AUTHORIZATION_REQUIRED";
    return {
      category: publicCode === "MCP_SESSION_CLOSED" ? "mcp_session" : "authentication",
      code: publicCode,
      source: "protected_resource"
    };
  }
  return null;
}

function requireMethod(owner, name) {
  if (typeof owner?.[name] !== "function") throw new TypeError(`${name} must be provided`);
}

function sameSource(left, right) {
  return left?.platform === right?.platform && left?.application === right?.application && left?.plugin === right?.plugin;
}

function validateAdapterRequest(contact, payload, label) {
  if (!contact?.execution || contact.execution.transport != null || typeof contact.execution.method !== "string" || typeof contact.execution.uri !== "string") {
    throw new TypeError(`${label} does not describe a deterministic HTTPS operation`);
  }
  if (contact.execution.context_header !== "X-BOS-Context-Handle") throw new TypeError(`${label} context header is invalid`);
  if (contact.execution.method === "GET" && payload !== undefined) throw new TypeError(`${label} GET operation must be bodyless`);
  if (contact.execution.method !== "GET" && payload === undefined) throw new TypeError(`${label} payload is required`);
}

function validateAdapterResponse(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const allowed = new Set(["body", "headers", "status"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  if (!Object.hasOwn(value, "body")) throw new TypeError(`${label}.body is required`);
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) throw new TypeError(`${label}.status is invalid`);
  if (value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)) throw new TypeError(`${label}.headers must be an object`);
    const allowedHeaders = new Set(["content-type", "retry-after", "x-correlation-id"]);
    for (const [key, header] of Object.entries(value.headers)) {
      if (!allowedHeaders.has(key)) throw new TypeError(`${label}.headers contains unsupported field ${key}`);
      if (typeof header !== "string") throw new TypeError(`${label}.headers.${key} must be a string`);
    }
  }
  return value;
}

export class BosContractClient {
  constructor({discovery, bos, onAuthenticationReady = async () => {}}) {
    requireMethod(discovery, "read");
    requireMethod(discovery, "refresh");
    requireMethod(discovery, "describe");
    requireMethod(bos, "recoverAuthentication");
    requireMethod(bos, "invokeDiscoveredOperation");
    if (typeof onAuthenticationReady !== "function") throw new TypeError("onAuthenticationReady must be a function");
    this.discoveryTransport = discovery;
    this.bos = bos;
    this.onAuthenticationReady = onAuthenticationReady;
    this.discovery = null;
    this.descriptions = new Map();
    this.recoveryActive = false;
  }

  async refreshDiscovery() {
    const current = await this.#readDiscovery(true);
    this.descriptions.clear();
    return structuredClone(current);
  }

  async describe(operationIds) {
    const discovery = this.discovery ?? await this.#readDiscovery(false);
    const requested = validateOperationIds(operationIds, discovery.describe.max_operations);
    for (const operationId of requested) {
      if (!discovery.describe.operations.includes(operationId)) {
        throw new BosContractError(`Operation ${operationId} is not present in current discovery`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
      }
    }
    const described = validateDescribeResponse(await this.#describeWithRecovery(requested), requested);
    for (const operation of described.operations) this.descriptions.set(operation.operation, operation);
    return structuredClone(described);
  }

  getDescription(operationId) {
    const operation = this.descriptions.get(operationId);
    if (!operation) throw new BosContractError(`Operation ${operationId} has not been described`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
    return structuredClone(operation);
  }

  async execute(operationId, input) {
    const original = this.descriptions.get(operationId);
    if (!original) throw new BosContractError(`Operation ${operationId} has not been described`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
    if (original.status !== "described") throw new BosContractError(`Operation ${operationId} is not available`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
    validateJsonValueAgainstSchema(input, original.input_schema, `${operationId} input`);
    const perform = async () => {
      const current = this.descriptions.get(operationId);
      if (!current) throw new BosContractError(`Operation ${operationId} is unavailable after discovery refresh`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
      if (current.status !== "described") throw new BosContractError(`Operation ${operationId} is not available`, {code: "OPERATION_UNAVAILABLE", operation: operationId});
      const selectedSources = input?.source ? [input.source] : Array.isArray(input?.targets) ? input.targets.map(({source}) => source) : [];
      const readySources = current.sources.filter(({availability}) => availability === "ready");
      if ((selectedSources.length === 0 && readySources.length === 0) || selectedSources.some((source) => !readySources.some((candidate) => sameSource(candidate.source, source)))) {
        throw new BosContractError(`Operation ${operationId} has no ready selected source`, {code: "OPERATION_NOT_READY", operation: operationId});
      }
      if (current.effect !== original.effect) throw new BosContractError(`Operation ${operationId} changed effect during recovery`, {code: "EFFECT_CHANGED", operation: operationId});
      validateJsonValueAgainstSchema(input, current.input_schema, `${operationId} refreshed input`);
      const contact = structuredClone(current);
      const payload = current.execution.method === "GET" ? undefined : structuredClone(input);
      validateAdapterRequest(contact, payload, `${operationId} BOS dependency request`);
      return current.execution.method === "GET"
        ? this.bos.invokeDiscoveredOperation(contact)
        : this.bos.invokeDiscoveredOperation(contact, payload);
    };
    let response;
    try {
      response = await perform();
    } catch (error) {
      if (error instanceof BosContractError) throw error;
      const code = new Set(["AUTHENTICATION_RECOVERY_PENDING", "AUTHENTICATION_RECOVERY_FAILED", "CONTEXT_UNAVAILABLE"]).has(error?.code) ? error.code : "TRANSPORT_FAILURE";
      throw new BosContractError("The BOS dependency adapter could not execute the discovered operation", {code, operation: operationId});
    }
    try {
      validateAdapterResponse(response, `${operationId} BOS dependency response`);
    } catch {
      throw new BosContractError("The BOS dependency adapter returned an invalid transport result", {code: "TRANSPORT_FAILURE", operation: operationId});
    }
    if (response.status >= 400) throw this.#publicFailure(response, operationId);
    validateJsonValueAgainstSchema(response.body, this.descriptions.get(operationId).output_schema, `${operationId} output`);
    assertNoPrivateKeys(response.body, `${operationId} output`);
    return structuredClone(response);
  }

  async invokeReturnedAction(action, payload) {
    return new ReturnedActionClient({bos: this.bos}).invoke(action, payload);
  }

  async invokeStateAction(action) {
    return new OperationStateActionClient({bos: this.bos}).invoke(action);
  }

  async #readDiscovery(refresh) {
    let value;
    try {
      value = await this.discoveryTransport[refresh ? "refresh" : "read"]();
    } catch (error) {
      const condition = authenticationCondition(error);
      if (!condition) throw new BosContractError("The BOS discovery transport failed", {code: "TRANSPORT_FAILURE"});
      if (this.recoveryActive) throw new BosContractError("BOS authentication recovery did not restore discovery", {code: "AUTHENTICATION_RECOVERY_FAILED"});
      this.recoveryActive = true;
      try {
        await this.#recover(condition, error?.resource ?? null);
        try { value = await this.discoveryTransport.refresh(); } catch {
          throw new BosContractError("BOS authentication recovery did not restore discovery", {code: "AUTHENTICATION_RECOVERY_FAILED"});
        }
      } finally {
        this.recoveryActive = false;
      }
    }
    this.discovery = validateApplicationDiscovery(value);
    return this.discovery;
  }

  async #describeWithRecovery(operationIds) {
    try {
      return await this.discoveryTransport.describe({operations: structuredClone(operationIds)});
    } catch (error) {
      const condition = authenticationCondition(error);
      if (!condition) throw new BosContractError("The BOS Describe transport failed", {code: "TRANSPORT_FAILURE", operation: "app.describe"});
      if (this.recoveryActive) throw new BosContractError("BOS authentication recovery did not restore Describe", {code: "AUTHENTICATION_RECOVERY_FAILED", operation: "app.describe"});
      this.recoveryActive = true;
      try {
        await this.#recover(condition, error?.resource ?? null);
        await this.refreshDiscovery();
        try {
          return await this.discoveryTransport.describe({operations: structuredClone(operationIds)});
        } catch (retryError) {
          if (authenticationCondition(retryError)) throw new BosContractError("BOS authentication recovery did not restore Describe", {code: "AUTHENTICATION_RECOVERY_FAILED", operation: "app.describe"});
          throw new BosContractError("The BOS Describe transport failed after recovery", {code: "TRANSPORT_FAILURE", operation: "app.describe"});
        }
      } finally {
        this.recoveryActive = false;
      }
    }
  }

  async #recover(condition, resource) {
    const request = () => ({resource, condition: structuredClone(condition)});
    let readiness = await this.bos.recoverAuthentication(request());
    if (readiness?.status === "HOST_ACTION_REQUIRED" || readiness?.status === "NOT_READY") {
      if (typeof this.bos.waitForAuthentication !== "function") {
        throw new BosContractError("BOS authentication recovery remains active", {code: "AUTHENTICATION_RECOVERY_PENDING"});
      }
      readiness = await this.bos.waitForAuthentication(request());
    }
    if (readiness?.status !== "READY") throw new BosContractError("BOS authentication recovery remains active", {code: "AUTHENTICATION_RECOVERY_PENDING"});
    await this.onAuthenticationReady();
  }

  #publicFailure(response, operation) {
    let publicError;
    try { publicError = validatePublicError(response?.body?.error); } catch {
      return new BosContractError("The server returned a nonconforming public error", {code: "INVALID_PUBLIC_ERROR", status: response?.status, operation});
    }
    const description = this.descriptions.get(operation);
    if (description?.status === "described" && !description.error_contract.codes.includes(publicError.code)) {
      return new BosContractError("The server returned an unadvertised public error", {code: "INVALID_PUBLIC_ERROR", status: response?.status, operation});
    }
    let instruction = null;
    try {
      if (response.body?.instruction) {
        instruction = validatePublicInstruction(response.body.instruction);
      }
    } catch {
      return new BosContractError("The server returned a nonconforming public instruction", {code: "INVALID_PUBLIC_INSTRUCTION", status: response?.status, operation});
    }
    return new BosContractError(publicError.message, {
      code: publicError.code,
      status: response.status,
      operation,
      publicError,
      instruction
    });
  }
}

export {authenticationCondition};
