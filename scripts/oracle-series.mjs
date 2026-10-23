import {randomUUID} from "node:crypto";
import {readFile, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {atomicJson, bindingHash, contentHash, observedSourceBindings, pathCustody, readMetadataFile, writeMetadataFile, assertCurrentInvocation, metadataDirectory, evidenceBinding} from "./oracle-inputs.mjs";
import {legacyPolicy} from "./oracle-policy.mjs";
import {nativeCohortObservations} from "./oracle-parallel.mjs";

// Private maintainer state. It carries evidence; approval still requires a fresh
// independent decision for the complete, exact candidate.
export const seriesDigest = ({sha256: _ignored, ...record}) => bindingHash(record);
export function verifySeries(record, base) {
  if (record.schema !== "my-crm.oracle-series/v1" || record.base_commit !== base ||
      !Array.isArray(record.rounds) || record.sha256 !== seriesDigest(record)) throw new Error("Oracle review-series history is malformed or changed");
  for (const [index, round] of record.rounds.entries()) {
    if (round.round !== index + 1 || !["COMPLETE", "INCOMPLETE"].includes(round.review_status) ||
        !round.snapshot?.files || !Array.isArray(round.coverage) || !Array.isArray(round.validations) || !Array.isArray(round.findings)) throw new Error("Oracle review-series round is malformed");
    for (const item of [...round.coverage, ...round.validations]) {
      dependenciesOf(item, round.snapshot, item.path ?? null);
      if (item.input_sha256 !== (item.binding_kind === "declared-command-inputs-v1" ? commandWitness(round.snapshot, item.dependencies, item.execution_environment_sha256) : item.binding_kind === "execution-inputs-v2" ? executionWitness(round.snapshot, item.dependencies, item.execution_environment_sha256) : witness(round.snapshot, item.dependencies))) throw new Error("Oracle review-series dependency witness is malformed or changed");
    }
    if (round.observed_assessment) {
      const observed = round.observed_assessment;
      if (!round.error || round.verdict !== null || round.review_status !== "INCOMPLETE" || !observed.response_evidence?.value ||
          observed.response_sha256 !== bindingHash(observed.response) || !Array.isArray(observed.coverage) || !Array.isArray(observed.validations) || !Array.isArray(observed.findings)) throw new Error("Oracle raw assessment custody is malformed or changed");
      for (const item of observed.coverage) {
        dependenciesOf(item, round.snapshot, item.path);
        if (item.input_sha256 !== witness(round.snapshot, item.dependencies)) throw new Error("Oracle raw assessment dependency witness changed");
      }
    }
  }
  return record;
}

async function augmentedSeries(directory, base, series) {
  const location = path.join(directory, "series", "supporting-assessments", base);
  let names;
  try { await metadataDirectory(path.dirname(directory), location, {create: false}); names = await readdir(location); } catch (error) { if (error.code === "ENOENT") return series; throw error; }
  const rounds = [...series.rounds];
  const identity = (round) => bindingHash({snapshot: round.snapshot, original: round.observed_assessment?.response_evidence});
  const seen = new Set(rounds.filter((round) => round.observed_assessment).map(identity));
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("Supporting assessment archive name is malformed");
    const filename = path.join(location, name), bytes = await readMetadataFile(filename, "utf8", {root: path.dirname(directory)});
    const archive = JSON.parse(bytes), {sha256, ...body} = archive;
    if (archive.schema !== "my-crm.oracle-supporting-assessment/v1" || sha256 !== bindingHash(body) || name !== `${sha256}.json`) throw new Error("Supporting assessment archive is malformed or changed");
    const original = verifySeries(archive.series, base).rounds[0];
    if (!original.observed_assessment || original.execution_status !== "ERROR" || original.verdict !== null) throw new Error("Supporting archive supplies no native approval");
    const key = identity(original); if (seen.has(key)) continue;
    rounds.push({...original, round: rounds.length + 1, supporting_origin: {path: filename, sha256: contentHash(bytes), original_round: archive.original_round}});
    seen.add(key);
  }
  const value = {...series, rounds}; value.sha256 = seriesDigest(value); return value;
}

function witness(snapshot, dependencies) {
  return bindingHash({context: snapshot.context, files: Object.fromEntries(dependencies.map((name) => [name, snapshot.files[name] ?? null])),
    ...(snapshot.file_facts ? {file_facts: Object.fromEntries(dependencies.map((name) => [name, snapshot.file_facts[name] ?? null]))} : {})});
}

function samePathIdentity(before, after, name) {
  return (before.files[name] ?? null) === (after.files[name] ?? null) && bindingHash(before.file_facts?.[name] ?? null) === bindingHash(after.file_facts?.[name] ?? null);
}

function changedDependencies(before, after, names) { return names.filter((name) => !samePathIdentity(before, after, name)); }

function sourceIdentity(snapshot, name) {
  const facts = snapshot?.file_facts?.[name] ?? null;
  return {known: Boolean(snapshot && Object.hasOwn(snapshot.files, name)), content: snapshot?.files[name] ?? null,
    facts_sha256: facts ? bindingHash(facts) : null, custody_sha256: facts?.custody ? bindingHash(facts.custody) : null,
    mode: facts?.mode ?? null, type: facts?.type ?? null};
}

function navigationObservation(item, original, current, origin) {
  const names = [...new Set([item.path, ...item.dependencies ?? []])];
  return {...item, origin, coverage_eligibility: "NONE", independent_applicability_required: true,
    original_snapshot_available: Boolean(original),
    dependency_comparisons: names.map(name => ({path: name, original: sourceIdentity(original, name), current: sourceIdentity(current, name),
      equal: Boolean(original && samePathIdentity(original, current, name))})),
    context_comparison: {original_sha256: bindingHash(original?.context ?? null), current_sha256: bindingHash(current.context),
      changed_fields: [...new Set([...Object.keys(original?.context ?? {}), ...Object.keys(current.context)])]
        .filter(name => bindingHash(original?.context[name] ?? null) !== bindingHash(current.context[name] ?? null))}};
}

function cohortDiagnostic(value) {
  return /^Cohort [A-Za-z0-9_-]+ (?:omitted required coverage:|has unfinished assessment$|execution failed:|bound inputs changed during assessment$|candidate or plan binding differs$|omitted cross-area integration assessment$|has no formal assessment$|completed without a verdict$)/.test(value);
}

