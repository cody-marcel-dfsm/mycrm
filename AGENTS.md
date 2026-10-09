# My CRM repository contract

My CRM is an independent third-party BOS application and native GPT plugin.
Treat this checkout as if it were owned by an external developer with access
only to public contracts and authenticated network endpoints.

Governing constitution: `Vault/docs/CONSTITUTION.md`.

Project-local Oracle command: `npm run oracle:review`.
Project-local proposal command: `npm run oracle:proposal -- "<proposal>"`.

The Oracle is an independent approval process. Ordinary implementation,
review, release, and shipping agents call the command; they never load, adopt,
quote, or impersonate `.agents/skills/oracle/SKILL.md`. The command launches
the isolated Oracle approver, which alone loads that skill, classifies
authentication impact, emits protected-change warnings, and returns the
verdict bound to the exact staged Git tree.

Before mutation, submit the proposed Problem, Cause, and Recommended change to
the proposal command. Continue automatically when the Oracle approves work
within the user's existing task authorization. Stop and request the user's
exact approval only when the Oracle flags a genuinely new architecture, public
API, authentication, or authorization decision; keep each labeled section to
three concise sentences. Proposal review writes a separate local record and
never substitutes for the completed staged-tree receipt.

## BOS Product Family coordination

Projects-level family architecture:
`/Users/cody/Development/Projects/Vault/docs/architecture/bos-product-family.md`.

Projects-level Oracle: request review only through
`/Users/cody/Development/Projects/tools/projects_oracle.py`. My CRM agents
never load the Projects approver skill directly.

- My CRM is the BOS Product Family's independent external CRM-domain client.
  It contributes provider-neutral CRM expertise and consumes published BOS
  discovery and deterministic API contracts.
- Read the family architecture and request a Projects Oracle decision through
  `/Users/cody/Development/Projects/tools/projects_oracle.py` for product-family membership, cross-project ownership, or a
  shared public-contract question. The family architecture is explicitly
  readable from this repository despite the hard boundary below; the Projects
  approver skill remains private to its Oracle process.
- This repository's Vault and project-local Oracle remain authoritative for My
  CRM internals, implementation, package, tests, and release. The Projects
  Oracle never substitutes for project-local review.
- A material cross-project public-contract change requires both Projects-level
  review and My CRM project-local review. Report a conflict between authorities
  and resolve it through both scopes rather than silently selecting one.
- The owner-approved family authentication topology uses one BOS-managed
  connection for every accessible MCP. My CRM's MCP delegates authentication
  to the BOS plugin and declares no separate login, OAuth binding, token, or
  credential lifecycle. Any future change requires direct owner approval.
- Projects-level coordination access creates no sibling source, filesystem,
  build, package, runtime, database, or release dependency.

## Hard repository boundary

- Never read, search, import, execute, link, copy source from, or depend on a
  BOS Operations Center, Lead Director, or BOS Service checkout while working
  inside this repository.
- Never add filesystem paths, workspace dependencies, symlinks, generated
  fixtures, or build steps that resolve into another project checkout.
- Use this repository, published BOS contracts, official host-platform
  documentation, and live authenticated BOS endpoints only.
- Record a missing public capability in `Vault/docs/platform-gaps.md`; never
  inspect private implementation to work around it.

## Product invariants

- My CRM source, tests, fixtures, prompts, documentation, Vault, evidence,
  generated packages, and release gates contain no real customer,
  organization, user, email address, tenant, context label, or customer ID.
  Acceptance uses generated tenant-neutral synthetic values and persists no
  identity-bearing fixture or response values.
- My CRM owns its independent plugin package, release, and host-specific thin
  integration.
- My CRM requires the separately installed BOS product. Its MCP operates from
  the authenticated BOS connection and delegates authentication to the BOS
  plugin; the package declares no second login or authenticated connection.
- The MCP is the authenticated discovery plane. It describes live semantic
  operations and their deterministic HTTPS API contracts. My CRM invokes those
  APIs for business execution and performs no CRM operation through MCP
  `tools/call`.
- The BOS plugin and BOS skills orchestrate OAuth bootstrap and authentication
  recovery for the shared BOS connection. The client host owns that
  connection's token storage, refresh, and bearer attachment. BOS revalidates
  the exact organization, application, installation, role, capability, and
  provider authority for every operation. My CRM contains no authentication
  implementation, receives no authority selector, and uses only the
  BOS-authenticated transport.
- My CRM recognizes authentication challenges, delegates them automatically to
  BOS, preserves the pending operation, refreshes authenticated discovery, and
  resumes once. Authentication recovery never becomes a My CRM failure or
  user-authored repair procedure.
- The plugin requests provider-neutral semantic CRM capabilities and never
  embeds provider routing, credentials, tenant IDs, or database access.
- BOS operating-system and application-client skills interpret prompts,
  construct and consume explain plans, and own BOSL authoring and client-directed
  Agent-Driven Custom Journey orchestration. A BOSL node with `type: "server"`
  is a server-executable journey node. The BOS Service resolves its sanctioned
  operation from indexed installed-plugin graph metadata, validates and binds
  it at compile time, and owns deterministic graph registration, transitions,
  sanctioned server operations, and persistence. Plugin enablement and
  authenticated user access govern journey availability. Authenticated BOS
  application discovery exposes accessible plugin journeys, composable public
  semantic operations, exact BOSL shapes, and readiness separately. My CRM
  reasons about the CRM portions of the client-authored plan, contributes CRM
  goals, constraints, parameters, and presentation, then invokes only APIs
  advertised by live discovery. BOS Operations Center owns bounded `next`, conditional
  `transitions`, and final-failure `catch` authoring. BOS Service evaluates
  conditions, enforces visit limits, and selects every transition; My CRM may
  contribute CRM recovery advice only when a catch path reaches a client-owned
  recovery node that requests its domain expertise.
- Operation-scoped descriptions come from authoritative persisted organization
  metadata through indexed point reads. Client code embeds no model, source,
  field, relationship, or route binding. Server description retrieval scans no
  business data nodes or application graphs and has a sub-second response SLA.
- BOS Service contracts contain no My CRM-specific route, service, resource,
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

Every repository mutation requires review of the complete staged tree through
`npm run oracle:review`. A mutation is incomplete until the Oracle utility
records the literal verdict `APPROVED` for that exact tree; any correction
invalidates the receipt and requires a fresh review. `npm run oracle:verify`
and the repository commit hooks reject a missing, rejected, or stale receipt.
CI verifies that the receipt-derived commit stamp names its exact Git tree.
Completed review requires an approved proposal record bound to the current
base and verifies the candidate remains within its scope.

The trust boundary is process separation: implementation agents obey this
workflow and cannot wear the approver skill; the isolated Oracle subprocess
alone evaluates the staged candidate and writes the receipt. This process does
not model an implementation agent as a malicious same-OS adversary with direct
access to `.git` or the ability to rewrite the gate itself.

## Canonical main and project agent context

Work exclusively on `main` in `/Users/cody/Development/Projects/MyCRM`. Do not create, switch to, or use Git worktrees for planning, implementation, validation, review, or release. Existing worktree changes may be read solely for recovery into canonical main; preserve those sources until recovery is verified. Run the implementation agent from this directory and follow this project's skills, validation commands, and Oracle process. Preserve staged, unstaged, and untracked changes, fetch and reconcile remote main before implementation and publication, record the base commit, and validate the complete integrated main before release.
