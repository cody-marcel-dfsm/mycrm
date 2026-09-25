import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const HTTP_METHODS = new Set(["DELETE", "GET", "PATCH", "POST", "PUT"]);
const LIMIT_KEYS = ["max_targets", "max_results_per_source", "pagination_supported", "bulk_supported", "streaming_supported", "maximum_duration_seconds", "maximum_fan_out"];
const REQUIRED_LIMIT_KEYS = ["pagination_supported", "bulk_supported", "streaming_supported"];
const GUARANTEE_KEYS = ["read_consistency", "per_source_atomicity", "cross_source_atomicity", "convergence", "idempotency"];
const PUBLIC_ERROR_KEYS = new Set(["code", "message", "retryable", "correlation_id", "details"]);
const SAFE_PUBLIC_KEYS = new Set(["$id", "context_header", "correlation_id", "descriptor_token", "organization_name", "service_id"]);
const FORBIDDEN_PUBLIC_TOKENS = new Set([
  "accesstoken", "apikey", "authorization", "authority", "credential", "databaseid",
  "actionid", "appid", "applicationid", "approvalid", "clientid", "context", "executionid", "grant", "idempotencykey", "installationid", "internalid", "journeyid", "oauth", "organizationid", "principal",
  "providererror", "providerid", "refreshtoken", "requestfingerprint", "retrycount", "retryid", "roleid",
  "secret", "sessionid", "sourceid", "tenant", "token", "userid"
]);
const AUTHORITY_QUALIFIERS = new Set(["context", "id", "name", "role", "scope", "selector", "type"]);

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function publicRoute(value, label) {
  nonEmpty(value, label);
  if (!value.startsWith("/") || !value.includes("/{organization}/") || value.includes("..") || value.includes("://")) throw new TypeError(`${label} must be a public organization route template`);
  return value;
}
function exactKeys(value, expected, label) {
  if (JSON.stringify(Object.keys(object(value, label)).sort()) !== JSON.stringify([...expected].sort())) throw new TypeError(`${label} shape is invalid`);
}
function operationId(value, label) {
  nonEmpty(value, label);
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}
function tokens(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function forbiddenKey(key) {
  if (SAFE_PUBLIC_KEYS.has(String(key))) return false;
  const parts = tokens(key);
  const normalized = parts.join("");
  if (FORBIDDEN_PUBLIC_TOKENS.has(normalized) || parts.some((part) => FORBIDDEN_PUBLIC_TOKENS.has(part))) return true;
  return parts.some((part, index) => part === "organization" && AUTHORITY_QUALIFIERS.has(parts[index + 1]));
}

export function assertNoPrivateKeys(value, label = "public contract", path = []) {
  if (typeof value === "string" && /^bos_ctx_v2_[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} contains a forbidden context handle at ${path.join(".") || "value"}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeys(item, label, [...path, String(index)]));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenKey(key)) throw new TypeError(`${label} contains a forbidden private key at ${[...path, key].join(".")}`);
    assertNoPrivateKeys(nested, label, [...path, key]);
  }
}

export function validateSourceReference(value, label = "source") {
  const source = object(value, label);
  const keys = Object.keys(source).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["application", "platform", "plugin"])) throw new TypeError(`${label} must contain exactly platform, application, and plugin`);
  for (const key of keys) nonEmpty(source[key], `${label}.${key}`);
  if (!/^[a-z][a-z0-9_-]*$/.test(source.platform) || !/^[a-z][a-z0-9_-]*$/.test(source.application)) throw new TypeError(`${label} platform/application are invalid`);
  return clone(source);
}

export function validatePublicError(value, {definition = false} = {}) {
  const error = object(value, "public error");
  for (const key of Object.keys(error)) if (!PUBLIC_ERROR_KEYS.has(key)) throw new TypeError(`public error contains unsupported field ${key}`);
  nonEmpty(error.code, "public error code");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)) throw new TypeError("public error code is invalid");
  nonEmpty(error.message, "public error message");
  if (error.message.length > 2048) throw new TypeError("public error message is too long");
  if (/sqlstate|traceback|stack trace|password\s*=|token\s*=|secret\s*=/i.test(error.message)) throw new TypeError("public error message contains private implementation detail");
  if (typeof error.retryable !== "boolean") throw new TypeError("public error retryable must be boolean");
  if (!definition) nonEmpty(error.correlation_id, "public correlation_id");
  else if (error.correlation_id !== undefined && error.correlation_id !== null) nonEmpty(error.correlation_id, "public correlation_id");
  if (error.correlation_id !== undefined && error.correlation_id !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(error.correlation_id)) throw new TypeError("public error correlation_id is invalid");
  if (error.details !== undefined && error.details !== null) {
    if (!Array.isArray(error.details)) throw new TypeError("public error details must be an array");
    error.details.forEach((detail, index) => {
      object(detail, `public error details[${index}]`);
      assertNoPrivateKeys(detail, "public error");
    });
  }
  return clone(error);
}

