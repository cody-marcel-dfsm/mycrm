
## Deterministic source-maintenance publication

For the validation-selector bootstrap and its maintenance repairs, the native
`node scripts/deterministic-publication.mjs` workflow performs deterministic
validation without dispatching model reviewers. Its scope is linear maintainer
source/test/document changes and version-only package metadata; product behavior,
workflow or infrastructure changes remain outside this admission path. This is
source publication only, not protected deployment authorization.

Commit the complete clean candidate, run `validate <full-base-SHA>
<original-request-ISO-time-or-unknown>`, then `prepare`. Preserve original clocks
and failures; an unknown or exceeded clock establishes no timing success. The
runner executes the entire fixed bootstrap plus privacy, boundary and public
contract checks; source, runtime, dependency and output drift invalidate evidence.
Preparation triggers and verifies the existing exact-source GitHub CI job, with
no imported passing result. Follow its returned native publish command only after
CI succeeds. The normal pre-push gate rechecks deterministic custody. Never
fabricate legacy Oracle review stamps or disable hooks. For other change classes,
retain the existing selected-contract and publication requirements.


## Fixed validation selected before implementation

The controlling delivery budgets are docs_only120s, bug_fix180s,
deep_bug_fix300s and feature300s end to end, including network/build/effects and
verification (verified Git publication for source-only work). The host's original
request clock survives retries and revisions; local PASS is only phase PASS.
Rank/pare checks before freezing the contract, then run the whole selected set.
Small bugs get deterministic focused tests only; auth/cross-area work is deep.
No automatic broader regression or partial/empty/skipped PASS. Use low reasoning
for simple work and medium for hard work, never above medium or paid fallback.
Authenticated platform JEV may assist prioritization without granting authority.


The controlling maintainer validation contract is documented in
`scripts/validation-contract.md`. The independent native proposal fixes a change
class, exact executable categories and planned scope before implementation.
`docs_only` uses minimal genuine-document sanity; `bug_fix` requires the focused
assertion to fail before and pass after; `deep_bug_fix` adds complete relevant
interactions; `feature` requires thorough relevant acceptance. Implementation,
release and CI consume that same immutable selection. No empty, skipped, partial,
cancelled or todo test run is a pass. Source, catalog, runtime and original results
remain bound; scope changes require an explicit independently reviewed revision.
Keep a small curated recurrence registry instead of accumulating feature tests.
This supersedes a blanket whole-suite baseline only for valid selected contracts;
the initial selector bootstrap retains its existing proposal and records a new
explicit scoped bootstrap epoch; original broad failures remain failures.
Privacy, boundary, independent review and publication gates remain in force.
Ordinary implementers do not adopt the independent approver skill.

# My CRM repository contract

My CRM is an independent third-party BOS application and native GPT plugin.
Treat this checkout as if it were owned by an external developer with access
only to public contracts and authenticated network endpoints.

Governing constitution: `Vault/docs/CONSTITUTION.md`.

Project-local Oracle command: `npm run oracle:review`.
Project-local proposal command: `npm run oracle:proposal -- "<proposal>"`.

Maintained family review-coordination design:
`/Users/cody/Development/Projects/Vault/docs/architecture/oracle-validation.md`.
This declared read-only governing document supplies review criteria and creates
no sibling source, runtime, package or approval dependency.

The Oracle is an independent approval process. Ordinary implementation,
review, release, and shipping agents call the command; they never load, adopt,
quote, or impersonate `.agents/skills/oracle/SKILL.md`. The command launches
the isolated Oracle approver, which alone loads that skill, classifies
authentication impact, emits protected-change warnings, and returns the
verdict bound to the exact staged Git tree.

Before mutation, submit the proposed Problem, Cause, and Recommended change to
the proposal command. Continue automatically after technical approval within
the user's task authorization. Complete proposal/source review, receipt issuance,
commit eligibility and review-branch publication independently of human deployment
permission. Identify actual protected deployment decisions separately; the owning
publication/install workflow checks exact human authority before mutation.
Proposal review writes a separate local record and never substitutes for the
completed staged-tree receipt.

Owner direction, 2026-10-18: “Reviews should never require approvals. I's the
deployment that requires approval, but only for very specific changes”.
Maintained design: `Vault/docs/review-deployment-approval.md`; implementation
tasks: `Vault/docs/tasks/review-deployment-approval.md`. Actual credential-trust,
permission-authority, tenant-isolation or incompatible-public-contract effects
receive source/effect-bound deployment checks. Broad labels, filenames,
authentication impact alone, ordinary corrections and compatible repairs create
no approval requirement. Missing deployment authority never becomes a technical
finding or rejection. Late authorization preserves the immutable completed
technical receipt and unchanged coverage. Preserve technical defects, exact
candidate/output custody, independent roles, API-version REQUEST, runtime security
and separate cost controls.

## API-version request requirement

An API-version change requires the user's explicit request for that exact
change. General approval, a release request, compatibility reasoning, or an
Oracle recommendation supplies no API-version request. Fix behavior and retain
all implemented improvements within the existing API version unless the user
explicitly requests a version change. Package patch versions and independent
authentication-envelope identifiers remain distinct. Both proposal and
completed reviews must assess API-version impact separately from authentication
approval and verify direct-user request evidence and exact scope.

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
  credential lifecycle. Deployment of a specifically protected future effect
  requires applicable direct owner authority; technical review completes first.
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

