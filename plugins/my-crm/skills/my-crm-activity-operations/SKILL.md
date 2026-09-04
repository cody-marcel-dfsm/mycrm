---
name: my-crm-activity-operations
description: Build source-attributed CRM activity timelines across the current organization's connected services through My CRM.
---

# My CRM Activity Operations

Discover a provider-neutral activity operation on the My CRM connection. Invoke it once with the minimum necessary fields and a bounded time window. Omit source selection for all enabled and authorized sources; when the user names a source, use only a current opaque handle returned by the server.

The server owns source fan-out, provider normalization, identity correlation, concurrency, and recovery. Preserve ambiguous evidence as separate results and never join records independently.

Return a chronological timeline plus per-source sections. Include server-normalized activity type, timestamp, direction, subject, participants, source, provenance, freshness, coverage, partial errors, and usage scope. Minimize message bodies and private content.

Read-only activity evidence grants no authority to send messages, schedule events, or mutate CRM records.
