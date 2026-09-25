---
name: my-crm-cache-maintenance
description: Inspect, refresh, or invalidate CRM cache state through cache operations discovered from the configured BOS URL when the user asks about stale CRM data, refresh, or clearing cached CRM information.
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

After a confirmed CRM mutation, invalidate every affected source and dataset scope. Label resulting views `live` or `cached`, show a human-readable local last-updated time, and preserve source coverage, conflicts, uncertainty, partial failures, and measured, estimated, or unavailable usage. Never claim a refresh occurred unless the shared cache and discovered operation returned successful evidence.
