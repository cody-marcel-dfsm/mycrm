---
name: my-crm-customer-journey
description: Complete individual lead/contact lookups and details with a compact application-owned journey graph using discovered record and topology evidence.
---

# My CRM Customer Journey

Apply [individual CRM detail completion](references/detail-display.md) to ordinary
lead/contact lookups and detail results. Present one compact preferred route by
default, retaining every verified intermediate state and the shortest structural
fallback. Use the full graph only when the user requests that view.

Use only currently advertised graph, node, or record operations. Present the organization-described entity label, current node, verified transition history, reachable goals, directed paths, gates, blockers, rendering, actions, provenance, and freshness returned by those contracts.

For a read-only customer-journey request, start with the application-owned
journey read advertised by current discovery. Resolve its exact operation key,
schema, and deterministic HTTPS transport before considering other graph or
record capabilities. A record-read operation may provide that journey when its
returned contract explicitly declares those semantics. Resolve the target
through discovered CRM search/read operations and copy only the identifiers
and source references required by the journey-read schema.

Inspect the actual advertised journey-read contract before reporting that
journey evidence is unavailable. Keep a failed alternative lookup scoped to
that attempted capability. Application-owned customer-journey reads return
record and topology facts; workflow registration and runtime lifecycle
operations retain their separately advertised purposes and prerequisites.

Keep topology facts, record facts, external evidence, and labeled client inference separate. A structural path does not prove eligibility. Use a server-ranked path when supplied; otherwise label a derived structural route `eligibility unverified`.

Use the BOS-owned visualization and add CRM labels, provenance, uncertainty, source outcomes, and guarantees. Never expose private runtime state or infer a transition from list order, chronology, or conventional stages. An absent journey operation remains an explicit platform dependency.
