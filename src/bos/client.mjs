import {
  assertNoPrivateKeys,
  assertNoPrivateKeysPreservingCanonicalErrors,
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
  constructor(message, {code = null, status = null, operation = null, publicError = null, instruction = null} = {}) {
    super(message);
    this.name = "BosContractError";
    if (code !== null) this.code = code;
    if (publicError !== null) {
      this.retryable = publicError.retryable;
      this.correlation_id = publicError.correlation_id;
      this.details = structuredClone(publicError.details);
    }
    this.status = status;
    this.operation = operation;
    this.publicError = publicError === null ? null : structuredClone(publicError);
    this.instruction = instruction;
  }
}

function authenticationCondition(responseOrError) {
  const status = Number(responseOrError?.status ?? responseOrError?.details?.status);
  const code = String(responseOrError?.body?.error?.code ?? responseOrError?.code ?? "").toUpperCase();
  if (status === 401 || AUTHENTICATION_CODES.has(code)) {
    const conditionCode = AUTHENTICATION_CODES.has(code) ? code : "AUTHORIZATION_REQUIRED";
    return {
      category: conditionCode === "MCP_SESSION_CLOSED" ? "mcp_session" : "authentication",
      code: conditionCode,
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

export function buildDiscoveredExecutionRequest(contact, body) {
  if (!contact || typeof contact !== "object" || Array.isArray(contact)) throw new TypeError("discovered HTTP contact is required");
  if (typeof contact.method !== "string" || contact.method === "" || typeof contact.uri !== "string" || contact.uri === "") throw new TypeError("discovered HTTP method and URI are required");
  if (contact.context_header !== undefined && contact.context_header !== "X-BOS-Context-Handle") throw new TypeError("discovered HTTP context_header is invalid");
  assertNoPrivateKeys(body, "discovered HTTP request body");
  const request = {
    method: contact.method.toUpperCase(),
    uri: contact.uri,
    headers: {"content-type": "application/json"},
    body: structuredClone(body)
  };
  if (contact.context_header !== undefined) request.context_header = contact.context_header;
  return request;
}

export class BosContractClient {
  constructor({discovery, http, bos, onAuthenticationReady = async () => {}}) {
    requireMethod(discovery, "read");
    requireMethod(discovery, "refresh");
    requireMethod(http, "request");
    requireMethod(bos, "recoverAuthentication");
    if (typeof onAuthenticationReady !== "function") throw new TypeError("onAuthenticationReady must be a function");
    this.discoveryTransport = discovery;
    this.http = http;
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
        throw new BosContractError(`Operation ${operationId} is not present in current discovery`, {operation: operationId});
      }
    }
    const response = await this.#requestWithRecovery(
      () => this.http.request(buildDiscoveredExecutionRequest(this.discovery.describe, {operations: requested})),
      {operationIds: requested, operation: "app.describe"}
    );
    if (response.status !== 200) throw this.#publicFailure(response, "app.describe");
    const described = validateDescribeResponse(response.body, requested);
    for (const operation of described.operations) this.descriptions.set(operation.operation, operation);
    return structuredClone(described);
  }

  getDescription(operationId) {
    const operation = this.descriptions.get(operationId);
    if (!operation) throw new BosContractError(`Operation ${operationId} has not been described`, {operation: operationId});
    return structuredClone(operation);
  }

  async execute(operationId, input) {
    const original = this.descriptions.get(operationId);
    if (!original) throw new BosContractError(`Operation ${operationId} has not been described`, {operation: operationId});
    if (original.status !== "described") throw new BosContractError(`Operation ${operationId} is not available`, {operation: operationId});
    validateJsonValueAgainstSchema(input, original.input_schema, `${operationId} input`);
    const perform = async () => {
      const current = this.descriptions.get(operationId);
      if (!current) throw new BosContractError(`Operation ${operationId} is unavailable after discovery refresh`, {operation: operationId});
      if (current.status !== "described") throw new BosContractError(`Operation ${operationId} is not available`, {operation: operationId});
      const selectedSources = input?.source ? [input.source] : Array.isArray(input?.targets) ? input.targets.map(({source}) => source) : [];
      const readySources = current.sources.filter(({availability}) => availability === "ready");
      if ((selectedSources.length === 0 && readySources.length === 0) || selectedSources.some((source) => !readySources.some((candidate) => sameSource(candidate.source, source)))) {
        throw new BosContractError(`Operation ${operationId} has no ready selected source`, {operation: operationId});
      }
      if (current.effect !== original.effect) throw new BosContractError(`Operation ${operationId} changed effect during recovery`, {code: "EFFECT_CHANGED", operation: operationId});
      validateJsonValueAgainstSchema(input, current.input_schema, `${operationId} refreshed input`);
      return this.http.request(buildDiscoveredExecutionRequest(current.execution, input));
    };
    const response = await this.#requestWithRecovery(perform, {operationIds: [operationId], operation: operationId});
    const hasTopLevelError = response.body && typeof response.body === "object" && !Array.isArray(response.body) && Object.hasOwn(response.body, "error");
    if (hasTopLevelError && response.body.error !== null && response.body.error !== undefined) {
      throw this.#publicFailure(response, operationId);
    }
    if (response.status >= 400) {
      throw this.#publicFailure(response, operationId);
    }
    validateJsonValueAgainstSchema(response.body, this.descriptions.get(operationId).output_schema, `${operationId} output`);
    assertNoPrivateKeysPreservingCanonicalErrors(response.body, `${operationId} output`);
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
      if (!condition) throw this.#transportFailure(error, null, "The BOS discovery transport failed");
      if (this.recoveryActive) throw new BosContractError("BOS authentication recovery did not restore discovery", {code: "AUTHENTICATION_RECOVERY_FAILED"});
      this.recoveryActive = true;
      try {
        await this.#recover(condition, error?.resource ?? null);
        try { value = await this.discoveryTransport.refresh(); } catch (retryError) {
          if (authenticationCondition(retryError)) throw new BosContractError("BOS authentication recovery did not restore discovery", {code: "AUTHENTICATION_RECOVERY_FAILED"});
          throw this.#transportFailure(retryError, null, "The BOS discovery transport failed after recovery");
        }
      } finally {
        this.recoveryActive = false;
      }
    }
    this.discovery = validateApplicationDiscovery(value);
    return this.discovery;
  }

  async #requestWithRecovery(action, {operationIds, operation, redescribe = true}) {
    let response;
    try { response = await action(); } catch (error) {
      if (error instanceof BosContractError) throw error;
      const condition = authenticationCondition(error);
      if (!condition) throw this.#transportFailure(error, operation, "The discovered HTTPS transport failed");
      return this.#recoverRefreshAndRetry(condition, action, {operationIds, operation, resource: error?.resource ?? null, redescribe});
    }
    const condition = authenticationCondition(response);
    if (!condition) return response;
    return this.#recoverRefreshAndRetry(condition, action, {operationIds, operation, resource: response?.resource ?? null, redescribe});
  }

  async #recoverRefreshAndRetry(condition, action, {operationIds, operation, resource, redescribe}) {
    if (this.recoveryActive) throw new BosContractError("BOS authentication recovery did not restore the operation", {code: "AUTHENTICATION_RECOVERY_FAILED", operation});
    this.recoveryActive = true;
    try {
      await this.#recover(condition, resource);
      await this.refreshDiscovery();
      if (operation !== "app.describe" && redescribe) await this.describe(operationIds);
      let response;
      try { response = await action(); } catch (error) {
        if (error instanceof BosContractError) throw error;
        if (authenticationCondition(error)) throw new BosContractError("BOS authentication recovery did not restore the operation", {code: "AUTHENTICATION_RECOVERY_FAILED", operation});
        throw this.#transportFailure(error, operation, "The discovered HTTPS transport failed after recovery");
      }
      if (authenticationCondition(response)) throw new BosContractError("BOS authentication recovery did not restore the operation", {code: "AUTHENTICATION_RECOVERY_FAILED", operation});
      return response;
    } finally {
      this.recoveryActive = false;
    }
  }

  async #recover(condition, resource) {
    requireMethod(this.bos, "recoverAuthentication");
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

  #transportFailure(error, operation, fallbackMessage) {
    let publicError;
    try { publicError = validatePublicError(error?.body?.error); } catch {
      return new BosContractError(fallbackMessage, {operation});
    }
    return new BosContractError(publicError.message, {
      code: publicError.code,
      status: Number.isInteger(error?.status) ? error.status : null,
      operation,
      publicError
    });
  }

  #publicFailure(response, operation) {
    let publicError;
    try { publicError = validatePublicError(response?.body?.error); } catch {
      return new BosContractError("The server returned a nonconforming public error", {status: response?.status, operation});
    }
    let instruction = null;
    try {
      if (response.body?.instruction) {
        instruction = validatePublicInstruction(response.body.instruction);
      }
    } catch { instruction = null; }
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
