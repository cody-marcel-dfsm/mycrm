export const MY_CRM_RESOURCE = "https://dfsm.ai/mcp/apps/leaddirector/crm";

const AUTHENTICATION_CODES = new Set([
  "authentication_required",
  "authentication_expired",
  "authorization_required",
  "expired_token",
  "invalid_client",
  "invalid_grant",
  "invalid_token",
  "mcp_authentication_required",
  "mcp_session_closed",
  "mcp_www_authenticate",
  "missing_grant",
  "oauth_required",
  "provider_authorization_required",
  "reauthenticationrequired",
  "reauthentication_required",
  "resource_mismatch",
  "revoked_grant",
  "token_expired",
  "unauthenticated"
]);

export class BosMcpError extends Error {
  constructor(message, { code = "bos_mcp_error", operation = null, details = null } = {}) {
    super(message);
    this.name = "BosMcpError";
    this.code = code;
    this.operation = operation;
    this.details = details;
  }
}

function semanticId(tool) {
  return tool?.semanticOperation
    ?? tool?._meta?.["bos/semantic-operation"]
    ?? tool?.annotations?.semanticOperation
    ?? null;
}

function sideEffect(tool) {
  return tool?.sideEffect
    ?? tool?._meta?.["bos/side-effect"]
    ?? tool?.annotations?.sideEffect
    ?? "unknown";
}

function authenticationReason(error) {
  const code = String(error?.code ?? "").toLowerCase();
  if (AUTHENTICATION_CODES.has(code)) return code;
  if (error?.details?.authenticationChallenge === true) return "mcp_www_authenticate";
  if (Number(error?.details?.status) === 401 || Number(error?.status) === 401) return "unauthenticated";
  const message = String(error?.message ?? "").toLowerCase();
  if (message.includes("reauthenticationrequired") || message.includes("requires oauth reauthentication")) {
    return "reauthentication_required";
  }
  return null;
}

export class BosMcpClient {
  constructor({ transport, bosDependency, mutationReconciler, resourceUrl = MY_CRM_RESOURCE } = {}) {
    if (resourceUrl !== MY_CRM_RESOURCE) {
      throw new TypeError(`My CRM resource must remain ${MY_CRM_RESOURCE}`);
    }
    for (const method of ["listTools", "callTool", "refreshConnection"]) {
      if (typeof transport?.[method] !== "function") throw new TypeError(`transport.${method} must be a function`);
    }
    if (typeof bosDependency?.recoverAuthentication !== "function") {
      throw new TypeError("bosDependency.recoverAuthentication must be provided by the required BOS plugin");
    }
    if (typeof bosDependency?.waitForAuthenticationReady !== "function") {
      throw new TypeError("bosDependency.waitForAuthenticationReady must be provided by the required BOS plugin");
    }
    if (typeof mutationReconciler?.reconcile !== "function") {
      throw new TypeError("mutationReconciler.reconcile must be provided by My CRM");
    }
    this.transport = transport;
    this.bosDependency = bosDependency;
    this.mutationReconciler = mutationReconciler;
    this.resourceUrl = resourceUrl;
    this.catalog = null;
  }

  async refreshCatalog() {
    return this.#withBosAuthentication(() => this.#refreshCatalog());
  }

  resolveOperation(requestedSemanticId, { expectedSideEffect } = {}) {
    if (!this.catalog) throw new BosMcpError("Refresh the My CRM tool catalog before selecting an operation", { code: "catalog_required" });
    const matches = this.catalog.filter((tool) => semanticId(tool) === requestedSemanticId);
    if (matches.length === 0) {
      throw new BosMcpError(`My CRM does not currently advertise ${requestedSemanticId}`, {
        code: "operation_unavailable",
        operation: requestedSemanticId
      });
    }
    if (matches.length > 1) {
      throw new BosMcpError(`My CRM advertised an ambiguous operation for ${requestedSemanticId}`, {
        code: "ambiguous_operation",
        operation: requestedSemanticId
      });
    }
    const operation = matches[0];
    if (expectedSideEffect && sideEffect(operation) !== expectedSideEffect) {
      throw new BosMcpError(`My CRM operation ${requestedSemanticId} has an unexpected side-effect class`, {
        code: "side_effect_mismatch",
        operation: requestedSemanticId,
        details: { expected: expectedSideEffect, actual: sideEffect(operation) }
      });
    }
    return structuredClone(operation);
  }

