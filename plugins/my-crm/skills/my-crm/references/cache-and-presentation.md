# Cache and presentation

Use the one shared cache contract published by installed `bos-mcp-client`; create no My CRM store. Supply only the complete Describe source, public operation, resource kind, normalized public selector, descriptor token, freshness window, and refresh-through behavior. BOS privately resolves the current cache binding from the active authenticated connection; My CRM neither supplies nor receives that binding.

Apply the user's configured freshness duration on every cache-eligible request. Use a valid fresh entry immediately. Abort malformed, future-dated, expired, partial, or failed replacements and refresh the affected description or query before satisfying the request. Commit complete replacements through the BOS lease protocol. After a confirmed mutation invalidate each affected source and dataset scope. After BOS authentication replacement request current-authority invalidation through BOS without identifying an authority partition.

Support inspect, bounded refresh, query invalidation, source/dataset invalidation, and current-authority invalidation. Label every view `live` or `cached`, render last update in the user's local timezone, preserve coverage and partial state, and report usage only as measured, estimated, or unavailable.
