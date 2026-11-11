---
name: my-crm-implementation
description: Implement a My CRM change from canonical main through sync-in, a local Oracle proposal that outputs a sealed oracle-spec/1, implementation against that spec, the selected validation categories, completed-source review, re-sync and native publication.
---

# My CRM implementation

Use this skill for every non-documentation My CRM change. Follow `AGENTS.md`,
`Vault/docs/CONSTITUTION.md` and `scripts/validation-contract.md`. Ordinary
implementers call the Oracle commands; they never load, adopt, quote or
impersonate `.agents/skills/oracle/SKILL.md`. Work only in the canonical checkout
on `main`; create no worktree or pushed side branch.

## 1. Sync in and record the base

```sh
git status --porcelain=v1 --untracked-files=all   # preserve everything listed
git fetch origin main
git merge --ff-only origin/main || git merge --no-edit origin/main
git rev-parse origin/main                          # record as the base
git merge-base --is-ancestor origin/main HEAD      # must succeed
```

Resolve a merge semantically and commit it before continuing. Keep every working
file (request, proposal, notes, outputs) under the Git-ignored
`Vault/tmp/oracle-spec/`, never in system temporary storage.

## 2. Analyze and propose

Read the original request (feedback item), its design, the task and the code.
Write the proposal with **Problem**, **Cause** and **Recommended change**, naming
the planned scope paths, change class and tests. A `feature` names its design
`.md`, and its `<design>.test-plan.json` (`my-crm.feature-test-plan/v1`) sits
beside it bound to the exact design hash. Documentation-only changes need no
spec but still use the `docs_only` contract.

## 3. Obtain the sealed spec from the local Oracle

```sh
npm run oracle:proposal -- "$(cat Vault/tmp/oracle-spec/proposal.md)" \
  [--engine claude|codex|auto] [--request-file Vault/tmp/oracle-spec/request.md]
```

`auto` (the default) selects the current harness: `claude` under Claude Code,
otherwise `codex`. A missing CLI fails; never switch engines or add paid
inference. The command fetches `origin/main` again and refuses when `main` does
not contain it. `REJECTED` returns all findings: repair the proposal (or design
and plan) as one set and resubmit. `APPROVED` writes
`scripts/validation-selection.json`: the validation contract whose `spec` member
is the stamped, sealed `oracle-spec/1` (scope, acceptance criteria and the tests
that must pass). Never write or edit that file yourself. Check it:

```sh
node scripts/oracle-spec.mjs verify
```

## 4. Build and commit

Implement exactly the spec's scope. Commit each unit of work, including the
contract file, with the trailer `Co-Authored-By: <agent identity>`. A scope,
class or test change requires a revision proposal (the Oracle sets
`revision_of` to the current `contract_sha256`).

## 5. Pass the spec's tests

Run every selected category on the clean committed candidate:

```sh
npm run oracle:validate -- -- node scripts/validation-contract.mjs run --category sanity
npm run oracle:validate -- -- node scripts/validation-contract.mjs run --category <each selected category>
```

A bug fix first commits its focused test and contract and records
`--phase before`. Every run must be complete, nonempty and fully passing.

## 6. Re-sync before publication

```sh
git fetch origin main
git rev-parse origin/main          # compare with the recorded base
git merge-base --is-ancestor origin/main HEAD
```

When `origin/main` moved, integrate it, rerun the affected categories, and obtain
a revision proposal so the spec's base is the new fetched commit.

## 7. Completed-source review and publication

Completed-source review is unchanged: `npm run oracle:review` (supplying the
captured `--validation @<record>` references) must return `APPROVED` for the exact
committed candidate. Then follow the `ship-it` skill's native publication:

```sh
npm run publication:prepare -- "$(git rev-parse HEAD)" origin refs/heads/main "$(git rev-parse origin/main)"
npm run publication:publish -- --prepared <absolute-record>
```

CI (`npm run release:check`) fails immediately when a non-documentation change
lacks its sealed spec or the seal does not recompute, then runs the spec's tests.
If publication needs something you cannot do, stop at the last verified step and
state exactly what is needed.
