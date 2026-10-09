---
name: my-crm-cache-maintenance
description: Inspect, refresh, or invalidate CRM cache state through cache operations discovered from the configured BOS URL after confirmed CRM mutations or when the user asks about stale CRM data, refresh, or clearing cached CRM information.
---

# My CRM Cache Maintenance

Start from the configured BOS discovery URL. Discover the current cache capability, input schema, limits, and execution contact through BOS before acting. Invoke only the operation and shape returned by discovery. Create no My CRM cache, frozen cache contract, file, database, authority selector, or cache partition. Let BOS privately derive the current cache binding from its authenticated transport.

Choose the narrowest currently discovered operation that satisfies the request. When BOS does not advertise a required cache operation, explain that the capability is unavailable and perform no substitute client-side cache work.

- inspect the current authority's CRM cache state;
- refresh one task-scoped Describe or query through current BOS discovery and its advertised HTTPS operation;
- invalidate one exact query;
- invalidate entries for one complete source reference copied from current Describe;
- invalidate one organization-described dataset; or
- invalidate the complete current BOS authority after authentication replacement without receiving or naming its private binding.

Apply the freshness policy and lifecycle advertised by BOS on every cache-eligible CRM request. A valid fresh entry may be used immediately. Follow discovered invalidation or refresh instructions for malformed, future-dated, or expired entries. Do not assume operation names, lease behavior, request fields, response states, or schema versions.

## Post-mutation invalidation ownership

`my-crm-cache-maintenance` is the sole owner of post-mutation cache invalidation for every My CRM mutation path. Record, pipeline, federation, automation, and umbrella skills delegate to this skill and perform no independent post-mutation invalidation.

The skill that invokes the mutation hands its public outcomes and receipts to this owner once, before a subsequent cache-backed read or workflow completion. An enclosing skill that delegates mutation execution also delegates this handoff; it must not repeat it. Use the public confirmation evidence already retained for the current task to recognize an already-handled commit. Create no persistent client ledger, execution identity, or retry state.

- Process every confirmed commit, including create, update, delete, pipeline changes, and successful targets in a partially failed or pending response. Rejected targets and unconfirmed outcomes establish no commit to invalidate.
- For pending outcomes, follow only the returned BOS state action. Hand off newly confirmed commits as they appear; repeated outcomes or receipts must not trigger another invalidation for the same commit. A later distinct commit in the same scope requires new invalidation.
- For each handoff, derive the affected scopes from confirmed outcomes and current Describe/cache contracts. Invalidate the union of every affected complete source reference and every affected organization-described dataset in the current BOS-derived cache binding. Include dependent query/view entries covered by those scopes. Deduplicate identical scopes across targets and use the narrowest advertised operation set whose declared coverage covers the entire union; invalidate an overlapping scope only once for that handoff. Never infer a dataset, construct a partition, or expand into another authority.
- Retain successful invalidation evidence with the handled public confirmations for the current task. If a required scope cannot be resolved, the operation is unavailable, or invalidation fails, report the exact incomplete maintenance and preserve the mutation result separately. Follow only advertised cache recovery for incomplete scopes, keep affected cached views flagged as potentially stale, and claim maintenance completion only after successful evidence covers every required scope. Never replay the CRM mutation to repair cache maintenance.

Label resulting views `live` or `cached`, show a human-readable local last-updated time, and preserve source coverage, conflicts, uncertainty, partial failures, and measured, estimated, or unavailable usage. Never claim a refresh occurred unless the shared cache and discovered operation returned successful evidence.
