---
name: my-crm-pipeline-operations
description: Inspect or change authorized CRM stage, owner, status, value, opportunity, and next-action state through My CRM.
---

# My CRM Pipeline Operations

Discover the provider-neutral pipeline operation from the current My CRM MCP catalog. Let the server normalize provider vocabulary and select eligible sources.

For reads, preserve server-returned record handles, pipeline and stage labels, versions, source provenance, freshness, and eligibility evidence. Present current state separately from inferred next actions.

For a change, resolve one exact source record, require its current version, apply the single-record mutation safeguard, and invoke one discovered operation. Use idempotency only as declared by the schema. Verify the returned receipt or read-back before reporting completion and invalidate affected client caches.

When a request would update more than one source record, stop before mutation and offer a read-only comparison or a one-record selection. Leave source recovery and reconciliation with the server.
