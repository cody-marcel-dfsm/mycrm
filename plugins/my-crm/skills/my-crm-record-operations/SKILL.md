---
name: my-crm-record-operations
description: Search, read, create, update, or delete organization-described CRM records through exact operations and actions discovered from BOS.
---

# My CRM Record Operations

Use installed BOS discovery to identify the smallest current operation set. Request Describe for those operations and validate all values against its schemas. Use the organization-described entity label and fields; never assume a universal record type.

For search, send the non-empty lookup text extracted from the request. Omit `source` for general federation. When the user names a source, match it to current metadata and copy the entire `{platform, application, plugin}` object. Send one request; BOS owns selection, fan-out, translation, limits, retries, and response assembly. Use a separate read only when current discovery advertises it.

For create, require one described create-capable source and dynamic changes that satisfy its schema. For update or delete, require unambiguous evidence for one conceptual customer and prepare one request with one to five explicit targets. Copy each source and opaque `record.selector`; place described changes inside each update target. Reject duplicate source-selector pairs, bulk scope, several conceptual customers, and unresolved ambiguity.

Before delete, present every reviewed target, safe summary, effect, source guarantee, cross-source consequence, and reversibility returned by BOS. After affirmative approval invoke the returned action verbatim. Changed content requires a fresh review. Preserve every ordered outcome, its optional readback, and exactly one receipt or public error per target.

Treat reads as point-in-time. Present cross-source mutations as non-atomic and eventually consistent. On `202 in_progress`, show current outcomes, wait the advertised interval, then invoke only the returned bodyless state action. Supply no idempotency key, version, retry counter, reconciliation choice, or execution identity.