export function validateApplicationDiscovery(value) {
  const discovery = clone(object(value, "application discovery"));
  if (JSON.stringify(Object.keys(discovery).sort()) !== JSON.stringify(["application", "bosl", "describe"])) throw new TypeError("application discovery must contain exactly application, describe, and bosl");
  const application = object(discovery.application, "application discovery application");
  if (JSON.stringify(Object.keys(application).sort()) !== JSON.stringify(["application", "platform"])) throw new TypeError("application discovery application reference is invalid");
  if (application.platform !== "bos" || application.application !== "lead-director") throw new TypeError("application discovery reference is invalid");
  const describe = object(discovery.describe, "application discovery Describe contact");
  if (JSON.stringify(Object.keys(describe).sort()) !== JSON.stringify(["contract_version", "max_operations", "method", "operations", "uri"])) throw new TypeError("application discovery Describe contact is invalid");
  if (describe.contract_version !== "lead-director-describe/v1") throw new TypeError("Describe contract version is invalid");
  if (String(describe.method).toUpperCase() !== "POST") throw new TypeError("Describe contact method must be POST");
  publicRoute(describe.uri, "Describe contact URI");
  if (describe.max_operations !== 5) throw new TypeError("Describe max_operations is invalid");
  if (!Array.isArray(describe.operations)) throw new TypeError("application discovery operations must be an array");
  const ids = describe.operations.map((operation, index) => operationId(operation, `operations[${index}]`));
  if (new Set(ids).size !== ids.length) throw new TypeError("application discovery operation identities must be unique");
  const bosl = object(discovery.bosl, "application discovery BOSL resources");
  if (JSON.stringify(Object.keys(bosl).sort()) !== JSON.stringify(["descriptor_etag", "examples_uri", "reference_uri", "schema_uri"])) throw new TypeError("application discovery BOSL resources are invalid");
  const partitions = [];
  for (const key of ["schema_uri", "reference_uri", "examples_uri"]) {
    nonEmpty(bosl[key], `BOSL ${key}`);
    const suffix = key.replace("_uri", "");
    const match = new RegExp(`^bos://apps/lead-director/bosl/([a-f0-9]{32})/${suffix}$`).exec(bosl[key]);
    if (!match) throw new TypeError(`BOSL ${key} is invalid`);
    partitions.push(match[1]);
  }
  if (new Set(partitions).size !== 1) throw new TypeError("BOSL resources must use one authority partition");
  if (!/^[a-f0-9]{64}$/.test(bosl.descriptor_etag)) throw new TypeError("BOSL descriptor_etag is invalid");
  assertNoPrivateKeys(discovery, "application discovery");
  return clone(discovery);
}

function validateExecution(value, label) {
  const execution = object(value, `${label} execution`);
  const allowed = new Set(["context_header", "method", "transport", "uri"]);
  for (const key of Object.keys(execution)) if (!allowed.has(key)) throw new TypeError(`${label} execution shape is invalid`);
  if (execution.transport === "journey_runtime") {
    if (execution.method != null || execution.uri != null || execution.context_header != null) throw new TypeError(`${label} journey execution shape is invalid`);
    return {transport: "journey_runtime"};
  }
  if (execution.transport != null) throw new TypeError(`${label} execution transport is invalid`);
  const method = nonEmpty(execution.method, `${label} execution method`).toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new TypeError(`${label} execution method is unsupported`);
  publicRoute(execution.uri, `${label} execution URI`);
  if (execution.context_header !== "X-BOS-Context-Handle") throw new TypeError(`${label} execution context_header is invalid`);
  return {method, uri: execution.uri, context_header: execution.context_header};
}
function validateLimits(value, label) {
  const limits = object(value, `${label} limits`);
  for (const key of Object.keys(limits)) if (!LIMIT_KEYS.includes(key)) throw new TypeError(`${label} limits shape is invalid`);
  for (const key of REQUIRED_LIMIT_KEYS) if (!(key in limits)) throw new TypeError(`${label} limits.${key} is required`);
  for (const key of Object.keys(limits)) {
    const current = limits[key];
    if (current !== null && typeof current !== (key.endsWith("supported") ? "boolean" : "number")) throw new TypeError(`${label} limits.${key} has an invalid type`);
    if (typeof current === "number" && (!Number.isInteger(current) || current < 1)) throw new TypeError(`${label} limits.${key} must be a positive integer`);
  }
  if (limits.maximum_duration_seconds != null && limits.maximum_duration_seconds > 900) throw new TypeError(`${label} limits exceed the public contract`);
  if (limits.maximum_fan_out != null && limits.maximum_fan_out > 100) throw new TypeError(`${label} limits exceed the public contract`);
}
function validateGuarantees(value, label) {
  const guarantees = object(value, `${label} guarantees`);
  exactKeys(guarantees, GUARANTEE_KEYS, `${label} guarantees`);
  for (const key of GUARANTEE_KEYS) {
    if (!(key in guarantees)) throw new TypeError(`${label} guarantees.${key} is required`);
    nonEmpty(guarantees[key], `${label} guarantees.${key}`);
  }
  if (guarantees.idempotency !== "service_owned") throw new TypeError(`${label} guarantees.idempotency is invalid`);
}

