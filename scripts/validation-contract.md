# Fixed change validation

The independent proposal chooses the executable contract before implementation.
Its approved selection is written to `scripts/validation-selection.json` and bound
to the original proposal/review hashes, base commit/tree, catalog and Node runtime.
Commit that generated selection with the authored work; do not write a selection
or claim Oracle approval yourself. A later revision names the prior contract hash
and requires a new native proposal. Old contracts, results and failures remain in
native history. Source, catalog, command, fixture or runtime changes require fresh
matching execution or an explicitly approved revision.

| Class | Required execution |
| --- | --- |
| `docs_only` | Minimal whitespace, privacy and architectural-boundary sanity for genuine documentation changes. Executable skills, instructions or source require another class. |
| `bug_fix` | Sanity, the focused reproduction failing before the fix and passing after it, without integration or automatic broader regression. |
| `deep_bug_fix` | The bug-fix checks and every relevant interaction selected by Oracle, including failure and recovery paths. |
| `feature` | Sanity, complete relevant interactions, thorough acceptance; select curated recurrence checks only for an evidenced risk. |

The hard end-to-end limits are `docs_only` 120 seconds, `bug_fix` 180 seconds,
`deep_bug_fix` 300 seconds and `feature` 300 seconds. The build host owns the
original request admission clock, including upload, network, validation, build,
deployment and live verification when applicable; these source-only repositories
finish at verified remote Git publication. Retries, revisions and handoffs retain
`request_started_at` and `deadline_at`; they never start a fresh clock. A late
completion is an SLA failure, never approval or a partial pass. Local category
results are phase results and cannot certify end-to-end completion.

Rank and pare the relevant checks before Oracle freezes the executable contract,
then execute every selected check completely. A small `bug_fix` uses only sanity
and its small deterministic fail-before/pass-after reproduction, with no
integration or automatic broader regression. Authentication, security, cross-area
or uncertain impact requires `deep_bug_fix` and the complete relevant interactions.
The small curated regression registry is opt-in for a demonstrated recurring risk,
not an automatic addition to every change. Feature acceptance remains thorough
within its selected impact. The authenticated platform JEV ranking seam may help
classify and prioritize; it never supplies authorization or replaces Oracle.
Use low reasoning for simple documentation and small bugs, medium for hard/deep
changes and features; medium is the maximum. The native launcher bounds inherited
higher settings. No paid inference fallback is authorized.

The catalog supplies class minima and the small regression registry. Oracle
chooses exact planned test files and supporting fixture paths under `tests/` for focused,
interaction and acceptance categories;
commands do not accept name filters or silently expand to a full system suite.
Unknown impact is classified as deep work before scope is fixed. User input, interface, authentication, authorization,
security and prompt-injection boundaries receive the appropriate full scrutiny.
Preserve independent source, privacy and publication gates.

For a bug, first commit the selected test/fixture and the generated contract while
leaving implementation source at its approved baseline. Capture the original
failure with `node scripts/validation-contract.mjs run --category focused --phase
before`. An assertion failure in a complete nonempty test run is required; a
missing executable, syntax error or timeout is not reproduction. Keep those test
bytes unchanged for the after run; changing the acceptance test requires a new
explicit contract/reproduction.

Run each selected category through `oracle:validate`, for example
`npm run oracle:validate -- -- node scripts/validation-contract.mjs run --category
focused`. The runner executes the exact selected command, captures immutable
source/catalog/runtime/output identities and the hash of the complete actual
functional child environment, without recording environment values. Dispatch-only
values are removed from the child itself; all remaining configuration is bound.
Changing that configuration cannot replace a fail-before reproduction. The runner
uses the same executable whose bytes are bound in the contract and requires complete TAP totals:
positive tests, all passed, zero skipped/todo/cancelled. A zero exit code alone is
insufficient. Complete affected categories must pass on the current tree; later
failures supersede earlier passing attempts. Sanity always checks the full current
candidate. Intact prior passing category records may reach review as pending reuse
candidates when their tests, fixtures, runtime and functional environment match.
They supply no automatic coverage: the independent current cross-cutting reviewer
must trace every consumed dependency and cite both original record and output in
fresh `validation-category-reuse` coverage. The final native verifier checks those
hash-bound originals, mandatory harness/catalog/selection/package/test inputs and
every independently identified source/configuration dependency against both Git
trees. Changed or unavailable dependencies require fresh complete execution.
Unknown closures cannot be qualified. Preserve originals and the original SLA
clock; never copy a prior approval or relabel an old run as a current execution.
Implementation and `release:check` use those same category commands. CI imports
only the existing independently approved, exact-source native command evidence or
executes those same commands; it cannot invent a partial green result. Category
qualification alone is not a launcher-owned native command proof. Publication
still requires the existing exact-source native execution or independently
qualified required-command manifest, including every actual changed dependency
and complete affected repair execution; the category gate does not waive it.

The initial catalog/tooling introduction retains its original approved proposal
and records the explicit `my-crm.validation-contract-introduction/v1` policy epoch.
Its fixed checks are package build, the complete selector/policy/transport/review
parallel-dispatch and native-settings test files, and package release check. This is a new scoped
bootstrap capture, not preimplementation selection and not a passing replacement
for the historical failed whole-suite run. Native transport preserves those
original failures and requires actual passing executions of the new exact commands. Once
the catalog exists in a proposal base, absent selection is a hard error. This
transition is not a permanent fallback for ordinary new work.

The regression registry is a reviewed recurrence set, not an archive of every
feature test. Each entry names the recurring boundary and reason for retention;
adding or removing one changes the catalog identity and requires review. Feature
acceptance remains scoped to the feature and is not automatically promoted into
regression. Local source validation does not prove live-client acceptance.

## Deterministic bootstrap publication

The source-maintenance bootstrap may use `deterministic-publication.mjs` instead
of model review. This narrow path rejects product implementation, workflow and
infrastructure and unrelated maintainer modules, checks every outgoing intermediate commit and admits
package metadata changes only when version fields are the sole difference.
It executes the fixed bootstrap and privacy/boundary/contract checks, retains
immutable original output and failed attempts, and binds the clean commit/tree,
Node binary and installed dependency bytes. Unknown original request clocks are
recorded as unknown and confer no SLA result. The new admission is explicitly
`DETERMINISTIC_SOURCE_MAINTENANCE`, never a fabricated legacy model verdict.

Native publication preparation and pre-push verify original evidence again.
GitHub's existing exact-source required job executes its full native contract
independently; deterministic local evidence does not replace CI. No protected
deployment effects or product behavior changes qualify for this path. A selected
validation contract disables bootstrap admission. Existing native review records,
failures and other publication modes remain intact.