export async function observationSourcePaths({directory, base, series = null, withBindingState = false, additionalFindings = []}) {
  if (!series) {
    try { series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${base}.json`), "utf8", {root: path.dirname(directory)})), base); }
    catch (error) { if (error.code !== "ENOENT") throw error; series = {schema: "my-crm.oracle-series/v1", base_commit: base, series_id: "supporting-only", rounds: []}; }
    series = await augmentedSeries(directory, base, series);
  }
  const findings = new Map(), external = new Set(), known = new Set(), names = new Set();
  for (const round of series.rounds) {
    for (const name of round.snapshot.external_paths ?? []) external.add(name);
    for (const name of Object.keys(round.snapshot.files)) known.add(name);
    for (const name of round.snapshot.observed_source_paths ?? []) names.add(name);
    for (const finding of [...round.observed_assessment?.findings ?? [], ...round.observed_cohorts?.flatMap(item => item.findings) ?? [], ...round.findings]) findings.set(finding.id, finding);
    for (const resolution of round.response?.resolutions ?? []) if (resolution.status === "RESOLVED") findings.delete(resolution.id);
  }
  for (const finding of additionalFindings) findings.set(finding.id, finding);
  for (const finding of findings.values()) for (const name of [finding.path, ...finding.affected_paths]) if (name) names.add(name);
  const previous = series.rounds.at(-1);
  for (const name of previous?.unreviewed ?? previous?.response?.unreviewed ?? []) {
    if (cohortDiagnostic(name)) {
      // Recover concrete known paths from older reducer diagnostics. Current
      // reducers also retain each missing path independently of their prose.
      const missing = name.match(/^Cohort [A-Za-z0-9_-]+ omitted required coverage: (.+)$/);
      for (const item of missing?.[1].split(", ") ?? []) if (known.has(item)) names.add(item);
      continue;
    }
    // Unfinished scope can also contain prose. Existing names and explicit file
    // syntax participate in source closure; semantic labels remain unfinished.
    if (known.has(name) || name.includes("/") || /\.[A-Za-z0-9_-]+$/.test(name)) names.add(name);
  }
  const paths = [...names].filter((name) => !external.has(name) && !cohortDiagnostic(name)).sort();
  return withBindingState ? {paths, established: paths.filter((name) => known.has(name))} : paths;
}

export async function inheritObservedEvidence({directory, base, requestedEvidence = [], root = directory, cohortAudit}) {
  let series;
  try { series = verifySeries(JSON.parse(await readMetadataFile(path.join(directory, "series", `${base}.json`), "utf8", {root: path.dirname(directory)})), base); }
  catch (error) { if (error.code !== "ENOENT") throw error; series = {schema: "my-crm.oracle-series/v1", base_commit: base, series_id: "supporting-only", rounds: []}; }
  series = await augmentedSeries(directory, base, series);
  const runs = path.join(await realpath(directory), "runs"), present = new Set(requestedEvidence);
  const evidence = [], invalidated = [];
  for (const round of series.rounds) for (const [kind, original] of [["response", round.observed_assessment?.response_evidence], ["process", round.observed_assessment?.execution_evidence]]) {
    if (!original) continue;
    try {
      const custody = await pathCustody(root, original.value.replace(/^@/, ""), {scopeRoot: runs, allowFinalLink: false});
      const filename = custody.resolved_path;
      if (!filename.startsWith(`${runs}${path.sep}`) || path.basename(filename) !== `${kind}.json` || contentHash(await readMetadataFile(filename, {}, {root: path.dirname(directory)})) !== original.sha256) throw new Error(`original raw ${kind} location or content changed`);
      if (!present.has(original.value)) { evidence.push(original.value); present.add(original.value); }
    } catch (error) {
      invalidated.push({kind: "observed-assessment", id: `round-${round.round}`, evidence_kind: kind, reason: error.code === "ENOENT" ? `original raw ${kind} is missing` : error.message});
    }
  }
  const retained = [...new Map(series.rounds.flatMap(round => round.observed_cohorts ?? []).map(item => [item.id, item])).values()];
  const reports = series.rounds.flatMap(round => round.native_cohort_reports ?? []);
  const requestedBindings = await Promise.all(requestedEvidence.filter(value => /^runs\/[a-f0-9-]{36}\/cohorts\/(?:cross-cutting|implementation-consumers|verification-recovery)\/response\.json$/.test(path.relative(directory, path.resolve(root, value.replace(/^@/, ""))))).map(value => evidenceBinding(root, value)));
  const cohorts = await nativeCohortObservations({root, directory, validation: [...requestedBindings, ...reports], retained, base, seriesId: series.series_id === "supporting-only" ? null : series.series_id, audit: cohortAudit});
  for (const cohort of cohorts) for (const binding of cohort.native_bindings) if (!present.has(binding.value)) { evidence.push(binding.value); present.add(binding.value); }
  return {evidence, invalidated, cohorts};
}

function executionContext(snapshot, environment) { const {owner: _authorization, ...context} = snapshot.context; return environment ? {...context, environment} : context; }
function executionWitness(snapshot, dependencies, environment) {
  return witness({...snapshot, context: executionContext(snapshot, environment)}, dependencies);
}
function commandWitness(snapshot, dependencies, environment) {
  return bindingHash({environment: environment ?? snapshot.context.environment, files: Object.fromEntries(dependencies.map((name) => [name, snapshot.files[name] ?? null]))});
}
function bindExecution(item, snapshot, environment = item.execution_environment_sha256 ?? snapshot.context.environment) {
  dependenciesOf(item, snapshot);
  if (snapshot.scope === "declared-inputs-v2" || item.binding_kind === "declared-command-inputs-v1") {
    return {...item, execution_environment_sha256: environment, binding_kind: "declared-command-inputs-v1", input_sha256: commandWitness(snapshot, item.dependencies, environment)};
  }
  return {...item, execution_environment_sha256: environment, binding_kind: "execution-inputs-v2", input_sha256: executionWitness(snapshot, item.dependencies, environment)};
}

function validationScopeReason(proof, snapshot) {
  if (!proof?.eligible) return proof?.reason ?? "original native execution proof is unavailable";
  const original = proof.record.before;
  const declared = original.scope === "declared-inputs-v2";
  const scoped = declared || original.scope === "declared-inputs-v1";
  if (!declared && original.base_commit !== snapshot.base_commit) return "recorded validation base changed";
  if (!scoped && original.tree !== snapshot.tree) return "recorded full-candidate validation tree changed";
  const environment = proof.current_provenance?.environment ?? snapshot.context.environment;
  const sameContext = declared ? original.context.environment === environment : bindingHash(executionContext(original)) === bindingHash(executionContext(snapshot, environment));
  if (!sameContext) return declared ? "recorded command environment changed" : "recorded conservative validation context changed";
  const paths = scoped ? Object.keys(original.files) : [...new Set([...Object.keys(original.files), ...Object.keys(snapshot.files)])];
  const changed = paths.filter((name) => (original.files[name] ?? null) !== (snapshot.files[name] ?? null));
  return changed.length ? `recorded validation input facts changed: ${changed.join(", ")}` : null;
}

export function retainedObservations(series, kind) {
  const latest = new Map();
  for (const round of series.rounds) {
    for (const item of round[kind] ?? []) latest.set(kind === "coverage" ? item.path : item.id, {item, round});
    // Explicitly unfinished semantic path assessment supersedes earlier source
    // coverage. An ERROR or omitted observation alone never erases its origin.
    if (kind === "coverage" && round.response) for (const name of round.response.unreviewed ?? []) latest.delete(name);
    if (kind === "coverage") for (const name of round.observed_assessment?.response.unreviewed ?? []) latest.delete(name);
  }
  return [...latest.values()];
}

function priorAssessment(series, filename, snapshot) {
  const round = series.rounds.findLast((item) => item.response?.summary?.trim() && !item.error && (item.response.coverage?.length || item.response.reused_coverage?.length || item.response.findings?.length));
  if (!round) return null;
  const classifications = Object.fromEntries(["authentication_impact", "owner_approval_status", "api_version_assessment"].filter((name) => Object.hasOwn(round.response, name)).map((name) => [name, round.response[name]]));
  return {origin: {path: filename, series_sha256_at_preparation: series.sha256, round_sha256: bindingHash(round)}, round: round.round, review_status: round.review_status,
    snapshot: {sha256: bindingHash(round.snapshot), tree: round.snapshot.tree, base_commit: round.snapshot.base_commit}, guard: {sha256: bindingHash(round.snapshot.context)},
    candidate_equal: round.snapshot.tree === snapshot.tree && round.snapshot.base_commit === snapshot.base_commit,
    snapshot_equal: bindingHash(round.snapshot) === bindingHash(snapshot), guard_equal: bindingHash(round.snapshot.context) === bindingHash(snapshot.context),
    classifications, classifications_available: Object.keys(classifications).length > 0};
}

function dependenciesOf(item, snapshot, requiredPath = null) {
  if (!Array.isArray(item.dependencies) || !item.dependencies.length || new Set(item.dependencies).size !== item.dependencies.length ||
      item.dependencies.some((name) => typeof name !== "string" || !name || (path.isAbsolute(name) && !snapshot.external_paths?.includes(name)) || name.split("/").includes("..")) ||
      !item.dependency_rationale?.trim() || (requiredPath && !item.dependencies.includes(requiredPath))) throw new Error("Oracle coverage/evidence requires explicit complete dependency paths and rationale");
  for (const name of item.dependencies) {
    if (!Object.hasOwn(snapshot.files, name)) throw new Error(`Oracle dependency is absent from the candidate and authority manifest: ${name}`);
  }
  return item.dependencies;
}

function bindItem(item, snapshot, requiredPath = null) {
  // The response schema names the independently reviewed source in `path`.
  // Bind that explicit self edge natively; every reviewer-declared semantic
  // dependency and its rationale still passes the original strict validator.
  const declared = dependenciesOf(item, snapshot);
  const dependencies = requiredPath ? [...new Set([requiredPath, ...declared])] : declared;
  dependenciesOf({...item, dependencies}, snapshot, requiredPath);
  if (requiredPath && (!Array.isArray(item.criteria) || !item.criteria.length || !Array.isArray(item.evidence) || !item.evidence.length ||
      !Array.isArray(item.finding_ids) || [...item.criteria, ...item.evidence, ...item.finding_ids].some((value) => typeof value !== "string" || !value.trim()) ||
      new Set(item.finding_ids).size !== item.finding_ids.length)) throw new Error("Oracle fresh coverage requires explicit criteria, result evidence and finding identities");
  return {...item, dependencies, input_sha256: witness(snapshot, dependencies)};
}

export function reviewSnapshot({candidate, inputs, files, fileFacts = null, environment}) {
  const controllingPolicies = new Set(["AGENTS.md", "Vault/docs/CONSTITUTION.md", ".agents/skills/oracle/SKILL.md"]);
  // Exact receipt inputs retain every canonical authority. Reusable observations
  // bind global controlling policy here and their particular design/status
  // authorities through the complete per-path dependency map below.
  const policy = inputs.reviewer_policy_sha256 ? {reviewer_policy_sha256: inputs.reviewer_policy_sha256, reviewer_policy_version: inputs.reviewer_policy_version ?? null} : {tool_sha256: inputs.tool_sha256};
  const context = {authorities: inputs.authorities.filter((item) => controllingPolicies.has(item.path) || item.external && item.controlling), ...policy, owner: inputs.owner, environment};
  const snapshot = {tree: candidate.tree, base_commit: candidate.base, tool_binding_sha256: inputs.tool_sha256, tool_source_files: inputs.tool_source_files ?? null, files: {...files}, context, proposal_sha256: inputs.proposal_sha256};
  snapshot.external_paths = inputs.authorities.filter((item) => item.external).map((item) => item.path).sort();
  for (const name of candidate.files) snapshot.files[name] ??= null;
  for (const authority of inputs.authorities) snapshot.files[authority.path] = authority.sha256;
  if (fileFacts) snapshot.file_facts = Object.fromEntries(Object.keys(snapshot.files).map((name) => [name, fileFacts[name] ?? null]));
  for (const authority of inputs.authorities) if (authority.custody) {
    snapshot.file_facts ??= {};
    snapshot.file_facts[authority.path] = {...snapshot.file_facts[authority.path] ?? {}, custody: authority.custody};
  }
  return snapshot;
}

export async function prepareSeries({directory, candidate, inputs, files, fileFacts = null, environment, environmentProvenance = null, validationProofs = [], proposalRecord = null, inheritedInvalidations = [], cohortAssessments = null, root = process.cwd()}) {
  const filename = path.join(directory, "series", `${candidate.base}.json`);
  let series;
  try { series = verifySeries(JSON.parse(await readMetadataFile(filename, "utf8", {root: path.dirname(directory)})), candidate.base); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // An immutable round survives interruption before its mutable head update.
  // Replay only its exact verified predecessor; this grants no active approval.
  for (;;) {
    const journal = path.join(path.dirname(filename), "rounds", candidate.base, `${(series?.rounds.length ?? 0) + 1}.json`);
    let entry;
    try { entry = JSON.parse(await readMetadataFile(journal, "utf8", {root: path.dirname(directory)})); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
    const next = verifySeries(entry.series, candidate.base);
    if (entry.previous_sha256 !== (series?.sha256 ?? null) || next.rounds.length !== (series?.rounds.length ?? 0) + 1 || series && (next.series_id !== series.series_id || bindingHash(next.rounds.slice(0, -1)) !== bindingHash(series.rounds))) throw new Error("Immutable review round does not extend its exact predecessor");
    series = next;
    await assertCurrentInvocation();
    await atomicJson(filename, series, {root: path.dirname(directory)});
  }
  series ??= {schema: "my-crm.oracle-series/v1", series_id: randomUUID(), base_commit: candidate.base, rounds: []};
  const augmented = await augmentedSeries(directory, candidate.base, series);
  for (const round of augmented.rounds.slice(series.rounds.length)) {
    const next = {...series, rounds: [...series.rounds, round]}; next.sha256 = seriesDigest(next);
    const journal = path.join(path.dirname(filename), "rounds", candidate.base, `${round.round}.json`);
    await assertCurrentInvocation();
    await writeMetadataFile(journal, `${JSON.stringify({previous_sha256: series.sha256 ?? null, series: next}, null, 2)}\n`, {flag: "wx"}, {root: path.dirname(directory)});
    await assertCurrentInvocation();
    await atomicJson(filename, next, {root: path.dirname(directory)});
    series = next;
  }

  const previous = series.rounds.at(-1) ?? null;
  cohortAssessments ??= await nativeCohortObservations({root, directory, validation: [...inputs.validation, ...series.rounds.flatMap(round => round.native_cohort_reports ?? [])],
    retained: [...new Map(series.rounds.flatMap(round => round.observed_cohorts ?? []).map(item => [item.id, item])).values()], base: candidate.base, seriesId: series.series_id});
  // Proposal records may change during an in-scope repair. Preserve series
  // continuity and show scope changes explicitly for independent reassessment.
  const snapshot = reviewSnapshot({candidate, inputs, files, fileFacts, environment});
  if (environmentProvenance) snapshot.environment_provenance_sha256 = environmentProvenance;
  const {paths: observedPaths, established} = await observationSourcePaths({series, withBindingState: true});
  const observedSources = inputs.observed_sources ?? await observedSourceBindings(root, observedPaths, {allowUnavailable: observedPaths.filter((name) => !established.includes(name))});
  const unavailableSources = observedSources.filter((item) => item.availability === "UNAVAILABLE");
  if (observedSources.length) {
    snapshot.observed_source_paths = observedSources.map((item) => item.path);
    for (const item of observedSources) if (item.availability !== "UNAVAILABLE" && !Object.hasOwn(snapshot.files, item.path)) {
      snapshot.files[item.path] = item.sha256;
      snapshot.file_facts ??= {};
      snapshot.file_facts[item.path] = {metadata: item.metadata, ancestors: item.ancestors};
    }
  }
  const {context} = snapshot;
  let equivalence = null, comparablePrevious = previous?.snapshot.context;
  if (previous && context.reviewer_policy_sha256 && (!comparablePrevious.reviewer_policy_sha256 || comparablePrevious.reviewer_policy_version !== context.reviewer_policy_version)) {
    equivalence = await legacyPolicy(previous.snapshot, root);
    const {tool_sha256: _ignored, reviewer_policy_version: _oldVersion, ...rest} = comparablePrevious;
    comparablePrevious = {...rest, reviewer_policy_sha256: equivalence.sha256, reviewer_policy_version: context.reviewer_policy_version};
  }
  // A removed declaration remains an allowlisted absence even if an interrupted
  // prior assessment had not yet produced coverage for that external authority.
  for (const name of previous?.snapshot.external_paths ?? []) {
    snapshot.files[name] ??= null;
    if (!snapshot.external_paths.includes(name)) snapshot.external_paths.push(name);
  }
  // A retained witness can legitimately depend on a proven absent path. Keep
  // its null tombstone as long as coverage or validation still references it.
  for (const {item, round: origin} of [...retainedObservations(series, "coverage"), ...retainedObservations(series, "validations")]) {
    for (const name of item.dependencies) if (!Object.hasOwn(snapshot.files, name)) {
      snapshot.files[name] = null;
      if (origin.snapshot.external_paths?.includes(name) && !snapshot.external_paths.includes(name)) snapshot.external_paths.push(name);
    }
  }
  const changed = previous ? changedDependencies(previous.snapshot, snapshot, [...new Set([...Object.keys(previous.snapshot.files), ...Object.keys(snapshot.files)])]).sort() : [...candidate.files];
  for (const name of changed) snapshot.files[name] ??= null;
  const invalidated = [...inheritedInvalidations];
  const unfinishedScope = previous?.unreviewed ?? previous?.response?.unreviewed ?? [];
  for (const name of unfinishedScope) if (series.rounds.some((round) => round.observed_assessment?.response.unreviewed.includes(name))) {
    invalidated.push({kind: "coverage", id: name, reason: "a retained raw attempt reported unfinished scope; fresh independent path and criterion assessment is required"});
  }
  const sourceContexts = new Map(), recovered = [];
  const comparable = async (origin) => {
    if (sourceContexts.has(origin.round)) return sourceContexts.get(origin.round);
    let original = origin.snapshot.context, policyProof = null;
    if (context.reviewer_policy_sha256 && (!original.reviewer_policy_sha256 || original.reviewer_policy_version !== context.reviewer_policy_version)) {
      policyProof = origin === previous && equivalence ? equivalence : await legacyPolicy(origin.snapshot, root);
      const {tool_sha256: _tool, reviewer_policy_version: _version, ...rest} = original;
      original = {...rest, reviewer_policy_sha256: policyProof.sha256, reviewer_policy_version: context.reviewer_policy_version};
    }
    const result = {context: original, policyProof}; sourceContexts.set(origin.round, result); return result;
  };
  const eligibleCoverage = [];
  for (const {item, round: origin} of retainedObservations(series, "coverage")) {
    const original = await comparable(origin), sourceContext = {...original.context};
    const additiveOwner = sourceContext.owner == null && context.owner != null;
    if (additiveOwner) sourceContext.owner = context.owner;
    const changedInputs = changedDependencies(origin.snapshot, snapshot, item.dependencies);
    const changedContext = [...new Set([...Object.keys(sourceContext), ...Object.keys(context)])].filter((name) => bindingHash(sourceContext[name] ?? null) !== bindingHash(context[name] ?? null));
    const valid = !changedContext.length && !changedInputs.length;
    if (!valid) invalidated.push({kind: "coverage", id: item.path, changed_dependencies: changedInputs, changed_context: changedContext,
      reason: original.policyProof && !original.policyProof.sha256 ? "effective reviewer policy provenance is unavailable; coverage requires reassessment" : changedContext.length ? `review context changed: ${changedContext.join(", ")}` : `a declared input or dependency changed (content, mode or type): ${changedInputs.join(", ")}`});
    else {
      eligibleCoverage.push({...item, input_sha256: witness(snapshot, item.dependencies)});
      if (origin !== previous || additiveOwner) recovered.push({path: item.path, from_round: origin.round, original_tree: origin.snapshot.tree, additive_owner_evidence: additiveOwner, policy_provenance: original.policyProof});
    }
  }
  const eligibleValidation = [];
  for (const {item, round: origin} of retainedObservations(series, "validations")) {
    const evidence = inputs.validation.find((entry) => entry.kind === "file" && entry.value === item.evidence && entry.sha256 === item.evidence_sha256);
    const nativeProof = validationProofs.find((entry) => entry.evidence === item.evidence && entry.record.record_sha256 === item.execution_record_sha256);
    const proof = nativeProof?.eligible ? nativeProof : null;
    const witnessFor = item.binding_kind === "declared-command-inputs-v1" ? commandWitness : executionWitness;
    const scopeReason = validationScopeReason(proof, snapshot);
    const valid = Boolean(evidence && proof) && !scopeReason && witnessFor(origin.snapshot, item.dependencies, item.execution_environment_sha256) === witnessFor(snapshot, item.dependencies, proof?.current_provenance?.environment);
    if (!valid && !invalidated.some((entry) => entry.kind === "validation" && entry.id === item.id)) invalidated.push({kind: "validation", id: item.id, reason: !evidence ? "hash-bound validation evidence changed or was not supplied" : nativeProof?.reason ?? scopeReason ?? "declared inputs (source/configuration/dependencies), controlling policy, or environment changed"});
    if (valid) eligibleValidation.push(bindExecution(item, snapshot, proof.current_provenance?.environment ?? proof.record.before.context.environment));
  }
  // Selected captures can prove an absent optional configuration file. Retain
  // that null identity in this exact round so its automatically kept witness
  // remains structurally verifiable on the next follow-up.
  for (const proof of validationProofs) if (proof.eligible && ["declared-inputs-v1", "declared-inputs-v2"].includes(proof.record.before.scope)) {
    for (const [name, value] of Object.entries(proof.record.before.files)) {
      if (value === null && !Object.hasOwn(snapshot.files, name) && !path.isAbsolute(name) && !name.split("/").includes("..")) snapshot.files[name] = null;
    }
  }
  const preverifiedValidations = validationProofs.flatMap((proof) => {
    const original = proof.record.before;
    const declared = original.scope === "declared-inputs-v2";
    if (validationScopeReason(proof, snapshot)) return [];
    const prior = eligibleValidation.find((item) => item.evidence === proof.evidence);
    if (prior) return [prior];
    const evidence = inputs.validation.find((item) => item.kind === "file" && item.value === proof.evidence);
    const observation = {id: `native-${proof.record.record_sha256}`, evidence: proof.evidence, command: JSON.stringify(proof.record.command),
      dependencies: Object.keys(original.files).sort(), dependency_rationale: declared ? "Launcher verified every declared command source/configuration dependency, live/index membership fact, environment, executable and original result. Unselected review authority, policy, owner, proposal and Git base remain separate provenance; exact current candidate approval is independent." : "Launcher verified every originally captured source/configuration/authority dependency against the current candidate, with identical controlling policy, owner and execution-environment bindings. Full-candidate captures retain their complete original dependency set.",
      assessment: "Original command passed with unchanged before/after inputs; original executable and retained output hashes verified."};
    return [{...bindExecution(observation, original), evidence_sha256: evidence.sha256, execution_record_sha256: proof.record.record_sha256}];
  });
  let initialAssessmentComplete = false, repairRejections = 0, initialRejectionSeen = false;
  for (const round of series.rounds) {
    if (round.review_status !== "COMPLETE") continue;
    if (round.verdict === "APPROVED") { repairRejections = 0; initialRejectionSeen = false; }
    else if (round.verdict === "REJECTED") { if (initialRejectionSeen) repairRejections += 1; initialRejectionSeen = true; }
    initialAssessmentComplete = true;
  }
  const pendingChanged = [...new Set([...changed, ...(previous?.review_status === "INCOMPLETE" ? previous.pending_changed_paths ?? previous.changed_since_previous : [])])].sort();
  const requiredPaths = [...new Set([...candidate.files, ...pendingChanged, ...observedPaths.filter((name) => !unavailableSources.some((item) => item.path === name)), ...unfinishedScope.filter((name) => Object.hasOwn(snapshot.files, name)), ...(!previous ? snapshot.external_paths.filter((name) => snapshot.files[name] !== null) : [])])].filter(name => !cohortDiagnostic(name)).sort();
  const observedAssessments = [...cohortAssessments, ...series.rounds.flatMap((round) => {
    const observed = round.observed_assessment;
    if (!observed) return [];
    const evidence = inputs.validation.find((entry) => entry.kind === "file" && entry.value === observed.response_evidence.value && entry.sha256 === observed.response_evidence.sha256);
    const executionEvidence = observed.execution_evidence;
    const executionBound = executionEvidence && inputs.validation.some((entry) => entry.kind === "file" && entry.value === executionEvidence.value && entry.sha256 === executionEvidence.sha256);
    return [{id: `round-${round.round}`, round: round.round, execution_status: "ERROR", source_verdict: null,
      reported_review_status: observed.response.review_status, reported_verdict: observed.response.verdict,
      observed_tree: round.snapshot.tree, observed_snapshot_sha256: bindingHash(round.snapshot), round_sha256: bindingHash(round),
      changed_context: [...new Set([...Object.keys(round.snapshot.context), ...Object.keys(context)])].filter((name) => bindingHash(round.snapshot.context[name] ?? null) !== bindingHash(context[name] ?? null)),
      proposal_criteria_changed: round.snapshot.proposal_sha256 !== snapshot.proposal_sha256,
      response_evidence: observed.response_evidence, original_response_sha256: observed.response_sha256, custody_intact: Boolean(evidence && (!executionEvidence || executionBound)),
      execution: observed.execution ?? null, execution_evidence: executionEvidence ?? null, execution_custody_intact: Boolean(executionBound),
      coverage: observed.coverage.map((item) => ({...item, changed_dependencies: changedDependencies(round.snapshot, snapshot, item.dependencies)})),
      findings: observed.findings, unreviewed: observed.response.unreviewed,
      applicability: "Supporting observations only. Independently re-attest current path/dependency/criteria/evidence applicability; no automatic coverage, native witness or approval promotion."}];
  })];
  const supportingCoverage = retainedObservations(series, "coverage").filter(({item}) => !eligibleCoverage.some((entry) => entry.path === item.path)).map(({item, round}) => ({
    id: `coverage-${round.round}-${item.path}`, origin: {history_file: filename, round: round.round, round_sha256: bindingHash(round), original_tree: round.snapshot.tree},
    ...item, coverage_eligibility: "NONE", independent_applicability_required: true,
    changed_dependencies: changedDependencies(round.snapshot, snapshot, item.dependencies),
    changed_context: [...new Set([...Object.keys(round.snapshot.context), ...Object.keys(context)])].filter((name) => bindingHash(round.snapshot.context[name] ?? null) !== bindingHash(context[name] ?? null)),
    applicability: "Sealed supporting assessment only. Confirm current governing instructions first, assess affected criteria and missing dependencies, then emit fresh coverage. This observation supplies no approval or native execution eligibility."
  }));
  // Complete producer-shaped navigation is separate from eligible coverage.
  // Native ERROR reports retain only supporting observations; comparison never
  // supplies an assessment, historical source presence or current approval.
  const navigationCoverage = retainedObservations(series, "coverage").map(({item, round}) => navigationObservation(item, round.snapshot, snapshot,
    {kind: "SEALED_SERIES_OBSERVATION", round: round.round, round_sha256: bindingHash(round), history_file: filename,
      original_tree: round.snapshot.tree, original_status: round.execution_status}));
  for (const [index, observed] of observedAssessments.entries()) {
    const original = series.rounds.find(round => round.round === observed.round && round.snapshot.tree === observed.observed_tree)?.snapshot ?? null;
    for (const [number, item] of (observed.reported_coverage ?? observed.coverage ?? []).entries()) navigationCoverage.push(navigationObservation(item, original, snapshot,
      {kind: "RAW_ERROR_OBSERVATION", round: observed.round, observation_id: observed.id, original_tree: observed.observed_tree,
        original_status: observed.execution_status, reported_status: observed.reported_review_status, reported_verdict: observed.reported_verdict,
        response_evidence: observed.response_evidence, original_reference: {pointer: `/review_context/observed_assessments/${index}/${observed.reported_coverage ? "reported_coverage" : "coverage"}/${number}`},
        original_sha256: bindingHash(item)}));
  }
  const retainedCoverage = new Map(retainedObservations(series, "coverage").map(({item}) => [item.path, item]));
  const pathDispositions = [...requiredPaths, ...unavailableSources.map((item) => item.path)].map((name) => {
    const eligible = eligibleCoverage.find((item) => item.path === name), invalidation = invalidated.find((item) => item.kind === "coverage" && item.id === name);
    const unavailable = unavailableSources.find((item) => item.path === name);
    const disposition = unavailable ? "unavailable" : previous && changed.includes(name) ? previous.snapshot.files[name] == null && snapshot.files[name] != null ? "new" : "changed" : eligible ? "reusable" : retainedCoverage.has(name) ? "dependent" : "unreviewed";
    return {path: name, disposition, current: unavailable ? {known: false, availability: "UNAVAILABLE", reason: unavailable.reason} : {known: Object.hasOwn(snapshot.files, name), content: snapshot.files[name] ?? null, facts: snapshot.file_facts?.[name] ?? null},
      previous: previous ? {known: Object.hasOwn(previous.snapshot.files, name), content: previous.snapshot.files[name] ?? null, facts: previous.snapshot.file_facts?.[name] ?? null} : null,
      reason: unavailable?.reason ?? invalidation?.reason ?? (disposition === "reusable" ? "Recorded content/dependencies/guards match; independently verify semantic and criterion applicability." : disposition === "new" || disposition === "changed" ? "Observed content, membership, mode or type changed since the prior attempted snapshot." : "No verified current path coverage; assess applicable scope and retained supporting observations."),
      supporting_observations: observedAssessments.filter((item) => item.coverage.some((entry) => entry.path === name) || item.findings.some((entry) => entry.path === name || entry.affected_paths.includes(name)) || item.unreviewed.includes(name)).map((item) => item.id)};
  });
  const history = new Map();
  for (const observed of cohortAssessments) for (const finding of observed.findings) history.set(finding.id, {...finding, last_status: "OBSERVED", last_round: observed.round, resolution_evidence: null});
  for (const round of series.rounds) {
    for (const finding of round.observed_assessment?.findings ?? []) history.set(finding.id, {...finding, last_status: "OBSERVED", last_round: round.round, resolution_evidence: null});
    for (const finding of round.findings) history.set(finding.id, {...finding, last_status: "OPEN", last_round: round.round, resolution_evidence: null});
    for (const resolution of round.response?.resolutions ?? []) {
      const finding = history.get(resolution.id);
      if (finding) history.set(resolution.id, {...finding, last_status: resolution.status, last_round: round.round, resolution_evidence: resolution.evidence});
    }
  }
  return {filename, metadataRoot: path.dirname(directory), series, snapshot, proposalRecord, public: {
    series_id: series.series_id, round: series.rounds.length + 1,
    mode: !previous ? "initial" : previous.review_status === "INCOMPLETE" ? "resume" : "followup",
    previous_candidate: previous?.snapshot.tree ?? null, previous_binding: previous ? bindingHash(previous.snapshot) : null,
    prior_assessment: priorAssessment(series, filename, snapshot),
    changed_since_previous: changed, proposal_scope_changed: Boolean(previous && previous.snapshot.proposal_sha256 !== inputs.proposal_sha256),
    previous_proposal: previous?.proposal_record?.proposal ?? null, current_proposal: proposalRecord?.proposal ?? null,
    pending_changed_paths: pendingChanged, initial_assessment_complete: initialAssessmentComplete,
    path_dispositions: pathDispositions, supporting_coverage: supportingCoverage, navigation_coverage: navigationCoverage, observed_assessments: observedAssessments, observed_cohorts: cohortAssessments, unavailable_sources: unavailableSources,
    last_complete_verdict: series.rounds.findLast((round) => round.review_status === "COMPLETE")?.verdict ?? null,
    latest_repair_plan: previous?.repair_plan ?? null,
    prior_findings: previous?.findings ?? [], eligible_coverage: eligibleCoverage, eligible_validations: eligibleValidation, invalidated,
    finding_history: [...history.values()], history_file: filename, history_sha256: series.sha256 ?? null,
    validation_proofs: validationProofs,
    reviewer_policy_equivalence: equivalence,
    recovered_coverage: recovered, owner_evidence_changed: Boolean(previous && bindingHash(previous.snapshot.context.owner) !== bindingHash(context.owner)), fresh_protected_authority_assessment_required: true,
    preverified_validations: preverifiedValidations,
    unfinished_scope: unfinishedScope,
    unsuccessful_repair_rounds: repairRejections, synthesis_required: repairRejections >= 2,
    required_paths: requiredPaths,
  }};
}

export function assessRound(context, response, validation) {
  const {public: current, snapshot} = context;
  const priorFindings = [...current.prior_findings];
  for (const observed of current.observed_assessments ?? []) for (const finding of observed.findings) {
    const resolved = current.finding_history.find((item) => item.id === finding.id && item.last_status === "RESOLVED" && item.last_round > observed.round);
    if (resolved) continue;
    const known = priorFindings.find((item) => item.id === finding.id);
    if (known && (known.code !== finding.code || known.path !== finding.path)) throw new Error("Oracle raw finding identity disagrees with retained finding history");
    if (!known) priorFindings.push(finding);
  }
  if (!["COMPLETE", "INCOMPLETE"].includes(response.review_status) ||
      (response.review_status === "INCOMPLETE" ? response.verdict !== null : !["APPROVED", "REJECTED"].includes(response.verdict))) throw new Error("Oracle review completion state and verdict disagree");
  if (response.review_status === "COMPLETE" && response.unreviewed.length) throw new Error("Oracle complete assessment has unreviewed scope");
  const coverage = response.coverage.map((item) => bindItem(item, snapshot, item.path));
  if (new Set(coverage.map((item) => item.path)).size !== coverage.length) throw new Error("Oracle coverage paths must be unique");
  for (const name of response.reused_coverage) {
    const item = current.eligible_coverage.find((entry) => entry.path === name);
    if (!item || coverage.some((entry) => entry.path === name)) throw new Error(`Oracle reused coverage is invalid: ${name}`);
    coverage.push(item);
  }
  const missing = current.required_paths.filter((name) => !coverage.some((item) => item.path === name));
  if (response.review_status === "COMPLETE" && missing.length) throw new Error(`Oracle complete assessment lacks coverage: ${missing.join(", ")}`);
  const scopeDispositions = response.scope_dispositions ?? [];
  if (!Array.isArray(scopeDispositions) || new Set(scopeDispositions.map((item) => item.path)).size !== scopeDispositions.length ||
      scopeDispositions.some((item) => !current.unavailable_sources.some((source) => source.path === item.path) || item.disposition !== "UNAVAILABLE" || !item.evidence?.trim())) throw new Error("Oracle unavailable scope requires unique current paths and independent disposition evidence");
  if (response.review_status === "COMPLETE") for (const item of current.unavailable_sources) if (!scopeDispositions.some((entry) => entry.path === item.path)) throw new Error(`Oracle unavailable scope requires independent disposition: ${item.path}`);
  const validations = response.validations.map((item) => {
    const evidence = validation.find((entry) => entry.kind === "file" && entry.value === item.evidence);
    if (!evidence) throw new Error(`Oracle validation reuse requires supplied hash-bound file evidence: ${item.evidence}`);
    const proof = current.validation_proofs.find((entry) => entry.evidence === item.evidence && entry.eligible);
    if (!proof) throw new Error("Reusable Oracle validation requires an original launcher-recorded passing execution witness; raw logs cannot be relabeled");
    const scopeReason = validationScopeReason(proof, snapshot);
    if (scopeReason) throw new Error(`Oracle validation original command, input, dependency, configuration, environment or recorded scope does not match current candidate: ${scopeReason}`);
    dependenciesOf(item, snapshot);
    const declared = proof.record.before.scope === "declared-inputs-v2";
    const witnessFor = declared ? commandWitness : executionWitness;
    if (declared && bindingHash([...item.dependencies].sort()) !== bindingHash(Object.keys(proof.record.before.files).sort())) throw new Error("Oracle validation requires the complete originally declared command dependency set");
    if (item.command !== JSON.stringify(proof.record.command) || witnessFor(proof.record.before, item.dependencies) !== witnessFor(snapshot, item.dependencies, proof.current_provenance?.environment)) throw new Error("Oracle validation original command, input, dependency, configuration or environment proof does not match current candidate");
    return {...bindExecution(item, proof.record.before), evidence_sha256: evidence.sha256, execution_record_sha256: proof.record.record_sha256};
  });
  for (const id of response.reused_validations) {
    const item = current.eligible_validations.find((entry) => entry.id === id);
    if (!item || validations.some((entry) => entry.id === id)) throw new Error(`Oracle reused validation is invalid: ${id}`);
    validations.push(item);
  }
  if (new Set(validations.map((item) => item.id)).size !== validations.length) throw new Error("Oracle validation IDs must be unique");
  for (const observation of current.preverified_validations) if (!validations.some((item) => item.evidence === observation.evidence)) validations.push(observation);
  const findings = response.findings;
  const knownFindingIds = new Set([...findings, ...priorFindings, ...current.finding_history].map((item) => item.id));
  for (const item of response.coverage) if (item.finding_ids.some((id) => !knownFindingIds.has(id))) throw new Error("Oracle coverage references an unknown finding identity");
  if (new Set(findings.map((item) => item.id)).size !== findings.length) throw new Error("Oracle finding IDs must be unique");
  if (response.verdict === "APPROVED" && findings.length) throw new Error("Oracle approved assessment contains unresolved findings");
  if (response.verdict === "REJECTED" && !findings.length) throw new Error("Oracle source rejection requires consolidated source findings");
  const resolutions = response.resolutions;
  const resolvedHistory = new Set(current.finding_history.filter((item) => item.last_status === "RESOLVED").map((item) => item.id));
  if (new Set(resolutions.map((item) => item.id)).size !== resolutions.length || resolutions.some((item) =>
    !priorFindings.some((finding) => finding.id === item.id) &&
    !(resolvedHistory.has(item.id) && item.status === "RESOLVED" && item.evidence?.trim() && !findings.some((finding) => finding.id === item.id)))) throw new Error("Oracle finding resolutions are duplicated or unknown");
  for (const prior of priorFindings) {
    const resolution = resolutions.find((item) => item.id === prior.id);
    const finding = findings.find((item) => item.id === prior.id);
    if (response.review_status === "COMPLETE" && (!resolution || !resolution.evidence?.trim())) throw new Error(`Oracle prior finding requires explicit resolution evidence: ${prior.id}`);
    if (resolution && ((resolution.status === "OPEN") !== Boolean(finding))) throw new Error(`Oracle resolution disagrees with current findings: ${prior.id}`);
    if (finding && (finding.code !== prior.code || finding.path !== prior.path)) throw new Error(`Oracle stable finding ID changed identity: ${prior.id}`);
  }
  // Fresh submitted coverage owns its requirement provenance. Carried coverage
  // and interrupted attempts never silently adopt a later approved scope.
  const observations = new Map();
  for (const round of context.series.rounds) {
    if (round.error || !round.response) continue;
    for (const item of round.response.coverage ?? []) observations.set(item.path, {item, snapshot: round.snapshot, proposal: round.proposal_record?.proposal});
  }
  for (const finding of findings) {
    const historical = current.finding_history.find((item) => item.id === finding.id);
    if (historical && (historical.code !== finding.code || historical.path !== finding.path)) throw new Error(`Oracle stable historical finding ID changed identity: ${finding.id}`);
    const existing = priorFindings.some((item) => item.id === finding.id);
    if (!existing && current.initial_assessment_complete && finding.origin === "initial") throw new Error("Oracle follow-up finding must identify repair impact or a missed finding");
    if (finding.origin === "missed" && !finding.missed_finding_reason?.trim()) throw new Error("Oracle missed finding requires a first-pass coverage explanation");
    const affected = [...new Set([finding.path, ...finding.affected_paths].filter(Boolean))];
    const observed = observations.has(finding.path) ? [observations.get(finding.path)] : affected.flatMap((name) => observations.has(name) ? [observations.get(name)] : []);
    const actualInputChanged = affected.some((name) => current.pending_changed_paths.includes(name)) || observed.some(({item, snapshot: original}) => item.dependencies.some((name) => (original.files[name] ?? null) !== (snapshot.files[name] ?? null)));
    const approvedRequirementChanged = typeof current.current_proposal === "string" && current.current_proposal.trim() && response.synthesis?.trim() && observed.some(({proposal}) => typeof proposal === "string" && proposal.trim() && proposal.trim() !== current.current_proposal.trim());
    if (!existing && current.initial_assessment_complete && finding.origin === "repair" && !actualInputChanged && !approvedRequirementChanged) throw new Error("Oracle repair finding must name an affected changed path or an explained new approved requirement; unchanged-code discoveries require missed-finding attribution");
  }
  // Preserve findings omitted by a partial assessment so a later resume cannot
  // silently lose an unresolved defect.
  const retained = current.prior_findings.filter((item) => !findings.some((finding) => finding.id === item.id) && !resolutions.some((resolution) => resolution.id === item.id && resolution.status === "RESOLVED"));
  return {coverage, validations, findings: [...findings, ...retained]};
}

export async function saveRound(context, response, assessed, {error = null, observed = null, beforePublish = null, cohortReports = []} = {}) {
  let repairPlan = context.public.latest_repair_plan;
  if (response?.review_status === "COMPLETE") {
    const failedRepairs = response.verdict === "REJECTED" && context.public.last_complete_verdict === "REJECTED" ? context.public.unsuccessful_repair_rounds + 1 : 0;
    repairPlan = null;
    if (failedRepairs >= 2) {
      const findings = assessed.findings;
      const paths = new Map();
      for (const finding of findings) for (const name of finding.affected_paths) paths.set(name, [...paths.get(name) ?? [], finding.id]);
      repairPlan = {after_unsuccessful_repair_rounds: failedRepairs,
        findings: findings.map(({id, required_behavior, affected_paths, acceptance_checks}) => ({id, required_behavior, affected_paths, acceptance_checks})),
        overlapping_paths: [...paths.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({path: name, finding_ids: ids})),
        next_action: "Repair every open finding together, reconcile overlapping paths, execute affected acceptance checks, and resubmit one complete candidate.",
        reviewer_synthesis: response.synthesis};
    }
  }
  const round = {
    round: context.public.round, mode: context.public.mode, snapshot: context.snapshot,
    review_status: response?.review_status ?? "INCOMPLETE", verdict: response?.verdict ?? null,
    execution_status: error ? "ERROR" : response?.review_status ?? "INCOMPLETE",
    coverage: assessed?.coverage ?? context.public.eligible_coverage,
    validations: assessed?.validations ?? [...new Map([...context.public.eligible_validations, ...context.public.preverified_validations].map((item) => [item.id, item])).values()],
    findings: assessed?.findings ?? context.public.prior_findings,
    response, error, invalidated: context.public.invalidated, changed_since_previous: context.public.changed_since_previous,
    unreviewed: response?.unreviewed ?? [...new Set([...context.public.unfinished_scope, ...observed?.response.unreviewed ?? []])],
    pending_changed_paths: context.public.pending_changed_paths,
    proposal_record: context.proposalRecord,
    observed_cohorts: context.public.observed_cohorts ?? [], native_cohort_reports: cohortReports,
    reviewer_policy_equivalence: context.public.reviewer_policy_equivalence,
    repair_plan: repairPlan,
    ...(observed ? {observed_assessment: {...observed.assessed, response: observed.response, response_sha256: bindingHash(observed.response), response_evidence: observed.response_evidence,
      execution: observed.execution ?? null, execution_evidence: observed.execution_evidence ?? null}} : {}),
  };
  // ERROR observations have independent immutable custody before active-head,
  // predecessor or exclusive-journal admission. Losing publishers retain facts.
  if (error && observed) {
    const original = {...round, round: 1, coverage: [], validations: [], findings: [], verdict: null, review_status: "INCOMPLETE"};
    const support = {schema: "my-crm.oracle-series/v1", series_id: context.series.series_id,
      base_commit: context.series.base_commit, rounds: [original]};
    support.sha256 = seriesDigest(support);
    verifySeries(support, context.series.base_commit);
    const body = {schema: "my-crm.oracle-supporting-assessment/v1", original_round: context.public.round, series: support};
    const archive = {...body, sha256: bindingHash(body)};
    const target = path.join(path.dirname(context.filename), "supporting-assessments", context.series.base_commit, `${archive.sha256}.json`);
    const bytes = `${JSON.stringify(archive, null, 2)}\n`;
    try { await writeMetadataFile(target, bytes, {flag: "wx"}, {root: context.metadataRoot}); }
    catch (failure) { if (failure.code !== "EEXIST" || await readMetadataFile(target, "utf8", {root: context.metadataRoot}) !== bytes) throw failure; }
  }
  try {
    const current = verifySeries(JSON.parse(await readMetadataFile(context.filename, "utf8", {root: context.metadataRoot})), context.series.base_commit);
    if (current.sha256 !== context.series.sha256) throw new Error("Oracle review-series history changed during review");
  } catch (failure) {
    if (failure.code !== "ENOENT" || context.series.sha256) throw failure;
  }
  const series = {...context.series, rounds: [...context.series.rounds, round]};
  series.sha256 = seriesDigest(series);
  await beforePublish?.(series);
  await assertCurrentInvocation();
  const journal = path.join(path.dirname(context.filename), "rounds", context.series.base_commit, `${context.public.round}.json`);
  await writeMetadataFile(journal, `${JSON.stringify({previous_sha256: context.series.sha256 ?? null, series}, null, 2)}\n`, {flag: "wx"}, {root: context.metadataRoot});
  await assertCurrentInvocation();
  await atomicJson(context.filename, series, {root: context.metadataRoot});
  return series;
}

export const reviewSeriesPolicy = [
  "Owner workflow, 2026-10-21: Confirm current governing instructions first and read each current authority once. Make one complete assessment pass over each unvalidated commit or batched range; return all findings together. Ordinary direct commits and repair commits require no approval or Oracle trailer. Supporting_coverage preserves prior complete observations across instruction/control changes with eligibility NONE; independently assess changed criteria and missing/affected paths, emit fresh coverage and retain valid unchanged tests. Every product family member executes its entire validation lifecycle concurrently with the other changed members. Validation and delivered checkpoints are distinct; unchanged repeated shipments execute no validation, build, version increment, deployment or publication.",
  "Owner review direction, 2026-10-17: Source work by every implementation and author continues during review and after INCOMPLETE or ERROR. Impose no source-file or code-line lock, checkout freeze or work pause. Include and validate every arrived change in the integrated current candidate. No long-held review-session or review-series reservation is taken. Atomic exclusive journal rounds and invocation comparisons protect publication. Inspect path_dispositions alongside changed_since_previous (actual prior attempted-snapshot delta) and pending_changed_paths (cumulative repair delta). Hash equality or an absent graph edge supplies no proof of semantic independence; investigate uncertain dependencies narrowly and explain expanded coverage. State each path's reviewed behavior, criteria, source/configuration dependencies, result evidence and finding identities.",
  "observed_assessments retains raw schema-valid ERROR-attempt observations under their original tree, dependency witnesses, original response hash and actual execution status. Its reported verdict describes only the original raw response. Intact original response files are automatically rebound as supporting evidence; missing or changed custody is explicit. These records create no eligible coverage, passing aggregate, native witness or approval. Independently compare actual current source, consumed dependencies, criteria and evidence, then emit fresh re-attested coverage and stable findings where applicable. Account for every retained raw finding through explicit OPEN or RESOLVED resolution evidence; independent examination may establish, repair or dismiss an observed issue without promoting its original status. Preserve every original status and explain concrete changed-identity reasons. Finish with the independent decision for the entire exact current candidate.",
  "Initially unknown unsafe or unbindable raw source claims retain stable IDs as UNAVAILABLE scope, with no external reads, source identity or coverage. Independently disposition every unavailable_sources entry in scope_dispositions with its exact path, disposition UNAVAILABLE and current scope evidence, and separately resolve each retained raw finding. Never invent original source presence or promote raw coverage. Previously bound source becoming unsafe remains an execution ERROR. Current prepared source bindings control assessment; historical context supplied as evidence supplies no replacement source manifest. A source also supplied as evidence retains full source mode and ancestor custody.",
  "Authoritative execution policy: The initial assessment completes the full relevant scope and consolidates all established actionable findings. Followup starts with the actual source/control delta, then affected dependencies, open findings and unfinished coverage. Mechanical guard invalidation requires independent applicability checks and new re-attestation of sealed unchanged facts; it does not by itself require rereading all source or authority or rerunning tests. Original passing-case support from FAILED or ERROR aggregates, strict-ineligible native records or historical logs can support independently verified unchanged behavior; retain every original status and scope and never promote native eligibility. Absence of a current green aggregate or being outside the preverified subset is never an execution reason. Before any command, name the concrete changed consumed dependency or new uncovered behavior being checked and include that reason in the result. Use compact context projections; consult full original records or source only for a specific unresolved fact. Fresh exact-candidate, authentication and public-API request decisions remain mandatory. Assess actual protected deployment effects separately; missing human deployment authority never blocks technical assessment, receipt or commit.",
  "The authority manifest automatically binds inherited parent AGENTS policy and the exact family architecture and review-coordination design declared by local AGENTS, including absent-file tombstones. The declared Projects Oracle command is the supported invocation reference; bind its content and custody when explicitly consumed as supplied review evidence or an actual source dependency. An invocation reference alone creates no automatic command-source read or binding. Consumed external inputs use their allowlisted absolute paths as dependency identities. Read applicable governing evidence without importing or executing sibling runtime source or adopting another approver skill. Changed parent policy reopens governing criteria; new scoped execution facts bind declared command inputs independently of unselected reviewer provenance. Other consumed external inputs reopen their own coverage and actual dependents. Their presence supplies no owner/API request approval.",
  "Inspect review_context.prior_assessment before rereading unchanged owner/authentication/API authority bundles. Its origin seals, factual candidate/guard equality and stored classifications are historical navigation, with no approval or eligibility override. Verify current differences and make every fresh protected-deployment-impact, separate owner-authority, API-request and whole-candidate technical decision independently; absent classifications remain absent.",
  "Review-series contract: Read review_context in the bound evidence. Complete the first assessment across every changed behavior, relevant caller, dependency, boundary and failure path before returning all findings together. Do not stop at the first defect. State exact reviewed paths, dependency closure, rationale and assessment in coverage; enumerate unfinished scope in unreviewed.",
  "Use repository-relative identifiers for coverage paths, dependencies and affected_paths so the launcher can verify their candidate bindings. Candidate dependencies may include tracked source, tests, fixtures and configuration plus authority-manifest paths. Describe external or environment assumptions in dependency_rationale and independently verify them. Scope or policy changes can invalidate machine eligibility; independently re-attest affected items from sealed observations and the actual delta. Mechanical invalidation alone requires no full source rescan or test rerun.",
  "On followup/resume, inspect changed_since_previous, pending_changed_paths, unfinished_scope, finding_history, every open finding and affected dependencies. pending_changed_paths retains the repair delta across interrupted attempts. Independently verify prior coverage, dependency completeness, current proposal scope and eligible validation witnesses before naming their IDs in reused_coverage/reused_validations. Eligible means content-compatible evidence, never automatic acceptance. Reopen affected assumptions explicitly. A coverage entry means completed assessment for that path and its dependency closure; unfinished parts belong in unreviewed. Fresh coverage plus verified reused coverage must cover every required path. An incomplete assessment returns review_status INCOMPLETE with verdict null and can retain completed partial coverage; source REJECTED requires a completed assessment.",
  "Findings require stable IDs, concrete reproduction, required behavior, affected_paths and acceptance_checks so the implementer can repair them together. Resolve every prior finding explicitly as OPEN or RESOLVED with evidence. Reuse its ID for the same defect. New repair defects identify a changed affected path with origin repair. A late unchanged-code discovery uses origin missed and explains the missed first-pass coverage in missed_finding_reason. Findings before initial_assessment_complete, including resumed unfinished initial assessment, use origin initial.",
  "Carry validation only from eligible validation_proofs produced by the launcher-owned validate command. Verify original recorded before/after inputs, source/test/fixture/configuration dependency closure, passing outcome, executable and retained output hashes, relevant environment and current applicability. Copy command as JSON.stringify(record.command). Legacy logs and raw assertions remain review evidence and cannot be relabeled reusable by assigning current hashes. Record invalidation reasons. Context binds authorities, tooling, owner evidence and the execution environment hash; configuration/dependency changes require affected checks.",
  "Before executing any validation, inspect supplied native execution proofs, preverified_validations and original passing-case support. The wrapper retains exact-current native observations even when your validations array is empty. Preserve every execution record's complete original scope; recording a dependency description never trims it. An original passing proof whose complete inputs, command, executable, dependencies and environment match satisfies requirements to run that check. Independently qualified historical passing cases can support unchanged behavior while their original aggregate or native eligibility stays unchanged. Run additional checks only for a named concrete changed consumed dependency or new uncovered behavior, and record that reason before execution and in the result. A missing current aggregate or absence from preverified_validations supplies no execution reason.",
  "Native execution records retained in this series are inherited automatically after original record and output hashes are reverified, then rebound into the effective current evidence manifest. Reassess source/dependency/configuration/environment applicability. Missing or altered originals produce explicit invalidations. Inherited command observations authorize no owner, authentication or API-version decision; require current explicit owner/API-request evidence under existing gates.",
  "The wrapper publishes a deterministic repair plan immediately with the second rejected follow-up, including every open finding, required behavior, overlapping path and acceptance check. Review latest_repair_plan and add useful reasoning in synthesis; omitted model synthesis never requires a retry. Target one complete initial review and one repair review while reporting every material defect you establish. Finish with a fresh independent whole-candidate verdict; prior approval receipts remain obsolete after candidate changes. Preserve owner approval, explicit API-version request and exact staged-tree verifier gates.",
].join("\n");

const text = {type: "string", minLength: 1};
const strings = {type: "array", items: text};
const dependencyFields = {dependencies: {...strings, minItems: 1}, dependency_rationale: text};
export const reviewSeriesSchemaProperties = {
  scope_dispositions: {type: "array", items: {type: "object", additionalProperties: false, required: ["path", "disposition", "evidence"], properties: {path: text, disposition: {type: "string", enum: ["UNAVAILABLE"]}, evidence: text}}},
  review_status: {type: "string", enum: ["COMPLETE", "INCOMPLETE"]},
  unreviewed: strings, reused_coverage: strings, reused_validations: strings,
  synthesis: {type: ["string", "null"]},
  coverage: {type: "array", items: {type: "object", additionalProperties: false, required: ["path", "dependencies", "dependency_rationale", "assessment", "criteria", "evidence", "finding_ids"], properties: {path: {...text, description: "Explicit independently reviewed prepared source path; the native witness always binds this source and its exact custody."}, ...dependencyFields, assessment: text, criteria: {...strings, minItems: 1}, evidence: {...strings, minItems: 1}, finding_ids: strings}}},
  validations: {type: "array", items: {type: "object", additionalProperties: false, required: ["id", "evidence", "command", "dependencies", "dependency_rationale", "assessment"], properties: {id: text, evidence: text, command: text, ...dependencyFields, assessment: text}}},
  resolutions: {type: "array", items: {type: "object", additionalProperties: false, required: ["id", "status", "evidence"], properties: {id: text, status: {type: "string", enum: ["OPEN", "RESOLVED"]}, evidence: text}}},
};
export const seriesFindingSchema = {type: "array", items: {
  type: "object", additionalProperties: false,
  required: ["id", "severity", "code", "message", "path", "reproduction", "required_behavior", "affected_paths", "acceptance_checks", "origin", "missed_finding_reason"],
  properties: {id: text, severity: {type: "string", enum: ["critical", "high", "medium", "low"]}, code: text, message: text, path: text,
    reproduction: text, required_behavior: text, affected_paths: {...strings, minItems: 1}, acceptance_checks: {...strings, minItems: 1},
    origin: {type: "string", enum: ["initial", "repair", "missed"]}, missed_finding_reason: {type: ["string", "null"]}},
}};
