---
name: ship-it
description: Create the next MyCRM release version, validate and review the complete current worktree, publish it through a release pull request, install the merged plugin, and verify deployment. Use when the user says “ship it,” “send it,” or explicitly asks to release MyCRM.
---

# Ship It

Complete the MyCRM release loop inside
the My CRM repository root.

## Invocation authorization

Within this skill, `$ship-it`, “ship it,” and “send it” are the user's explicit
and final authorization for all of these MyCRM-scoped actions:

- create the next semantic release version and deterministic candidate;
- correct in-scope release defects and obtain MyCRM Oracle approval;
- commit the complete approved Git-visible worktree;
- push the release branch to `https://github.com/cody-marcel-dfsm/mycrm.git`;
- open and merge its pull request into `main` after required checks pass;
- restore a clean, synchronized local `main`;
- install or upgrade the merged plugin through supported Codex controls; and
- execute read-only native acceptance against the installed BOS dependency.

Start immediately and ask no conversational approval questions for those
actions. The authorization is prospective and remains attached to the final
reviewed version, branch, commit, package digest, and in-scope corrections
created by this invocation. Host permission controls may collect their own
approval.

The invocation grants no authority to mutate BOS Service, BOS Operations
Center, provider data, production infrastructure, or another repository. Live
destructive acceptance remains separately authorized for exact isolated
records and effects.

## Product and repository boundary

- MyCRM is an independent external BOS plugin. Use only this repository,
  committed public contracts, official host documentation, and authenticated
  public endpoints.
- Never inspect or depend on sibling private source. Record a missing public
  capability in `Vault/docs/platform-gaps.md`.
- Preserve the one BOS-owned authenticated connection. MyCRM declares no MCP,
  OAuth, token, credential, app, database, or provider binding.
- Never patch an installed plugin cache, personal skill directory, or released
  version in place. Build, publish, and install a new immutable version.
- `Vault/` is private and ignored. Update it when evidence or implementation
  status changes, run `npm run vault:sync`, and never stage, commit, package, or
  publish any Vault file.

## Security gate

If an in-scope correction changes authentication, authorization, OAuth,
grants, tokens, sessions, protected-resource audiences, MCP binding topology,
login recovery, credential behavior, or authority scope, stop before that
implementation and emit the exact red warning required by
`Vault/docs/CONSTITUTION.md`. The ship-it invocation does not replace the
developer owner's direct approval of an exact protected security change.

Before staging or committing any payload that contains the authentication
rollback governed by `MYCRM-AUTH-005`, locate the documented developer-owner
approval of the complete rollback diff. Stop and request that exact approval
when it is absent. The ship-it invocation authorizes the release actions; it
does not supply this protected-change approval.

## Preflight

1. Read `AGENTS.md`, `Vault/docs/CONSTITUTION.md`, relevant Vault designs and
   evidence, `.agents/skills/oracle/SKILL.md`, and the release instructions in
   `README.md`.
2. Resolve the current branch, default branch, upstream, remotes, and complete
   staged, unstaged, untracked, renamed, and deleted status. Require the push
   remote to resolve to `https://github.com/cody-marcel-dfsm/mycrm.git`.
3. Stop on merge, rebase, cherry-pick, conflicts, detached HEAD, ambiguous
   targets, missing credentials, or branch protection that prevents the
   governed workflow. Report the exact evidence and remedy declaratively.
4. Treat every amended repository file as user-owned and in scope. Inspect all
   files and preserve intent. Block credentials, private data, accidental large
   artifacts, material correctness defects, and constitutional violations.
5. Never discard, reset, stash, or overwrite user work. Resolve safe in-scope
   release failures and repeat the affected gates.
6. When the payload includes `MYCRM-AUTH-005`, verify the documented direct
   owner approval covers the complete rollback diff before staging or commit.

## Create the immutable release

1. When on `main`, create `codex/release-v<next-version>` while preserving the
   complete worktree. Reuse a current non-default branch only when its upstream
   and pull-request target are unambiguous.
2. Default to a patch increment unless the user or compatibility policy calls
   for another semantic version.
3. Update the version consistently in `package.json`, `package-lock.json`,
   `plugins/my-crm/.codex-plugin/plugin.json`, and
   `plugins/my-crm/.bos-product.json`.