export function validateOperationDescription(value, label = "operation") {
  const operation = clone(object(value, label));
  operationId(operation.operation, `${label} operation`);
  if (!new Set(["described", "not_available"]).has(operation.status)) throw new TypeError(`${label} status is invalid`);
  if (operation.status === "not_available") {
    if (JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(["operation", "status"])) throw new TypeError(`${label} not_available shape is invalid`);
    return operation;
  }
  const expectedKeys = ["effect", "error_contract", "execution", "guarantees", "input_schema", "limits", "operation", "output_schema", "sources", "status"];
  if (JSON.stringify(Object.keys(operation).sort()) !== JSON.stringify(expectedKeys)) throw new TypeError(`${label} described shape is invalid`);
  nonEmpty(operation.effect, `${label} effect`);
  object(operation.input_schema, `${label} input_schema`);
  object(operation.output_schema, `${label} output_schema`);
  for (const [schemaName, schema] of [["input_schema", operation.input_schema], ["output_schema", operation.output_schema]]) {
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || !Array.isArray(schema["x-bos-fields"])) throw new TypeError(`${label} ${schemaName} is not a public operation schema`);
    validateJsonSchema(schema, `${label} ${schemaName}`);
  }
  operation.execution = validateExecution(operation.execution, label);
  if (!Array.isArray(operation.sources) || operation.sources.length < 1) throw new TypeError(`${label} sources must be a non-empty array`);
  operation.sources = operation.sources.map((current, index) => {
    const source = object(current, `${label}.sources[${index}]`);
    const baseKeys = ["availability", "source"];
    const contractKeys = ["error_contract", "guarantees", "input_schema", "limits", "output_schema", "receipt_schema"];
    const keys = Object.keys(source).sort();
    const hasSourceContract = contractKeys.some((key) => key in source);
    const expected = [...baseKeys, ...(hasSourceContract ? contractKeys : [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new TypeError(`${label}.sources[${index}] shape is invalid`);
    if (!new Set(["ready", "authorization_required", "configuration_required", "temporarily_unavailable"]).has(source.availability)) throw new TypeError(`${label}.sources[${index}] availability is invalid`);
    const validated = {source: validateSourceReference(source.source, `${label}.sources[${index}].source`), availability: source.availability};
    if (hasSourceContract) {
      for (const schemaName of ["input_schema", "output_schema", "receipt_schema"]) {
        const schema = object(source[schemaName], `${label}.sources[${index}].${schemaName}`);
        if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema" || schema.type !== "object" || !Array.isArray(schema["x-bos-fields"])) throw new TypeError(`${label}.sources[${index}].${schemaName} is not a public operation schema`);
        validated[schemaName] = validateJsonSchema(schema, `${label}.sources[${index}].${schemaName}`);
      }
      validateLimits(source.limits, `${label}.sources[${index}]`);
      validateGuarantees(source.guarantees, `${label}.sources[${index}]`);
      const sourceErrorContract = object(source.error_contract, `${label}.sources[${index}].error_contract`);
      if (JSON.stringify(Object.keys(sourceErrorContract).sort()) !== JSON.stringify(["codes", "schema"])) throw new TypeError(`${label}.sources[${index}].error_contract shape is invalid`);
      if (sourceErrorContract.schema !== "lead-director-public-error/v1" || !Array.isArray(sourceErrorContract.codes) || sourceErrorContract.codes.length < 1 || new Set(sourceErrorContract.codes).size !== sourceErrorContract.codes.length) throw new TypeError(`${label}.sources[${index}].error_contract is invalid`);
      sourceErrorContract.codes.forEach((code, codeIndex) => nonEmpty(code, `${label}.sources[${index}].error_contract.codes[${codeIndex}]`));
      validated.limits = clone(source.limits);
      validated.guarantees = clone(source.guarantees);
      validated.error_contract = clone(sourceErrorContract);
    }
    return validated;
  });
  validateLimits(operation.limits, label);
  validateGuarantees(operation.guarantees, label);
  const errorContract = object(operation.error_contract, `${label} error_contract`);
  if (JSON.stringify(Object.keys(errorContract).sort()) !== JSON.stringify(["codes", "schema"])) throw new TypeError(`${label} error_contract shape is invalid`);
  if (errorContract.schema !== "lead-director-public-error/v1") throw new TypeError(`${label} error_contract schema is invalid`);
  if (!Array.isArray(errorContract.codes) || errorContract.codes.length < 1 || new Set(errorContract.codes).size !== errorContract.codes.length) throw new TypeError(`${label} error_contract codes are invalid`);
  errorContract.codes.forEach((code, index) => nonEmpty(code, `${label} error_contract.codes[${index}]`));
  const envelope = {...operation, input_schema: {}, output_schema: {}};
  assertNoPrivateKeys(envelope, label);
  return clone(operation);
}

export function validateOperationIds(operationIds, maximum = 5) {
  if (!Array.isArray(operationIds) || operationIds.length < 1 || operationIds.length > maximum) throw new TypeError(`Describe requires one to ${maximum} operation identifiers`);
  operationIds.forEach((id, index) => operationId(id, `operations[${index}]`));
  if (new Set(operationIds).size !== operationIds.length) throw new TypeError("Describe operation identifiers must be unique");
  return [...operationIds];
}

export function validateDescribeResponse(value, requestedOperationIds) {
  const response = clone(object(value, "Describe response"));
  if (JSON.stringify(Object.keys(response).sort()) !== JSON.stringify(["contract_version", "metadata_version", "observed_at", "operations"])) throw new TypeError("Describe response shape is invalid");
  if (response.contract_version !== "lead-director-describe/v1") throw new TypeError("Describe contract_version is invalid");
  nonEmpty(response.metadata_version, "Describe metadata_version");
  validateDateTime(response.observed_at, "Describe observed_at");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(response.metadata_version)) throw new TypeError("Describe metadata is invalid");
  if (!Array.isArray(response.operations)) throw new TypeError("Describe operations must be an array");
  const operations = response.operations.map((operation, index) => validateOperationDescription(operation, `Describe operations[${index}]`));
  const byId = new Map(operations.map((operation) => [operation.operation, operation]));
  if (byId.size !== operations.length) throw new TypeError("Describe operation identities must be unique");
  if (requestedOperationIds !== undefined) {
    const requested = validateOperationIds(requestedOperationIds);
    if (operations.length !== requested.length) throw new TypeError("Describe response must contain exactly the requested operations");
    for (const id of requested) if (!byId.has(id)) throw new TypeError(`Describe response omitted requested operation ${id}`);
    if (operations.some((operation, index) => operation.operation !== requested[index])) throw new TypeError("Describe response must preserve request order");
    response.operations = operations;
  } else response.operations = operations;
  assertNoPrivateKeys({...response, operations: response.operations.map((operation) => ({...operation, input_schema: {}, output_schema: {}}))}, "Describe response");
  return clone(response);
}

function compileJsonSchema(schema, label) {
  if (!(typeof schema === "boolean" || (schema && typeof schema === "object" && !Array.isArray(schema)))) throw new TypeError(`${label} schema is invalid`);
  try {
    const ajv = new Ajv2020({allErrors: true, strict: true, strictRequired: false, strictTypes: false});
    addFormats(ajv, {mode: "full"});
    ajv.addKeyword("x-bos-fields");
    return ajv.compile(schema);
  } catch {
    throw new TypeError(`${label} schema is invalid or unsupported`);
  }
}

export function validateDateTime(value, label = "date-time") {
  nonEmpty(value, label);
  const ajv = new Ajv2020({allErrors: true, strict: true});
  addFormats(ajv, {mode: "full"});
  const validate = ajv.compile({type: "string", format: "date-time"});
  if (!validate(value)) throw new TypeError(`${label} must be a valid RFC 3339 date-time`);
  return value;
}

export function validateJsonSchema(schema, label = "JSON") {
  compileJsonSchema(schema, label);
  return clone(schema);
}

export function validateJsonValueAgainstSchema(value, schema, label = "value") {
  const validate = compileJsonSchema(schema, label);
  if (!validate(value)) {
    const paths = [...new Set((validate.errors ?? []).map(({instancePath, keyword}) => `${instancePath || "/"} ${keyword}`))].join(", ");
    throw new TypeError(`${label} does not satisfy its schema${paths ? `: ${paths}` : ""}`);
  }
  return clone(value);
}
