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
  for (const name of cohort.required_paths) {
    const consumed = [...evidence.review_context.eligible_coverage ?? [], ...evidence.review_context.supporting_coverage ?? []].filter(item => item.path === name);
    const item = {path: name, required: true, candidate_commit: candidate.commit ?? null, candidate_tree: candidate.tree,
      dependency_closure: "UNKNOWN_UNTIL_INDEPENDENT_TRACE", dependencies_on_demand: [...new Set(consumed.flatMap(item => item.dependencies ?? []))],
      retained_observation_checkpoints: consumed.map(item => ({path: item.path, input_sha256: item.input_sha256 ?? null,
        origin: item.round ?? item.origin ?? null, eligibility: "INDEPENDENT_CURRENT_APPLICABILITY_REQUIRED"})), versions: []};
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
    page_byte_limit: 8192, assigned_diff: diffPages, required_paths: [...cohort.required_paths], items,
    authority_once: (inputs.authorities ?? []).map(authority => ({path: authority.path, sha256: authority.sha256,
      state: "READ_ONCE_PER_CURRENT_IDENTITY_BY_TRUSTED_REVIEWER", external: authority.external ?? false})),
    dependency_policy: "Materialized bodies preserve exact original locators. Unmaterialized dependencies, callers, construction, publication and failure edges remain explicitly on-demand and require independent tracing. Presence, hashes and retained checkpoints grant no coverage, validation or approval."};
  const filename = path.join(pageRoot, "manifest.json");
  await atomicJson(filename, manifest, {exclusive: true});
  const reference = {path: filename, sha256: contentHash(`${JSON.stringify(manifest, null, 2)}\n`)};
  files.push(reference);
  return {reference, files};
}
