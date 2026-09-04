# My CRM repository contract

My CRM is an independent third-party BOS application and native GPT plugin.
Treat this checkout as if it were owned by an external developer with access
only to public contracts and authenticated network endpoints.

## Hard repository boundary

- Never read, search, import, execute, link, copy source from, or depend on a
  BOS Operations Center, Lead Director, or BOS server checkout while working
  inside this repository.
- Never add filesystem paths, workspace dependencies, symlinks, generated
  fixtures, or build steps that resolve into another project checkout.
- Use this repository, published BOS contracts, official host-platform
  documentation, and live authenticated BOS endpoints only.
- Record a missing public capability in `Vault/docs/platform-gaps.md`; never
  inspect private implementation to work around it.

## Product invariants

- My CRM owns its independent plugin package, release, and host-specific thin
  integration.
- My CRM requires the separately installed BOS product and owns one product-
  scoped OAuth MCP connection at the sealed package resource declared in
  `plugins/my-crm/.bos-product.json`.
- The plugin requests provider-neutral semantic CRM capabilities and never
  embeds provider routing, credentials, tenant IDs, or database access.
- The plugin generates declarative FSM graphs for customer-specific CRM
  automations and submits them only through operations advertised by its live
  product MCP contract.
- BOS remains authoritative for authentication, organization and application
  scope, capability grants, graph validation, runtime execution, provider
  access, mutation governance, idempotency, and audit.
- The repository is licensed under Apache-2.0.

## Vault

- `Vault/` is the canonical private knowledge root for requirements, designs,
  decisions, specifications, implementation status, evidence, and reviews.
- Place durable design material in the appropriate Vault area rather than in
  ad hoc root-level documents.
- Never stage, commit, push, package, publish, or attach a Vault file. Run
  `npm run vault:sync` after meaningful Vault changes; generated indexes remain
  rebuildable local state.
- Public product contracts, executable source, examples, license files, and the
  customer-facing README remain Git-visible.

Run `npm test` before completing any implementation change.
