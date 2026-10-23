// Owner-prepared source material. It grants navigation, never coverage or approval.
import path from "node:path";
import {atomicJson, bindingHash, contentHash, writeMetadataFile} from "./oracle-inputs.mjs";

export function utf8Pages(text, limit = 8192) {
  if (!Number.isSafeInteger(limit) || limit < 4) throw new Error("Source page limit must fit a UTF-8 code point");
  const pages = []; let content = "", bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { pages.push(content); content = ""; bytes = 0; }
    content += character; bytes += size;
  }
  if (content || !pages.length) pages.push(content);
  return pages;
}

export async function prepareSourcePacket({directory, candidate, inputs, evidence, cohort, diff, diffBase = candidate.base, sourceForPath}) {
  const files = [], items = [], pageRoot = path.join(directory, "source-packet"); let sequence = 0;
  const pagesFor = async (text, origin) => {
    const pages = []; let offset = 0, line = 1;
    for (const content of utf8Pages(text)) {
      const filename = path.join(pageRoot, `${String(sequence++).padStart(6, "0")}.txt`), bytes = Buffer.byteLength(content);
      await writeMetadataFile(filename, content, {flag: "wx"});
      const reference = {path: filename, sha256: contentHash(content), bytes, utf8_offset: offset, start_line: line,
        end_line: line + (content.match(/\n/g)?.length ?? 0), origin};
      files.push({path: filename, sha256: reference.sha256}); pages.push(reference);
      offset += bytes; line = reference.end_line;
    }
    return pages;
  };
  const diffPages = await pagesFor(diff, {kind: "ASSIGNED_DIFF", tree: candidate.tree, base: diffBase});
  const invalidations = evidence.review_context.invalidated ?? [];
  const invalidationPages = await pagesFor(`${JSON.stringify(invalidations, null, 2)}\n`,
    {kind: "ALL_NATIVE_INVALIDATION_REASONS", original_pointer: "/review_context/invalidated", original_sha256: bindingHash(invalidations)});
  const navigationCollection = evidence.review_context.navigation_coverage ?? [];
  const navigationCollectionHash = bindingHash(navigationCollection);
  for (const name of cohort.required_paths) {
    const consumed = [...evidence.review_context.eligible_coverage ?? [], ...evidence.review_context.supporting_coverage ?? []].filter(item => item.path === name);
    const item = {path: name, required: true, candidate_commit: candidate.commit ?? null, candidate_tree: candidate.tree,
      dependency_closure: "UNKNOWN_UNTIL_INDEPENDENT_TRACE", dependencies_on_demand: [...new Set(consumed.flatMap(item => item.dependencies ?? []))],
      retained_observation_checkpoints: consumed.map(item => ({path: item.path, input_sha256: item.input_sha256 ?? null,
        origin: item.round ?? item.origin ?? null, eligibility: "INDEPENDENT_CURRENT_APPLICABILITY_REQUIRED"})), versions: []};
    const navigation = navigationCollection.filter(entry => entry.path === name)
      .sort((a, b) => (a.origin?.round ?? 0) - (b.origin?.round ?? 0));
    const latest = navigation.at(-1);
    item.retained_review_navigation = {observation_count: navigation.length,
      grants_eligible_coverage: false, grants_approval: false,
      original_collection: {file: "../../evidence.json", pointer: "/review_context/navigation_coverage", original_sha256: navigationCollectionHash},
      pages: await pagesFor(`${JSON.stringify({path: name, latest_observation: latest ?? null,
        current_disposition: (evidence.review_context.path_dispositions ?? []).find(entry => entry.path === name) ?? null,
        invalidations: invalidations.filter(entry => entry.id === name || entry.changed_dependencies?.includes(name)),
        applicability: "Exact producer-shaped navigation only. Prior rationale, criteria, evidence, per-dependency source/facts/custody identities and context comparisons require independent current assessment. Unknown original identities stay unknown; ERROR observations supply zero eligible coverage or approval."}, null, 2)}\n`,
        {kind: "RETAINED_REVIEW_NAVIGATION", path: name, original_sha256: latest ? bindingHash(latest) : null})};
    // The isolated trusted reviewer alone loads its approver-role authority.
    if (/(?:^|\/)\.agents\/skills\/oracle\//.test(name)) {
      item.state = "TRUSTED_REVIEWER_AUTHORITY_ON_DEMAND";
      item.authority = inputs.authorities?.find(authority => authority.path === name) ?? null;
      items.push(item); continue;
    }
    for (const revision of [...new Set([diffBase, candidate.tree])]) {
      const material = sourceForPath ? await sourceForPath(name, revision) : null;
      if (!material) { item.versions.push({revision, state: "UNKNOWN_SOURCE_ON_DEMAND", locator: {path: name, revision}}); continue; }
      if (material.state !== "PRESENT") { item.versions.push({...material, revision}); continue; }
      const origin = {path: name, revision, git_blob: material.git_blob ?? null, locator: material.locator};
      const bodyPages = await pagesFor(material.text, origin);
      item.versions.push({state: "PRESENT", revision, locator: material.locator, git_blob: material.git_blob ?? null,
        source_sha256: contentHash(material.text), bytes: Buffer.byteLength(material.text), pages: bodyPages,
        complete_changed_definitions: {representation: "COMPLETE_SOURCE_FILE", completeness: "ALL_ENCLOSING_DEFINITIONS_AND_METHODS_INCLUDED",
          navigation: "Read assigned diff, then the enclosing complete definition through these exact line/byte pages; nested boundaries remain explicit on-demand rather than guessed."}});
    }
    items.push(item);
  }
  const manifest = {schema: "my-crm.source-packet/v1", cohort_id: cohort.id, candidate_commit: candidate.commit ?? null,
    candidate_tree: candidate.tree, review_base: candidate.base, diff_base: diffBase, input_binding_sha256: bindingHash(inputs),
    page_byte_limit: 8192, assigned_diff: diffPages, all_invalidation_reasons: {count: invalidations.length, pages: invalidationPages}, required_paths: [...cohort.required_paths], items,
    authority_once: (inputs.authorities ?? []).map(authority => ({path: authority.path, sha256: authority.sha256,
      state: "READ_ONCE_PER_CURRENT_IDENTITY_BY_TRUSTED_REVIEWER", external: authority.external ?? false})),
    dependency_policy: "Materialized bodies preserve exact original locators. Unmaterialized dependencies, callers, construction, publication and failure edges remain explicitly on-demand and require independent tracing. Presence, hashes and retained checkpoints grant no coverage, validation or approval."};
  const filename = path.join(pageRoot, "manifest.json");
  await atomicJson(filename, manifest, {exclusive: true});
  const reference = {path: filename, sha256: contentHash(`${JSON.stringify(manifest, null, 2)}\n`)};
  files.push(reference);
  return {reference, files};
}
