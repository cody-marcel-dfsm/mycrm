# Cache and presentation

Start from the configured BOS discovery URL and discover any current cache capability, input schema, limits, and execution contact. Use only the returned contract; create no My CRM store or frozen cache adapter. BOS privately resolves the cache binding through its authenticated transport; My CRM neither supplies nor receives that binding.

Apply the freshness policy returned by BOS on every cache-eligible request. Use a valid fresh entry immediately. Follow the discovered recovery, refresh, and invalidation instructions for malformed, future-dated, expired, partial, or failed entries. After a confirmed mutation use the currently advertised invalidation operation for each affected source or dataset. After BOS authentication replacement use its currently advertised current-authority invalidation operation without identifying an authority partition.

Use inspect, bounded refresh, query invalidation, source or dataset invalidation, and current-authority invalidation only when discovery advertises them. Assume no operation name or request shape. Label views `live` or `cached` when returned by the service, render last update in the user's local timezone, preserve coverage and partial state, and report usage only as measured, estimated, or unavailable.
