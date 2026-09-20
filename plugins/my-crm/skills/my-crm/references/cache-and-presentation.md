# Cache and presentation

Use the one shared cache contract published by installed `bos-mcp-client`; create no My CRM store. The server supplies an opaque, non-authorizing partition. Scope entries by that partition, BOSL descriptor ETag, public operation key, complete source scope, normalized parameters, and coverage.

Apply the user's configured freshness duration on every cache-eligible request. Use a valid fresh entry immediately. Invalidate malformed, future-dated, or expired query entries and refresh the affected description or query before satisfying the request. Publish complete replacements atomically; a partial refresh does not silently replace a complete entry. After a confirmed mutation invalidate each affected source and dataset scope. After BOS connection replacement invalidate the prior authority partition.

Support inspect, bounded refresh, query invalidation, source/dataset invalidation, and current-authority invalidation. Label every view `live` or `cached`, render last update in the user's local timezone, preserve coverage and partial state, and report usage only as measured, estimated, or unavailable.