4. Run `npm run build`. Treat `dist/my-crm` as ignored deterministic output and
   never stage it.

## Validate and review

Run the strongest applicable repository gates, including:

```bash
npm test
npm run release:check
npm run install:verify
git diff --check
```

Use `npm run install:local` only after the versioned candidate is built and the
installed BOS dependency is ready, then run `npm run install:verify`. Before
commit, push, merge, or publication, complete the full supported-host and
coexistence acceptance required by `MYCRM-JNY-702`, `MYCRM-JNY-703`,
`MYCRM-JNY-704`, `MYCRM-AUTH-004`, and `MYCRM-AUTH-005`. This includes:

- `MYCRM_LIVE_ACCEPTANCE=1 npm run test:live` with fresh sanitized evidence
  written through `MYCRM_LIVE_EVIDENCE_OUT`;
- live application discovery, operation-scoped Describe, exact advertised
  deterministic HTTPS invocation, schema validation, provenance, and
  freshness;
- unchanged BOS-only and BOS-plus-Education-Center authentication acceptance;
- BOS-plus-My-CRM and three-product coexistence, including clean install,
  dependency order, restart, session resume, authentication recovery,
  interrupted-request continuation, upgrade, uninstall/reinstall, and a clean
  profile; and
- every other applicable live/native scenario in the canonical acceptance
  matrix.

`HOST_ACTION_REQUIRED`, a timed-out or stalled runner, mock-only evidence, a
zero-assertion inventory check, an incomplete coexistence matrix, or any
unexecuted required scenario is incomplete acceptance and stops the release
before commit and publication. Live destructive fixture scenarios require the
separate explicit authorization defined by the canonical plan; absent that
authorization, preserve the candidate and report the release as blocked.

Submit the complete actual diff and validation evidence to the project-local
Oracle. Require exact findings and a literal `APPROVED` or `REJECTED`. Resolve
every rejection, rerun affected validation, sync the Vault after Vault changes,
and request a fresh complete review. Every mutation after approval invalidates
that approval.

## Commit and publish

1. Stage the complete Oracle-approved Git-visible payload with `git add -A`.
   Confirm no Vault file or ignored build output is staged and no untracked or
   unstaged release input remains.
2. Inspect `git diff --cached --stat` and `git diff --cached --check`. Create one
   concise release commit. Never amend, squash, rebase, force-push, skip hooks,
   or create an empty commit.
3. Push the release branch to `origin` and open a pull request into `main`.
   Include the version, behavior delivered, package digest, Oracle verdict, and
   validation evidence.
4. Wait for every required check. Correct in-scope failures on the same branch,
   repeat validation and Oracle review after mutations, push, and wait again.
5. Merge only when GitHub reports the pull request mergeable and all required
   checks pass. Verify remote `main` contains the release.
6. Switch to `main`, fast-forward from `origin/main`, confirm a clean synchronized
   checkout, verify the release branch is merged, and delete only that local
   release branch with the safe merged-branch command.

## Verify the merged installation

1. Build the merged release again and verify its manifest and content digest.
2. Install or upgrade with `npm run install:local`, then run
   `npm run install:verify`. Never uninstall a working version first and never
   rewrite plugin-cache files.
3. Re-run the installed read-only smoke path against the authenticated BOS
   connection and confirm it matches the pre-publication acceptance evidence.
   Require successful MCP discovery, operation-scoped Describe, exact
   advertised deterministic HTTPS invocation, public response-schema
   assertions, source provenance, and freshness. Server-only and inventory-only
   evidence are insufficient, and this post-merge smoke check never substitutes
   for the complete pre-publication matrix.
4. Confirm the installation retains one BOS-owned connection and creates no
   MyCRM MCP, OAuth, credential, app, or authority binding. Confirm existing BOS
   and Education Center behavior remains unchanged.
5. Treat Git merge, Codex Git-marketplace refresh, local-marketplace install,
   and public ChatGPT/Codex directory publication as distinct lifecycles.
   Report only the lifecycle actually completed.

## Completion report

Report the previous and new versions, pull-request URL and number, release and
merge commits, source/default branches, remote destination, included file count,
package content digest, test/build/install/live-acceptance results, Oracle
verdict, and confirmation that the workspace is clean on synchronized `main`
with the merged local release branch removed. If stopped, report the exact
blocker and preserve all work safely.
