import test from "node:test";
import assert from "node:assert/strict";
import {presentPublicFailure, presentResult} from "../src/crm/presentation.mjs";

test("presentation labels origin, local freshness, provenance, coverage, conflicts, and usage truthfully", () => {
  const view = presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [], usage: {status: "unavailable"}}, {origin: "live", locale: "en-US", timeZone: "America/Denver"});
  assert.equal(view.origin, "live");
  assert.match(view.last_updated_local, /2026/);
  assert.deepEqual(view.usage, {status: "unavailable"});
  const organizationField = presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [{records: [{student_id: "student-public-42", email: "generated@example.invalid", email_address: "generated@example.invalid"}]}]}, {origin: "live", locale: "en-US", timeZone: "America/Denver"});
  assert.equal(organizationField.source_results[0].records[0].student_id, "student-public-42");
  assert.equal(organizationField.source_results[0].records[0].email, "generated@example.invalid");
  assert.equal(organizationField.source_results[0].records[0].email_address, "generated@example.invalid");
  const canonicalError = {code: "source_not_available", message: "The source is unavailable.", retryable: false, correlation_id: "corr-location", details: [{location_context: "synthetic-location"}]};
  const canonicalView = presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [{error: canonicalError}]}, {origin: "live", locale: "en-US", timeZone: "America/Denver"});
  assert.deepEqual(canonicalView.source_results[0].error, canonicalError);
  assert.throws(() => presentResult({complete: true, observed_at: "2026-09-19", source_results: []}, {origin: "live", locale: "en-US", timeZone: "America/Denver"}), /timestamp/);
  assert.throws(() => presentResult({complete: true, observed_at: "2026-09-19T16:00:00Z", source_results: [{records: [{internal_id: "hidden"}]}]}, {origin: "live", locale: "en-US", timeZone: "America/Denver"}), /forbidden private key/);
});

test("public failure presentation preserves actionable sanitized recovery without inventing provider detail", () => {
  const failure = {code: "invalid_request", message: "Current CRM evidence is required.", retryable: false, correlation_id: "corr_public", details: [{field: "email"}]};
  const instruction = {message: "Correct the current CRM evidence and continue.", effect: "update"};
  const view = presentPublicFailure(failure, {operation: "crm.records.update", instruction});
  assert.equal(view.code, "invalid_request");
  assert.equal(view.correlation_id, "corr_public");
  assert.deepEqual(view.recovery, instruction);
  assert.equal(JSON.stringify(view).includes("provider"), false);
  assert.deepEqual(presentPublicFailure({...failure, details: [{location_context: "synthetic-location"}]}).details, [{location_context: "synthetic-location"}]);
  assert.throws(() => presentPublicFailure({...failure, message: "token=synthetic-secret; SQLSTATE synthetic failure"}), /private implementation detail/);
  const contextLookingMessage = `Use the customer-visible reference bos_ctx_v2_${"a".repeat(64)} exactly as supplied.`;
  assert.throws(() => presentPublicFailure({...failure, message: contextLookingMessage}), /forbidden context handle/);
  assert.throws(() => presentPublicFailure(failure, {instruction: {access_token: "private"}}), /forbidden private key/);
  assert.throws(() => presentPublicFailure({...failure, details: [{value: `Embedded bos_ctx_v2_${"a".repeat(64)} value` }]}), /private implementation text/);
});