  async invoke(requestedSemanticId, args, { expectedSideEffect } = {}) {
    if (!this.catalog) await this.#withBosAuthentication(() => this.#refreshCatalog());
    const operation = this.resolveOperation(requestedSemanticId, { expectedSideEffect });
    const originalSideEffect = sideEffect(operation);
    const invocationArgs = structuredClone(args ?? {});
    try {
      return await this.#call(operation.name, invocationArgs);
    } catch (error) {
      const reason = authenticationReason(error);
      if (!reason) throw error;
      await this.#recoverAuthentication(reason);
      if (originalSideEffect === "read") {
        const refreshedOperation = this.resolveOperation(requestedSemanticId, { expectedSideEffect: "read" });
        return this.#call(refreshedOperation.name, invocationArgs);
      }
      const reconciliation = await this.mutationReconciler.reconcile({
        semanticOperation: requestedSemanticId,
        operation: structuredClone(operation),
        arguments: structuredClone(invocationArgs),
        authenticationError: error
      });
      if (reconciliation?.outcome === "committed") return reconciliation.result;
      if (reconciliation?.outcome === "retry_safe") {
        const refreshedOperation = this.resolveOperation(requestedSemanticId, {
          expectedSideEffect: originalSideEffect
        });
        return this.#call(refreshedOperation.name, invocationArgs);
      }
      throw new BosMcpError("My CRM could not safely determine whether the mutation committed", {
        code: "mutation_reconciliation_required",
        operation: requestedSemanticId,
        details: { outcome: reconciliation?.outcome ?? "unknown" }
      });
    }
  }

  async listResources() {
    if (typeof this.transport.listResources !== "function") {
      throw new BosMcpError("The host does not expose MCP resource listing", { code: "resource_listing_unavailable" });
    }
    return this.#withBosAuthentication(() => this.transport.listResources({ resourceUrl: this.resourceUrl }));
  }

  async readResource(uri) {
    if (typeof uri !== "string" || uri.length === 0) throw new TypeError("A listed resource URI is required");
    if (typeof this.transport.readResource !== "function") {
      throw new BosMcpError("The host does not expose MCP resource reading", { code: "resource_read_unavailable" });
    }
    return this.#withBosAuthentication(() => this.transport.readResource({ resourceUrl: this.resourceUrl, uri }));
  }

  async #withBosAuthentication(action) {
    try {
      return await action();
    } catch (error) {
      const reason = authenticationReason(error);
      if (!reason) throw error;
      await this.#recoverAuthentication(reason);
      return action();
    }
  }

  async #recoverAuthentication(reason) {
    let readiness = await this.bosDependency.recoverAuthentication({
      resourceUrl: this.resourceUrl,
      reason
    });
    if (readiness?.status !== "READY") {
      readiness = await this.bosDependency.waitForAuthenticationReady({
        resourceUrl: this.resourceUrl
      });
    }
    if (readiness?.status !== "READY") {
      throw new BosMcpError("BOS authentication recovery remains pending", {
        code: "authentication_recovery_pending",
        details: { status: readiness?.status ?? "NOT_READY" }
      });
    }
    this.catalog = null;
    await this.transport.refreshConnection({ resourceUrl: this.resourceUrl });
    await this.#refreshCatalog();
  }

  async #refreshCatalog() {
    const result = await this.transport.listTools({ resourceUrl: this.resourceUrl });
    const tools = Array.isArray(result) ? result : result?.tools;
    if (!Array.isArray(tools)) throw new BosMcpError("My CRM returned an invalid tool catalog", { code: "invalid_tool_catalog" });
    this.catalog = tools.map((tool) => structuredClone(tool));
    return structuredClone(this.catalog);
  }

  async #call(name, args) {
    try {
      const result = await this.transport.callTool({ resourceUrl: this.resourceUrl, name, arguments: structuredClone(args) });
      if (result?.isError) {
        throw new BosMcpError("My CRM operation returned an error", {
          code: result?.structuredContent?.error?.code ?? "operation_failed",
          operation: name,
          details: {
            ...(result?.structuredContent?.error?.details ?? {}),
            authenticationChallenge: Boolean(result?._meta?.["mcp/www_authenticate"])
          }
        });
      }
      return result;
    } catch (error) {
      if (error instanceof BosMcpError) throw error;
      const authReason = authenticationReason(error);
      if (authReason) {
        throw new BosMcpError("BOS authentication recovery is required", {
          code: authReason,
          operation: name,
          details: { status: error?.status ?? null }
        });
      }
      throw new BosMcpError("My CRM transport could not complete the operation", {
        code: "transport_error",
        operation: name,
        details: { name: error?.name ?? "Error" }
      });
    }
  }
}

export { authenticationReason, semanticId, sideEffect };
