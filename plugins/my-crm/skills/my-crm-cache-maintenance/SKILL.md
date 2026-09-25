---
name: my-crm-cache-maintenance
description: Inspect, refresh, or invalidate My CRM query metadata and results through the shared BOS client cache when the user asks about cache state, stale CRM data, refresh, or clearing cached CRM information.
---

# My CRM Cache Maintenance

Use only the public shared cache contract supplied by installed `bos-mcp-client`. Create no My CRM cache, file, database, authority selector, or cache partition. Send complete public source and query scope to the cache consumer and let BOS privately derive the current cache binding from its authenticated connection.

Choose the narrowest operation that satisfies the request:

- inspect the current authority's CRM cache state;
- refresh one task-scoped Describe or query through current BOS discovery and its advertised HTTPS operation;
- invalidate one exact query;
- invalidate entries for one complete source reference copied from current Describe;
- invalidate one organization-described dataset; or
- invalidate the complete current BOS authority after authentication replacement without receiving or naming its private binding.

Apply configured freshness on every cache-eligible CRM request. A valid fresh entry may be used immediately. Invalidate malformed, future-dated, or expired query entries and refresh before satisfying the request. Use begin, commit, and abort through the shared BOS cache consumer so only a complete replacement becomes visible; keep the prior complete watermark when a refresh is partial or fails.

After a confirmed CRM mutation, invalidate every affected source and dataset scope. Label resulting views `live` or `cached`, show a human-readable local last-updated time, and preserve source coverage, conflicts, uncertainty, partial failures, and measured, estimated, or unavailable usage. Never claim a refresh occurred unless the shared cache and discovered operation returned successful evidence.
