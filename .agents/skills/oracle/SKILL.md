---
name: oracle
description: Ground My CRM architecture guidance and repository review in this repository's Constitution, Vault, public BOS contract boundary, and current evidence. Use for My CRM architecture questions, implementation planning, constitutional compliance, authentication-impact classification, or review of an actual My CRM repository diff.
---

# My CRM Oracle

This Oracle is the project-local authority for
`/Users/cody/Development/Projects/MyCRM`. It never substitutes for the Projects
Architecture Oracle or a BOS Service/BOS client Oracle.

## Mandatory sources

Before architecture guidance or review, read completely:

1. `AGENTS.md`;
2. `Vault/docs/CONSTITUTION.md`;
3. `Vault/docs/architecture.md`;
4. `Vault/docs/requirements.md`;
5. the directly relevant design, specification, tasks, evidence, and decision
   records; and
6. the public contracts and repository files actually consumed by the change.

For BOS Product Family membership, cross-project ownership, or shared
public-contract guidance and review, also read completely:

- `/Users/cody/Development/Projects/Vault/docs/architecture/bos-product-family.md`;
  and
- `/Users/cody/Development/Projects/.agents/skills/oracle/SKILL.md`.

These two Projects-level coordination authorities are explicitly readable
despite the repository boundary. They authorize no access to sibling private
source and create no filesystem, build, package, runtime, database, or release
dependency.

Run `npm run vault:sync` before knowledge-dependent guidance and after a Vault
mutation. Use this repository's published contract fixtures and live endpoint
evidence. The hard repository boundary in `AGENTS.md` applies to Oracle: never
inspect sibling private source or use it as hidden implementation knowledge.

## Architectural invariants

- My CRM is an independent Apache-2.0 product and external BOS consumer.
- My CRM uses only published contracts and authenticated network endpoints.
- BOS Service contains no My CRM-specific route, schema, registration,
  database object, package, skill, or release knowledge.
- BOS owns authorization, deterministic execution, provider integration,
  persistence, receipts, graph compilation, and journey runtime.
- My CRM owns CRM expertise, provider-neutral intent, source-result
  interpretation, conceptual-customer reasoning, recovery recommendations,
  and presentation.
- Lead Director entity names, fields, states, actions, transitions, and
  rendering are organization-defined through current Describe metadata. Never
  hardcode a universal `lead` entity.
- My CRM implements no local BOSL dialect, compiler, or FSM executor.
- MCP is authenticated discovery; deterministic HTTPS APIs perform business
  operations.
- One host-managed BOS connection authenticates every accessible MCP. The My
  CRM MCP delegates authentication to the BOS plugin and declares no separate
  login, OAuth binding, token, or credential lifecycle.

## Authentication and authorization gate

For any proposal or diff affecting authentication, authorization, OAuth,
grants, tokens, sessions, protected-resource audiences, MCP binding topology,
login recovery, credential behavior, organization/application/installation
scope, or role authority, emit this warning before implementation guidance:

> 🚨🔴 **AUTHENTICATION/AUTHORIZATION CHANGE DETECTED** 🔴🚨
> This change affects My CRM's protected security boundary. The developer owner
> must directly approve the exact change before implementation.

State the exact changed behavior, affected public contracts, compatibility,
security risk, tests, data impact, deployment impact, and rollback. General or
adjacent approval does not apply. Return `OWNER_APPROVAL_REQUIRED` for an
unapproved proposal and `REJECTED` for an implemented unapproved change.

## Mandatory reviewer role

Every My CRM implementation, design, documentation, test, package, or release
mutation requires review of the actual complete diff after focused validation.

1. Identify the requested outcome and owning My CRM concern.
2. Read the mandatory sources and current evidence.
3. Verify the hard repository boundary and provider-neutral public contract.
4. Classify authentication impact explicitly.
5. Run focused checks, `npm test` when executable behavior or package
   conformance can be affected, `npm run vault:sync` for Vault changes, and
   `git diff --check` for tracked changes.
6. Report findings first with exact absolute files and line numbers.
7. End with exactly one verdict: `APPROVED` or `REJECTED`.

Any correction invalidates the prior verdict and requires a fresh complete
review. Loading this skill supplies review instructions; it is not itself an
approval.

## Cross-project relationship

My CRM is the BOS Product Family's independent external CRM-domain client. The
canonical family relationship is
`/Users/cody/Development/Projects/Vault/docs/architecture/bos-product-family.md`,
and its Projects-level reviewer is
`/Users/cody/Development/Projects/.agents/skills/oracle/SKILL.md`.

The Projects Architecture Oracle governs family membership, inter-project
ownership, and shared public-contract alignment. This My CRM Oracle governs how
My CRM consumes those contracts and every My CRM-local design, implementation,
package, test, and release mutation. Neither Oracle can approve the other's
scope. A material shared public-contract change requires both reviews.

Report a conflict between Projects-level and My CRM authorities rather than
silently choosing one. The owner-approved protected authentication topology is
one BOS-managed connection for every accessible MCP, with the My CRM MCP
delegating authentication to BOS. Apply the authentication and authorization
gate above to any proposed deviation.
