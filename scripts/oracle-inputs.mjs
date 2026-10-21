import {createHash, randomUUID} from "node:crypto";
import {mkdir, readFile, readdir, rename, link, rm, writeFile, lstat, realpath, readlink, open} from "node:fs/promises";
import {constants} from "node:fs";
import {AsyncLocalStorage} from "node:async_hooks";
import path from "node:path";
import {currentPolicy, policyVersion, policyModules} from "./oracle-policy.mjs";

export const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` : JSON.stringify(value);
export const contentHash = (value) => createHash("sha256").update(value).digest("hex");
export const bindingHash = (value) => contentHash(canonicalJson(value));
// Preserve components until the filesystem walker has resolved every preceding
// link. path.resolve would collapse link/.. and missing/.. before OS lookup.
export const lexicalPath = (root, name) => path.isAbsolute(name) ? name : `${path.resolve(root)}${path.sep}${name}`;
const metadataScope = new AsyncLocalStorage();
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;

async function verifyMetadataStore() {
  const store = metadataScope.getStore();
  if (!store) return;
  const custody = await pathCustody(store.root, store.requested, {scopeRoot: store.root});
  if (!sameIdentity(await lstat(custody.resolved_path), store.identity)) throw new Error("Oracle metadata directory identity changed");
  if (store.lock) {
    const current = await pathCustody(store.root, store.lock, {scopeRoot: store.root, allowFinalLink: false});
    const stats = await lstat(current.resolved_path);
    if (!stats.isDirectory() || !sameIdentity(stats, store.lockIdentity)) throw new Error("Oracle metadata lock identity changed");
  }
}

export async function metadataDirectory(root, directory, {create = true} = {}) {
  await verifyMetadataStore();
  const before = await pathCustody(root, directory, {scopeRoot: root, allowMissing: create});
  if (before.metadata === null) {
    if (before.resolved_path.split(path.sep).includes("..")) throw new Error("Oracle metadata has an unresolved missing parent");
    await mkdir(before.resolved_path, {recursive: true, mode: 0o700});
  }
  const after = await pathCustody(root, directory, {scopeRoot: root});
  if (after.resolved_path !== before.resolved_path || !(await lstat(after.resolved_path)).isDirectory()) throw new Error("Oracle metadata directory is unavailable or changed");
  return after.resolved_path;
}

const metadataOwner = (filename, root) => root ?? metadataScope.getStore()?.root ?? path.dirname(filename);

export async function readMetadataFile(filename, options = {}, {root} = {}) {
  root = metadataOwner(filename, root);
  await verifyMetadataStore();
  const before = await pathCustody(root, filename, {scopeRoot: root});
  const handle = await open(before.resolved_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Oracle metadata must be a regular file");
    bytes = await handle.readFile(options);
  } finally { await handle.close(); }
  if (bindingHash(before) !== bindingHash(await pathCustody(root, filename, {scopeRoot: root}))) throw new Error("Oracle metadata custody changed during read");
  await verifyMetadataStore();
  return bytes;
}

export async function writeMetadataFile(filename, data, options = {}, {root} = {}) {
  root = metadataOwner(filename, root);
  await metadataDirectory(root, path.dirname(filename));
  const before = await pathCustody(root, filename, {scopeRoot: root, allowMissing: true});
  if (before.metadata !== null && !(await lstat(before.resolved_path)).isFile()) throw new Error("Oracle metadata must be a regular file");
  const flags = before.metadata === null || options.flag === "wx" ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDWR;
  const handle = await open(before.resolved_path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, options.mode ?? 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Oracle metadata must be a regular file");
    if (before.metadata !== null) await handle.truncate(0);
    await handle.writeFile(data, options);
    await handle.sync();
  } finally { await handle.close(); }
  const after = await pathCustody(root, filename, {scopeRoot: root});
  if (before.resolved_path !== after.resolved_path) throw new Error("Oracle metadata custody changed during write");
  await verifyMetadataStore();
}

export async function removeMetadataFile(filename, options = {}, {root} = {}) {
  root = metadataOwner(filename, root);
  await verifyMetadataStore();
  const current = await pathCustody(root, filename, {scopeRoot: root, allowMissing: true});
  if (current.metadata === null) return;
  const parent = await metadataDirectory(root, path.dirname(filename), {create: false});
  await rm(path.join(parent, path.basename(filename)), options);
  const store = metadataScope.getStore();
  if (store?.lock === filename) store.lock = null;
  await verifyMetadataStore();
}

export async function atomicJson(filename, value, {root, exclusive = false} = {}) {
  root = metadataOwner(filename, root);
  await metadataDirectory(root, path.dirname(filename));
  const destination = await pathCustody(root, filename, {scopeRoot: root, allowMissing: true});
  if (destination.metadata !== null && !(await lstat(destination.resolved_path)).isFile()) throw new Error("Oracle metadata must be a regular file");
  const temporary = `${destination.resolved_path}.${randomUUID()}.tmp`;
  try {
    await writeMetadataFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: "wx"}, {root});
    await verifyMetadataStore();
    const current = await pathCustody(root, filename, {scopeRoot: root, allowMissing: true});
    if (current.resolved_path !== destination.resolved_path) throw new Error("Oracle publication destination changed");
    if (exclusive) await link(temporary, current.resolved_path);
    else await rename(temporary, current.resolved_path);
    await verifyMetadataStore();
  } finally { await removeMetadataFile(temporary, {force: true}, {root}); }
}

export async function withOracleRun(requested, action, {kind = null, onAdmitted = null, ownerRoot = path.dirname(requested)} = {}) {
  const directory = await metadataDirectory(ownerRoot, requested);
  const store = {root: ownerRoot, requested, identity: await lstat(directory), lock: null};
  return metadataScope.run(store, async () => {
  let run;
  const timings = {};
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let result, failure;
  const phase = async (name, operation) => {
    const begin = performance.now();
    try { return await operation(); } finally { timings[name] = performance.now() - begin; }
  };
  try {
    run = path.join(directory, "runs", randomUUID());
    if (["review", "proposal"].includes(kind)) {
      store.invocation = {id: path.basename(run), kind};
      store.directory = directory;
      await atomicJson(path.join(directory, `active-${kind}.json`), store.invocation);
    }
    await onAdmitted?.();
    await metadataDirectory(ownerRoot, run);
    result = await action({run, phase});
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    timings.total_ms = performance.now() - started;
    try {
      if (run) {
        await atomicJson(path.join(run, "timings.json"), timings);
        await atomicJson(path.join(run, "outcome.json"), {
          kind, started_at: startedAt, finished_at: new Date().toISOString(),
          outcome: failure ? "ERROR" : result?.review_status === "INCOMPLETE" ? "INCOMPLETE" : result?.verdict ?? result?.decision ?? "COMPLETED",
          reviewer_invoked: Object.hasOwn(timings, "reviewer_ms"),
          error: failure ? {name: failure.name, message: failure.message} : null,
        });
      }
    } catch (error) {
      if (!failure) throw error;
    }
  }
  });
}

export function currentInvocation() { return metadataScope.getStore()?.invocation ?? null; }
export async function assertPublishedInvocation(invocation, directory, ownerRoot = path.dirname(directory)) {
  if (!invocation) return; // Immutable historical receipts retain original custody.
  const active = JSON.parse(await readMetadataFile(path.join(directory, `active-${invocation.kind}.json`), "utf8", {root: ownerRoot}));
  if (bindingHash(active) !== bindingHash(invocation)) throw new Error("Oracle invocation was superseded by a newer attempt; retain original observations without publishing current approval");
}
export async function assertCurrentInvocation() {
  const store = metadataScope.getStore();
  if (store?.invocation) await assertPublishedInvocation(store.invocation, store.directory, store.root);
}

// Resolve each link before inspecting its target. Checking only final realpath
// loses ownership crossings which leave the final file unchanged.
export async function pathCustody(root, name, {scopeRoot = root, allowMissing = false, allowFinalLink = true, excluded = []} = {}) {
  const requestedRoot = path.resolve(root), canonicalRoot = await realpath(requestedRoot);
  const requestedScope = scopeRoot === null ? null : path.resolve(scopeRoot);
  const scope = requestedScope === null ? null : await realpath(requestedScope);
  const inside = (value, boundary) => value === boundary || value.startsWith(`${boundary}${path.sep}`);
  const canonical = (value) => inside(value, requestedRoot) ? `${canonicalRoot}${value.slice(requestedRoot.length)}` : requestedScope && inside(value, requestedScope) ? `${scope}${value.slice(requestedScope.length)}` : value;
  const requested = canonical(lexicalPath(requestedRoot, name));
  const forbidden = excluded.map((value) => canonical(path.resolve(requestedRoot, value)));
  const fail = (message) => Object.assign(new Error(message), {code: "ORACLE_SOURCE_UNAVAILABLE"});
  const guard = (value) => {
    if (scope && !inside(value, scope) || forbidden.some((prefix) => inside(value, prefix))) throw fail(`Oracle path custody crosses owning source scope: ${name}`);
  };
  guard(requested);
  // A terminal separator requires a directory, including in a link target.
  // Retain that requirement as a final dot component instead of dropping it.
  const components = (value) => [...value.split(path.sep).filter(Boolean), ...(value.endsWith(path.sep) ? ["."] : [])];
  let cursor = scope ?? path.parse(requested).root;
  let pending = components(requested.slice(cursor.length));
  const entries = [], seen = new Set(); let hops = 0, leaf = null;
  const anchor = await lstat(cursor);
  entries.push({path: cursor, type: anchor.isDirectory() ? "directory" : "other", mode: anchor.mode & 0o777});
  while (pending.length) {
    if (entries.length > 4096) throw fail(`Oracle path custody exceeds component bound: ${name}`);
    const segment = pending.shift();
    if (segment === ".") { if (!pending.length && leaf === null) { const stats = await lstat(cursor); leaf = {type: stats.isDirectory() ? "directory" : "other", mode: stats.mode & 0o777}; } continue; }
    if (segment === "..") {
      cursor = path.dirname(cursor); guard(cursor);
      const stats = await lstat(cursor), metadata = {type: stats.isDirectory() ? "directory" : "other", mode: stats.mode & 0o777};
      entries.push({path: cursor, ...metadata});
      if (!pending.length && leaf === null) leaf = metadata;
      continue;
    }
    const next = path.join(cursor, segment); guard(next);
    let stats;
    try { stats = await lstat(next); }
    catch (error) {
      if (!allowMissing || error.code !== "ENOENT") throw error;
      entries.push({path: next, type: "missing", mode: null});
      // A missing component stops OS lookup even if a later .. would lexically
      // name an existing file. Retain the unresolved spelling and absence.
      const absent = `${next}${pending.length ? `${path.sep}${pending.join(path.sep)}` : ""}`;
      return {path: requested, resolved_path: absent, metadata: null, entries};
    }
    const metadata = {type: stats.isSymbolicLink() ? "symlink" : stats.isFile() ? "regular" : stats.isDirectory() ? "directory" : "other", mode: stats.mode & 0o777};
    if (!pending.length && leaf === null) leaf = metadata;
    if (stats.isSymbolicLink()) {
      if (!allowFinalLink && !pending.length) throw fail(`Oracle input must be a regular file rather than a symbolic link: ${name}`);
      const target = await readlink(next); entries.push({path: next, ...metadata, target});
      const state = bindingHash({next, target, pending});
      if (++hops > 64 || seen.has(state)) throw fail(`Oracle path custody contains a symbolic link cycle: ${name}`);
      seen.add(state);
      if (path.isAbsolute(target)) {
        const absolute = canonical(target);
        guard(absolute);
        cursor = scope ?? path.parse(absolute).root;
        pending = [...components(scope ? absolute.slice(scope.length) : absolute.slice(cursor.length)), ...pending];
      } else {
        guard(`${cursor}${path.sep}${target}`);
        pending = [...components(target), ...pending];
      }
    } else {
      entries.push({path: next, ...metadata}); cursor = next;
      if (pending.length && !stats.isDirectory()) throw Object.assign(new Error(`Oracle path custody parent is not a directory: ${name}`), {code: "ENOTDIR"});
    }
  }
  return {path: requested, resolved_path: cursor, metadata: leaf, entries};
}

async function fileBinding(root, relative, {allowMissing = false} = {}) {
  const scopeRoot = path.isAbsolute(relative) ? path.dirname(path.resolve(root)) : root;
  const custody = await pathCustody(root, relative, {scopeRoot, allowMissing, allowFinalLink: false, excluded: [path.join(scopeRoot, ".git"), path.join(scopeRoot, "Vault/tmp"), path.join(scopeRoot, "Vault/index")]});
  if (custody.metadata === null) return {path: relative, sha256: null, custody};
  if (custody.metadata.type !== "regular") throw new Error(`Oracle input must be a regular file: ${relative}`);
  return {path: relative, sha256: contentHash(await readFile(custody.resolved_path)), custody};
}

// Observation-only source was outside the original manifest. Bind only its
// current identity; never infer that the original attempt saw these bytes.
export async function observedSourceBindings(root, names, {allowUnavailable = []} = {}) {
  return Promise.all([...new Set(names)].sort().map(async (name) => {
    const unavailable = (message) => Object.assign(new Error(message), {code: "ORACLE_SOURCE_UNAVAILABLE"});
    try {
      if (typeof name !== "string" || !name || path.isAbsolute(name) || /[\\\x00-\x1f]/.test(name) ||
          path.normalize(name) !== name || name.split("/").some((part) => !part || part === "." || part === "..") || name.split("/")[0].toLowerCase() === ".git") throw unavailable(`Oracle observed source requires a safe project-local path: ${name}`);
      const ancestors = [], parts = name.split("/");
      for (let index = 0; index < parts.length; index++) {
        const relative = parts.slice(0, index + 1).join("/");
        let stats;
        try { stats = await lstat(path.resolve(root, relative)); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          return {path: name, availability: "BOUND", sha256: null, metadata: null, ancestors: [...ancestors, {path: relative, metadata: null}]};
        }
        if (stats.isSymbolicLink()) throw unavailable(`Oracle observed source cannot cross a symbolic link: ${relative}`);
        const metadata = {type: stats.isFile() ? "regular" : stats.isDirectory() ? "directory" : "other", mode: stats.mode & 0o777};
        if (index < parts.length - 1) {
          if (!stats.isDirectory()) throw unavailable(`Oracle observed source parent must be a directory: ${relative}`);
          ancestors.push({path: relative, metadata});
        } else {
          if (!stats.isFile()) throw unavailable(`Oracle observed source must be a regular file: ${name}`);
          return {path: name, availability: "BOUND", sha256: contentHash(await readFile(path.resolve(root, name))), metadata, ancestors};
        }
      }
    } catch (error) {
      if (!allowUnavailable.includes(name) || !["ORACLE_SOURCE_UNAVAILABLE", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) throw error;
      return {path: name, availability: "UNAVAILABLE", reason: error.message};
    }
  }));
}

async function declaredParentAuthorities(root) {
  const parent = path.dirname(path.resolve(root));
  const policyCustody = await pathCustody(root, "AGENTS.md", {allowFinalLink: false});
  const declarations = await readFile(policyCustody.resolved_path, "utf8");
  // Only inherited policy and these exact locally declared coordination files
  // cross the project boundary. Their bytes are evidence, never runtime imports.
  const files = [{path: path.join(parent, "AGENTS.md"), controlling: true}];
  // A named command is an invocation reference, not governing prose. Actual
  // consumed external controller evidence remains bound through validation
  // and observed-source manifests instead of this automatic authority list.
  for (const relative of ["Vault/docs/architecture/bos-product-family.md", "Vault/docs/architecture/oracle-validation.md"]) {
    const filename = path.join(parent, relative);
    if (declarations.includes(filename)) files.push({path: filename, controlling: false});
  }
  return Promise.all(files.map(async (item) => ({...await fileBinding(root, item.path, {allowMissing: true}), external: true, controlling: item.controlling})));
}

async function vaultSources(root, relative = "Vault") {
  await pathCustody(root, relative, {allowFinalLink: false});
  const entries = await readdir(path.join(root, relative), {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (["index", "tmp"].includes(entry.name)) continue;
    const target = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Oracle canonical Vault contains a symbolic link: ${target}`);
    if (entry.isDirectory()) files.push(...await vaultSources(root, target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function evidenceBinding(root, value) {
  if (value === null) return null;
  let filename = value.startsWith("@") ? value.slice(1) : value;
  let custody;
  const absolute = path.resolve(root, filename), inside = absolute === path.resolve(root) || absolute.startsWith(`${path.resolve(root)}${path.sep}`);
  try { custody = await pathCustody(root, filename, {scopeRoot: inside ? root : null, allowFinalLink: false}); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENAMETOOLONG") throw error;
    if (value.startsWith("@")) throw new Error(`Oracle evidence file is missing: ${filename}`);
    return {value, sha256: contentHash(value), kind: "literal"};
  }
  if (custody.metadata?.type !== "regular") throw new Error(`Oracle evidence must be a regular file: ${filename}`);
  return {value, kind: "file", sha256: contentHash(await readFile(custody.resolved_path)), custody};
}

export async function captureInputs({root, base, tree = null, validationEvidence = [], ownerApprovalEvidence = null, proposal = null, complete = false, observedPaths = [], establishedObservedPaths = observedPaths, reviewerSettings = undefined}) {
  // Validate source custody before reading evidence which may name the same
  // file. A later link escape must never be followed through its evidence role.
  const observedSources = observedPaths.length ? await observedSourceBindings(root, observedPaths, {allowUnavailable: observedPaths.filter((name) => !establishedObservedPaths.includes(name))}) : [];
  // Hash the approver policy bytes without adopting or exposing its instructions.
  const policyFiles = ["AGENTS.md", "Vault/docs/CONSTITUTION.md", ".agents/skills/oracle/SKILL.md"];
  const files = complete ? [...new Set([...policyFiles, ...await vaultSources(root)])].sort() : policyFiles.sort();
  const [localAuthorities, externalAuthorities, validation, owner] = await Promise.all([
    Promise.all(files.map((filename) => fileBinding(root, filename))),
    declaredParentAuthorities(root),
    Promise.all(validationEvidence.map((value) => evidenceBinding(root, value))),
    evidenceBinding(root, ownerApprovalEvidence),
  ]);
  const authorities = [...localAuthorities, ...externalAuthorities];
  const tool_sha256 = bindingHash(await Promise.all(policyModules.map(async (name) => contentHash(await readFile(new URL(name, import.meta.url))))));
  return {schema: "my-crm.oracle-inputs/v2", tool_sha256, tool_source_files: policyModules, reviewer_policy_sha256: await currentPolicy(), reviewer_policy_version: await policyVersion(), base_commit: base, reviewed_tree: tree, authorities, validation, owner, proposal_sha256: proposal ? bindingHash(proposal) : null,
    ...(observedPaths.length ? {observed_sources: observedSources} : {}),
    ...(reviewerSettings === undefined ? {} : {reviewer_settings: reviewerSettings})};
}

export function assertInputsMatch(expected, actual) {
  if (bindingHash(expected) !== bindingHash(actual)) throw new Error("Oracle inputs drifted: base, tree, authority, evidence, proposal, or owner approval changed; fresh review is required");
}

export async function preparedEvidence(directory, inputs, prepare) {
  const key = bindingHash({version: 1, inputs});
  const cache = path.join(directory, "preparation", `${key}.json`);
  let previous;
  const owner = metadataScope.getStore()?.root ?? path.dirname(directory);
  try { previous = JSON.parse(await readMetadataFile(cache, "utf8", {root: owner})); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  if (previous?.key === key && typeof previous.sha256 === "string" && previous.payload !== undefined && previous.sha256 === bindingHash(previous.payload)) return {payload: previous.payload, reused: true};
  const payload = await prepare();
  await atomicJson(cache, {key, sha256: bindingHash(payload), payload}, {root: owner});
  return {payload, reused: false};
}
