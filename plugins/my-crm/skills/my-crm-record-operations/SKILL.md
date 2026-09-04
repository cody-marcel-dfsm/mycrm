---
name: my-crm-record-operations
description: Find, list, create, update, or delete CRM leads and contacts through the current provider-neutral My CRM operation contract.
---

# My CRM Record Operations

Use the My CRM product MCP and the organization context selected by `my-crm`. Choose an exact lookup, search, filtered list, pagination, batch read, create, update, or delete operation from the current catalog. Follow its live input schema and side-effect declaration.

## Reads

- Preserve the user's requested scope. A broad list remains a list; a named-person request resolves an exact record or reports ambiguity.
- Use server-issued source and record handles only. Reuse current-context evidence only while its contract, version, authority, and freshness remain valid.
- Preserve source provenance, record version, observation time, and cache status.
- Invoke `my-crm-customer-journey` for every displayed lead, including list entries and mutation receipts, unless the user explicitly chooses another format.

## Mutations

- Create only through a discovered create operation. Use advertised duplicate detection before commit.
- Update one exact affected record per logical task. Send only confirmed fields, current version, and an idempotency key when the schema supports it.
- Block bulk or unknown-scope updates and deletes before the first write.
- Before every delete, display the selected organization, source, exact record, current version, deletion semantics, and known consequences; wait for affirmative confirmation bound to that plan.
- Deletion support never implies archive or state-transition substitution.
- Reconcile an uncertain outcome by the returned operation or idempotency identity before considering replay.
- Report structured success and read-back evidence. A successful preview, plan, or schema read is not a completed mutation.

Never call an underlying provider or database.
