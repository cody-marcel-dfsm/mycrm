# My CRM repository contract

My CRM is an independent third-party BOS application and native GPT plugin.
Treat this checkout as if it were owned by an external developer with access
only to public contracts and authenticated network endpoints.

Governing constitution: `Vault/docs/CONSTITUTION.md`.

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
- My CRM requires the separately installed BOS product and declares one
  product-scoped authenticated MCP at the sealed package resource declared in
  `plugins/my-crm/.bos-product.json`.
- The MCP is the authenticated discovery plane. It describes live semantic
  operations and their deterministic HTTPS API contracts. My CRM invokes those
  APIs for business execution and performs no CRM operation through MCP
  `tools/call`.
- The BOS plugin and BOS skills orchestrate generic OAuth bootstrap and
  authentication recovery for the product-owned connection. The client host
  owns token storage, refresh, and bearer attachment. The resulting OAuth grant
  is already scoped by the BOS service to one organization, application,
  installation, and role. My CRM contains no authentication implementation,
  receives no authority selector, and uses only the host-managed authenticated
  MCP transport.
- My CRM recognizes authentication challenges, delegates them automatically to
  BOS, preserves the pending operation, refreshes authenticated discovery, and
  resumes once. Authentication recovery never becomes a My CRM failure or
  user-authored repair workflow.
- The plugin requests provider-neutral semantic CRM capabilities and never
  embeds provider routing, credentials, tenant IDs, or database access.
- BOS operating-system and application-client skills request and consume explain
  plans and own BOSL authoring and workflow orchestration. The BOS server owns
  prompt interpretation, tenant-specific model and source resolution, and
  construction of the complete executable explain plan. My CRM reasons about
  that returned plan, contributes CRM goals, constraints, parameters, and
  presentation, then invokes only APIs advertised by live discovery.
- Prompt-scoped descriptions come from authoritative persisted organization
  metadata through indexed point reads. Client code embeds no model, source,
  field, relationship, or route binding. Server explain planning scans no
  business data nodes or application graphs and has a sub-second response SLA.
- BOS server contracts contain no My CRM-specific route, service, resource,
  registration, database object, skill group, or release metadata.
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
