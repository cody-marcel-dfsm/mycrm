export const MY_CRM_RESOURCE = "https://dfsm.ai/mcp/apps/leaddirector/crm";

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

export class BosMcpClient {
  constructor({ transport, resourceUrl = MY_CRM_RESOURCE } = {}) {
    if (resourceUrl !== MY_CRM_RESOURCE) {
      throw new TypeError(`My CRM resource must remain ${MY_CRM_RESOURCE}`);
    }
    for (const method of ["listTools", "callTool"]) {
      if (typeof transport?.[method] !== "function") throw new TypeError(`transport.${method} must be a function`);
    }
    this.transport = transport;
    this.resourceUrl = resourceUrl;
    this.catalog = null;
  }

  async refreshCatalog() {
    const result = await this.transport.listTools({ resourceUrl: this.resourceUrl });
    const tools = Array.isArray(result) ? result : result?.tools;
    if (!Array.isArray(tools)) throw new BosMcpError("My CRM returned an invalid tool catalog", { code: "invalid_tool_catalog" });
    this.catalog = tools.map((tool) => structuredClone(tool));
    return structuredClone(this.catalog);
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

  async getContext() {
    if (!this.catalog) await this.refreshCatalog();
    const matches = this.catalog.filter((tool) => tool?.name === "bos_get_context");
    if (matches.length !== 1) {
      throw new BosMcpError("The My CRM connection must expose one bos_get_context tool", {
        code: matches.length ? "ambiguous_context_tool" : "context_tool_unavailable"
      });
    }
    return this.#call(matches[0].name, {});
  }

  async invoke(requestedSemanticId, args, { expectedSideEffect } = {}) {
    const operation = this.resolveOperation(requestedSemanticId, { expectedSideEffect });
    return this.#call(operation.name, args ?? {});
  }

  async listResources() {
    if (typeof this.transport.listResources !== "function") {
      throw new BosMcpError("The host does not expose MCP resource listing", { code: "resource_listing_unavailable" });
    }
    return this.transport.listResources({ resourceUrl: this.resourceUrl });
  }

  async readResource(uri) {
    if (typeof uri !== "string" || uri.length === 0) throw new TypeError("A listed resource URI is required");
    if (typeof this.transport.readResource !== "function") {
      throw new BosMcpError("The host does not expose MCP resource reading", { code: "resource_read_unavailable" });
    }
    return this.transport.readResource({ resourceUrl: this.resourceUrl, uri });
  }

  async #call(name, args) {
    try {
      const result = await this.transport.callTool({ resourceUrl: this.resourceUrl, name, arguments: structuredClone(args) });
      if (result?.isError) {
        throw new BosMcpError("My CRM operation returned an error", {
          code: result?.structuredContent?.error?.code ?? "operation_failed",
          operation: name,
          details: result?.structuredContent?.error?.details ?? null
        });
      }
      return result;
    } catch (error) {
      if (error instanceof BosMcpError) throw error;
      throw new BosMcpError("My CRM transport could not complete the operation", {
        code: "transport_error",
        operation: name,
        details: { name: error?.name ?? "Error" }
      });
    }
  }
}

export { semanticId, sideEffect };
