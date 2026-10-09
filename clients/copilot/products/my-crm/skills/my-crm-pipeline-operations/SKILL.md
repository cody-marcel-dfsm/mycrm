---
name: my-crm-pipeline-operations
description: Inspect or change only currently advertised CRM state, ownership, status, value, opportunity, and next-action behavior through BOS-discovered contracts.
---

# My CRM Pipeline Operations

Discover the current public operation key and request only its Describe contract. Use its organization-defined labels, fields, schemas, source availability wrappers, guarantees, and exact HTTPS route template. Never normalize source vocabulary into a fixed pipeline model.

For reads, preserve source, opaque selector, current observation, freshness, eligibility evidence, and public errors. Separate current facts from client inference.

For a change, apply the [record-operation safeguards](../my-crm-record-operations/SKILL.md): one conceptual customer, one to five explicit targets, described changes, ordered receipts/errors, and no client version, idempotency, retry, or execution state. Delegate post-mutation invalidation exclusively to `my-crm-cache-maintenance`, passing confirmed outcomes and receipts once. When `my-crm-record-operations` executes the change, it owns that handoff; do not repeat it or invalidate independently.