Execute every category of the fixed Oracle-selected contract before completing an implementation change. During repair follow-ups, retain verified unchanged observations and execute complete affected selected categories. A change to scope or risk requires an explicit contract revision before implementation; a whole-suite baseline is not automatic.

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

## Oracle review continuity

Source work by every author and implementation continues throughout review.
Review imposes no source-file or code-line lock, checkout freeze or work pause.
Include and validate all arrived changes in the complete current candidate.
Use the maintained local design in `Vault/docs/oracle-review-continuity.md` and
implementation map in `Vault/docs/tasks/oracle-review-coordination.md`.
Actual prior-attempt delta and cumulative pending repair delta are distinct.
Raw ERROR-attempt observations retain original candidate, reported status,
criteria, dependencies, evidence and finding identities as supporting material;
only fresh independent applicability assessment establishes current coverage.

The launcher designates its isolated reviewer through trusted developer
configuration. Ordinary agents keep invoking the command and never adopt the
approver skill. The private `.git/oracle/series/` records preserve a review
series across in-scope repair proposals and retain earlier rounds when the
base changes. Keep these records intact; process failures resume unfinished
coverage and use `ERROR` or `INCOMPLETE`, while source `REJECTED` requires a
completed assessment.

The first review covers the complete candidate and relevant callers,
dependencies, boundaries and failure paths, then returns all established
findings together. Findings carry stable IDs, reproduction, required behavior,
affected paths and acceptance checks. Repair every finding as a set and supply
resolution evidence for each ID on resubmission. Follow-up review checks the
repair and affected dependencies, independently verifies eligible prior
coverage and validation, and explicitly records invalidation reasons. A late
unchanged-code finding records missed first-pass coverage; a repair-induced
defect identifies its changed dependency. After two unsuccessful repair rounds,
the wrapper immediately publishes and retains one repair plan containing all
open IDs, required behavior, overlapping paths and acceptance checks alongside
that rejection, before implementation resumes. Omitted reviewer synthesis
never creates an extra process retry.

Capture reusable checks with `npm run oracle:validate -- -- <command> [args]`
after staging the exact candidate, then supply its emitted evidence reference
to `oracle:review --validation`. The recorder actually runs the command and
retains original before/after input, executable and environment bindings,
passing outcome and output hashes. Reuse successful validation only with that
unchanged native record and the independently verified complete source, test,
fixture, configuration and tooling dependency closure. Existing logs remain
review evidence; assigning current hashes to an old log never creates a
reusable result. A verified captured pass satisfies the requirement to execute
that check for those exact inputs; preserve it in the review result and repeat
it only for an invalidated input or a concrete new coverage gap. Rerun affected
checks when these inputs change; shared
behavior changes can require broader regression checks. The complete selected contract remains required; verified unaffected observations carry forward through complete affected category checks. Evidence reuse
never carries an approval forward: every updated candidate requires a fresh
independent whole-candidate decision and exact staged-tree receipt. Public API
version requests, specifically protected deployment authority, provenance and verifier gates
continue to apply.
Receipt verification rechecks original native output integrity and exact source
bindings across hook/CLI contexts; ambient environment differences require
reassessment during live review and do not rewrite an existing execution's
provenance.
Reusable observations treat AGENTS, the constitution and approver policy/schema
as global controlling inputs. Other canonical Vault authorities remain in the
exact full-candidate receipt binding and per-path dependency map: changing an
unrelated status/design document reopens its own review and actual dependents.
On a follow-up, the launcher automatically reattaches its retained native
execution records after verifying original record and output hashes, then
rechecks their current dependency/configuration/environment applicability.
Omitted attachment alone never requires repeating a passing check. Missing or
altered originals produce concrete invalidations. Legacy logs, owner approval
and API-version request evidence are never inferred from command history.
Review inputs bind inherited parent AGENTS policy and the exact declared parent
family architecture and review-coordination design, including absent-file
tombstones. The declared Projects Oracle command identifies the supported
invocation; its content and custody participate when explicitly consumed as
review evidence or a source dependency. Invocation references alone create no
automatic command-source read or binding. Allowlisted absolute paths identify
actual coverage dependencies; changed parent policy reopens governing criteria,
while other consumed external changes reopen their own coverage and actual
dependents. This evidence binding preserves MyCRM ownership and creates no
sibling runtime import, execution or approval authority.

## Canonical main and project agent context

Work exclusively on `main` in `/Users/cody/Development/Projects/MyCRM`. Do not create, switch to, or use Git worktrees for planning, implementation, validation, review, or release. Existing worktree changes may be read solely for recovery into canonical main; preserve those sources until recovery is verified. Run the implementation agent from this directory and follow this project's skills, validation commands, and Oracle process. Preserve staged, unstaged, and untracked changes, fetch and reconcile remote main before implementation and publication, record the base commit, and validate the complete integrated main before release.

For a focused native check, repeat `--input <exact-project-file>` for every source, test, fixture, configuration and authority file the command consumes before `-- <command>`. New explicit-input captures bind those live/indexed paths plus package configuration, effective environment and executable. Git base/branch and unselected reviewer authority, policy, proposal and owner metadata remain truthful provenance; their changes preserve an unchanged execution fact. Select a policy file when the command consumes it. Existing records retain their original scope. Omit `--input` for the conservative complete-candidate capture. The independent reviewer verifies dependency completeness, and every completed receipt still binds the entire exact current staged tree and governing authority.
