import {assertNoPrivateKeys, validateSourceReference} from "../bos/contracts.mjs";

function clone(value) { return structuredClone(value); }
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}
function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} must be a non-empty string`);
  return value;
}
function validateChanges(changes, label) {
  object(changes, label);
  if (Object.keys(changes).length === 0) throw new TypeError(`${label} must not be empty`);
  assertNoPrivateKeys(changes, label);
  return clone(changes);
}
function validateRecord(record, label) {
  object(record, label);
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "selector") throw new TypeError(`${label} must contain only the opaque selector`);
  return {selector: text(record.selector, `${label}.selector`)};
}
function validateSourceRecord(record, label) {
  object(record, label);
  text(record.public_selector, `${label}.public_selector`);
  assertNoPrivateKeys(record, label);
  return record;
}
function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new TypeError(`${label} contains unsupported fields`);
}
function targetKey(target) { return `${target.source.platform}\u0000${target.source.application}\u0000${target.source.plugin}\u0000${target.record.selector}`; }
function targets(values, {withChanges}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 5) throw new TypeError("A mutation requires one to five explicit targets");
  const result = values.map((value, index) => {
    object(value, `targets[${index}]`);
    exactKeys(value, withChanges ? ["source", "record", "changes"] : ["source", "record"], `targets[${index}]`);
    const target = {source: validateSourceReference(value.source, `targets[${index}].source`), record: validateRecord(value.record, `targets[${index}].record`)};
    if (withChanges) target.changes = validateChanges(value.changes, `targets[${index}].changes`);
    else if (value.changes !== undefined) throw new TypeError("Delete targets must not contain changes");
    return target;
  });
  const keys = result.map(targetKey);
  if (new Set(keys).size !== keys.length) throw new TypeError("Mutation targets contain a duplicate source and selector pair");
  return result;
}

export function buildSearchRequest(input = {}) {
  exactKeys(input, input.source === undefined ? ["text"] : ["text", "source"], "search request");
  const {text: query, source} = input;
  const request = {text: text(query, "search text")};
  if (source !== undefined) request.source = validateSourceReference(source);
  return request;
}
export function buildCreateRequest(input = {}) {
  exactKeys(input, ["source", "changes"], "create request");
  return {source: validateSourceReference(input.source), changes: validateChanges(input.changes, "changes")};
}
export function buildUpdateRequest(input = {}) {
  exactKeys(input, ["targets"], "update request");
  return {targets: targets(input.targets, {withChanges: true})};
}
export function buildDeleteRequest(input = {}) {
  exactKeys(input, ["targets"], "delete request");
  return {targets: targets(input.targets, {withChanges: false})};
}

export function createConceptualCustomer({records, evidence, confidence, conflicts = [], uncertainty} = {}) {
  if (!Array.isArray(records) || records.length === 0) throw new TypeError("Conceptual reconciliation requires source records");
  if (!Array.isArray(evidence) || evidence.length === 0) throw new TypeError("Conceptual reconciliation requires evidence");
  if (!Array.isArray(conflicts)) throw new TypeError("Conceptual reconciliation conflicts must be an array");
  text(confidence, "confidence");
  text(uncertainty, "uncertainty");
  records.forEach((item, index) => {
    object(item, `records[${index}]`);
    validateSourceReference(item.source, `records[${index}].source`);
    validateSourceRecord(item.record, `records[${index}].record`);
  });
  evidence.forEach((item, index) => object(item, `evidence[${index}]`));
  const result = {records: clone(records), evidence: clone(evidence), confidence, conflicts: clone(conflicts), uncertainty};
  assertNoPrivateKeys(result, "conceptual customer evidence");
  return result;
}
