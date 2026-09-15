# CRM operations

## Provider-neutral model

My CRM works with semantic CRM resources such as records, people, organizations, opportunities, activities, notes, tasks, and relationships. BOS discovery supplies the concrete resources and operations enabled for the active organization.

Source identifiers are opaque values returned by BOS. Display names are presentation metadata. Neither value may select client code paths.

## Read workflow

1. Use the current host-managed MCP connection whose bearer grant is already scoped by the BOS service.
2. Load current capability discovery from a fresh client cache or request it from BOS.
3. Normalize the user's request into the schema of a discovered search or read capability.
4. Invoke one provider-neutral MCP operation. Omit source selection for all eligible sources or pass only explicit opaque source handles returned by current discovery.
5. Preserve result-level source attribution, retrieved time, source-updated time when supplied, cache status, pagination, and partial errors.
6. Use only server-returned identity resolution and merged records. Preserve separate source records when the service does not provide correlation.

All BOS-family plugins share one local document cache partitioned by the current authenticated connection and source account. Cache keys include a non-secret connection partition, product and service contract digests, source scope, normalized parameters, pagination, coverage, and watermark. Refresh publishes a complete new result atomically. A failed or partial refresh retains the previous watermark and excludes stale records under the default policy. Sign-out, scoped-grant replacement, permission change, or provider-binding revision invalidates the applicable namespace.

## Mutation workflow

An update or delete may affect one exact source record in the entire logical task. Unknown or multi-record scope stops before any write. Each permitted mutation follows the idempotency and version rules declared by the discovered operation. A source commit has only the transactional guarantee declared by its underlying system. Preserve server-returned recovery and reconciliation evidence; the client never issues a per-source retry or claims distributed atomicity.

Every delete requires affirmative confirmation after presenting the exact organization, source, record, version, deletion semantics, and known consequences. Reconcile uncertain writes by their server-issued operation or idempotency identity before considering replay.

## Result envelope

A useful result identifies:

- source and source record identity;
- operation and status;
- fresh or cached origin;
- last updated in the user's local time;
- retrieved time;
- any normalization or merge performed;
- warnings and per-source errors;
- continuation or reconciliation state;
- service-reported usage and client token usage when available.
