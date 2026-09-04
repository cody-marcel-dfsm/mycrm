---
name: my-crm-federation-operations
description: Compare and merge CRM sources for presentation while preserving server-owned identity confidence, provenance, conflicts, and recovery state.
---

# My CRM Federation Operations

## Compare and merge for presentation

1. Invoke one provider-neutral My CRM query.
2. Preserve every server-returned source result and lifecycle event.
3. Use only the service's federated records as the merged view. Never rerun identity matching or strengthen match confidence.
4. Attach field-level provenance, freshness, and conflict evidence.
5. Present successful sources alongside explicit partial failures.

## Mutation boundary

Updates and deletes may affect one exact source record in the logical task. A merged contact represented by multiple source records counts as multiple records and is outside the client mutation limit. Offer a read-only comparison or ask the user to choose one exact target.

For an allowed single-record write, use the server-returned source and record handles, current version, declared field authority, and discovered mutation schema. Preserve the source's transactional guarantee and any server-returned reconciliation action. Never perform per-source retries or create client recovery state.

Never silently choose authoritative fields, overwrite an ambiguous identity, or claim distributed atomicity.
