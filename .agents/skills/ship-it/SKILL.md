---
name: ship-it
description: Ship outstanding MyCRM commits through bootstrap, direct Git preparation, independent validation, and exact validated-commit delivery. Repeated unchanged shipments finish without a new release.
---

# Ship It

Run in canonical `/Users/cody/Development/Projects/MyCRM` on `main`. Read the
current governing instructions first and use the independent local Oracle
commands. The shipping agent never classifies authentication impact or adopts
`.agents/skills/oracle/SKILL.md`.

## Clock and coordination

Start timing at the original user release instruction, including time before the
first tool call. Preserve that timestamp across retries and continuation; record
an unavailable original timestamp honestly. Record each step's start/end and
elapsed time in one local shipment record. Bootstrap is under 120 seconds; the
complete review lifecycle target is 180 seconds and the complete release target
is 300 seconds from the original instruction. Record a breach and continue the
authorized work while correcting its concrete cause.

The Projects agent coordinates member ownership, progress and evidence. During a
family shipment, run this member's entire step 3 concurrently with step 3 in every
other family member that has unvalidated commits. Each member owns its lint,
tests, independent review, repair commits, revalidation and checkpoint. A member
with no new commits performs no validation or release work. Sequence deployment
only for a concrete dependency between the prepared releases.

## 1. Bootstrap

1. Read `AGENTS.md`, relevant current Vault authorities and `README.md` release
   guidance once. Retain loaded instruction identities; reread only changed or
   missing instructions. Reuse the coordinator's once-only family inventory.
2. Use canonical main, preserve every author's staged/unstaged/untracked work,
   existing stashes and recovery sources. Fetch the configured default once when
   creating the inventory, record the base and semantically integrate newer
   remote work. Recheck only concrete freshness before final publication.
3. Run `npm run shipment:plan -- --json`. Its native actions are `PREPARE`,
   `VALIDATE`, `DELIVER` and `NO_CHANGES`. Clean main with unpublished or
   unvalidated commits is work. Missing checkpoint state supplies no approval.
   With no commits beyond the configured published ref and no outstanding work,
   `NO_CHANGES` creates no approval and stops with zero tests, review, build,
   version increment, deployment, installation or publication.
4. `HEAD == last_validated_commit` skips validation. A verified already-delivered
   candidate is `NO_CHANGES`; a validated undelivered candidate resumes `DELIVER`
   using its existing immutable receipt and release version.

## 2. Prepare

Prepare means direct Git commits. Use Git CLI for Git-only work; create no Git
agent or guardian. Commit every authored file, including earlier authors' work,
independently of review, approval, receipt or Oracle trailers. Keep secret and
source hygiene. Never stash, discard, defer or omit authored work to make status
clean; generated files follow the canonical artifact policy.

For a genuinely new release candidate, choose one package patch increment unless
the user requests another package version. Keep `package.json`, `package-lock.json`,
`plugins/my-crm/.codex-plugin/plugin.json`,
`plugins/my-crm/.claude-plugin/plugin.json` and
`plugins/my-crm/.bos-product.json` consistent, then commit the complete candidate.
Persist the prepared version/commit and reuse them on continuation. A package
version remains distinct from a public API version; preserve the exact explicit
user request requirement for any public API-version change.

Use the normal hooks with `git add -A` and `git commit`. Vault and generated
`dist/` output remain private/ignored. Run `npm run vault:sync` after meaningful
Vault changes. A technical review governs release readiness.

## 3. Validate

Run the entire lifecycle in parallel with the other changed family members.

1. Submit the concise Problem, Cause and Recommended change through
   `npm run oracle:proposal -- "<proposal>"` before implementation, with at most
   three concise sentences per section. A sealed
   in-scope proposal remains supporting history through commits and instruction
   changes; the current independent reviewer reassesses affected criteria.
2. Validate the exact committed range. `npm run oracle:review` accepts clean
   canonical main and reviews the proposal-base-to-current-commit range; staged
   compatibility mode remains available. Make one complete pass per unvalidated
   commit or batched range, covering real entrypoints, dependencies, consumers,
   publication and failure/recovery paths. Return every established finding
   together with stable identities, reproduction and acceptance evidence.
3. Establish the complete integrated `npm test` baseline once. Capture reusable
   execution with `npm run oracle:validate -- -- npm test`; for a focused check,
   repeat `--input <exact-project-file>` for its complete consumed dependency
   closure before `-- <command>`. Capture build and package checks as needed.
   Supply the emitted original `--validation @<record>` to `oracle:review`.
4. Preserve genuine prior review observations and passing source/dependency/
   configuration/environment/output-bound tests. Changed governing instructions
   require fresh assessment of affected criteria and missing coverage. Inspect
   `supporting_coverage` when global eligibility changes; confirm applicability
   and emit current coverage without blanket source rereads or test reruns.
5. Repair the full finding set, commit repairs directly, and validate only new,
   missing or affected committed work and checks. Source work continues during
   review. `INCOMPLETE` and `ERROR` preserve verified checkpoints and continue
   missing assessment. Two failed repair rounds require consolidated synthesis.
6. Only a complete independent `APPROVED` decision atomically advances
   `last_validated_commit`. Its detached receipt binds the exact committed SHA,
   tree and history, including inherited protected effects. Recheck the current
   candidate before the final verdict and automatically assess arrived commits.

## 4. Deploy

Use `last_validated_commit` as the release candidate and approval identity. Build,
publish and install that exact SHA. Reuse valid tests and deterministic build
outputs from step 3; rerun only checks with changed consumed inputs or missing
coverage. Source movement returns only the newly unvalidated work to step 3.

The release instruction authorizes the prepared release and ordinary in-scope
repairs. Proceed without another conversational approval question. Preserve the
independent exact public API-version request gate, specifically protected actual
credential-trust/permission-authority/tenant-isolation/incompatible-contract
runtime effects, authentication boundaries, existing idle/cost settings and new
spending authorization. Broad architecture, public API-contract and authentication
labels alone create no new approval gate. Technical review identifies effects; exact authority is
checked immediately before a protected publication/install mutation.

Publish a `codex/release-v<version>` ref from the validated commit without switching
canonical main. The remote is `https://github.com/cody-marcel-dfsm/mycrm.git`.
Push, open its PR, wait for required checks and merge only the exact validated
source. Use `npm run oracle:deployment -- <exact-ref>` before main/release
promotion and `npm run install:reviewed` for supported native installation.
The pre-push hook and maintainer install wrapper enforce exact receipt/effect
admission. Preserve immutable historical stamped receipts alongside committed
review checkpoints. Ordinary commits and source-review branch publication remain
independent of review readiness.

After actual publication and supported installation verification, record the
separate delivered SHA and artifact digest. The native install wrapper records
this only for the exact validated candidate on published main. An already
validated delivery retry performs only its pending delivery work. A repeated
already-delivered candidate runs zero release actions. Never patch installed
cache files or an existing immutable version.

MyCRM owns only its package/client; use this repository, published public
contracts and authenticated endpoints. Preserve the BOS-owned shared connection
and customer-identity isolation. Create no sibling source/build/runtime imports.

Report the four step durations, exact validated/delivered commits, performed
publication/install lifecycle, validation verdict/evidence and clean synchronized
main. Optional outside verification adds no acceptance gate unless requested.
