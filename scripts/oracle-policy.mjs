// Derive policy from the actual emitted instruction/schema construction. Never
// execute historical JavaScript to infer a prior reviewer's policy.
import {readFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash} from "node:crypto";

const execute = promisify(execFile);
export const policyModules = ["oracle-inputs.mjs", "oracle-review.mjs", "oracle-series.mjs", "oracle-validation.mjs", "oracle-command-tracking.mjs", "oracle-policy.mjs", "codex-child-model.mjs", "oracle-deployment.mjs", "shipment-state.mjs", "oracle-parallel.mjs", "oracle-lifecycle.mjs", "oracle-attempt.mjs", "oracle-bootstrap.mjs", "oracle-source-packet.mjs", "publication-checkpoint.mjs", "validation-transport.mjs"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function expression(source, start, closing = ";") {
  let quote = null, depth = 0;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === "/" && source[index + 1] === "/") { index = source.indexOf("\n", index); if (index < 0) break; continue; }
    if (character === "/" && source[index + 1] === "*") { const end = source.indexOf("*/", index + 2); if (end < 0) break; index = end + 1; continue; }
    if (character === closing && depth === 0) return source.slice(start, index);
    if ("([{".includes(character)) depth++;
    if (")]}".includes(character)) depth--;
    if (depth < 0) throw new Error("Ambiguous reviewer policy construction");
  }
  throw new Error("Unterminated reviewer policy construction");
}

function declarations(source, name, count = 1) {
  const matches = [...source.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=`, "g"))];
  if (matches.length !== count) throw new Error(`Cannot establish complete reviewer policy: ${name}`);
  return matches.map((match) => expression(source, match.index + match[0].length).trim());
}

// Mask comments and literal text while retaining template substitutions. The
// extractor accepts static declarations/builders and rejects mutable policy
// construction rather than treating an unrecognized shape as equivalent.
function codeMask(source) {
  let result = "", index = 0;
  const blank = (value) => value.replace(/[^\n]/g, " ");
  while (index < source.length) {
    const start = index, character = source[index];
    if (source.startsWith("//", index)) { index = source.indexOf("\n", index); if (index < 0) index = source.length; result += blank(source.slice(start, index)); }
    else if (source.startsWith("/*", index)) { const end = source.indexOf("*/", index + 2); if (end < 0) throw new Error("Unterminated policy comment"); index = end + 2; result += blank(source.slice(start, index)); }
    else if (["'", '"', "`"].includes(character)) {
      const quote = character; result += " "; index++;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") { result += "  "; index += 2; }
        else if (quote === "`" && source.startsWith("${", index)) {
          const body = expression(source, index + 2, "}");
          result += "  " + codeMask(body) + " "; index += body.length + 3;
        } else { result += blank(source[index]); index++; }
      }
      if (index === source.length) throw new Error("Unterminated policy literal");
      result += " "; index++;
    } else { result += character; index++; }
  }
  return result;
}

function directArguments(source) {
  const masked = codeMask(source), stack = []; let visible = "";
  for (let index = 0; index < masked.length; index++) {
    const character = masked[index];
    if (character === "(") visible = visible.replace(/[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*$/, (value) => " ".repeat(value.length));
    if ("([{".includes(character)) stack.push({character, callback: character === "{" && /=>\s*$/.test(masked.slice(0, index))});
    if (")]}".includes(character)) stack.pop();
    visible += stack.some((item) => item.character === "(" || item.callback) ? " " : character;
  }
  return visible;
}

function policyConstruction(source, names, promptCount = 0, externalNames = []) {
  const masked = codeMask(source), material = {}, guarded = new Set(names), allowed = new Set();
  if (promptCount) guarded.add("prompt");
  for (const name of guarded) {
    material[name] = declarations(source, name, name === "prompt" ? promptCount : 1);
    for (const match of masked.matchAll(new RegExp(`\\bconst\\s+(${name})\\s*=`, "g"))) allowed.add(match.index + match[0].indexOf(name));
  }
  const providers = ["JSON", "Object", "process", "path", "spawn", "execOracle", "runParallelReview", "Ajv", "selectedModel", "Reflect"];
  externalNames.concat(providers).forEach((name) => guarded.add(name));
  const aliasRoots = Object.fromEntries(providers.map((name) => [name, name]));
  const providerImports = [];
  const expected = {process: "node:process", path: "node:path", spawn: "node:child_process", Ajv: "ajv", selectedModel: "./codex-child-model.mjs", runParallelReview: "./oracle-parallel.mjs"};
  for (const match of masked.matchAll(/\bimport\s+[^;]+;/g)) {
    const statement = source.slice(match.index, match.index + match[0].length);
    const module = statement.match(/\bfrom\s*["']([^"']+)["']/)?.[1];
    for (const name of providers) if (new RegExp(`\\b${name}\\b`).test(match[0])) {
      if (!expected[name] || module !== expected[name]) throw new Error("Unsupported reviewer policy provider import");
      providerImports.push(statement);
    }
  }
  for (const name of providers) {
    const definitions = [...masked.matchAll(new RegExp(`\\b(?:function|class)\\s+${name}\\b`, "g"))];
    if (new RegExp(`\\b(?:const|let|var)\\s+${name}\\b|\\b${name}\\s*=>`).test(masked) || [...masked.matchAll(/(?:\bfunction\s*[A-Za-z_$]*|\bcatch)\s*\(([^)]*)\)|\(([^()]*)\)\s*=>/g)].some((match) => new RegExp(`\\b${name}\\b`).test((match[1] ?? match[2]).split(",").map((part) => part.split("=")[0]).join(",")))) throw new Error(`Unsupported reviewer policy provider parameter/binding: ${name}`);
    if (definitions.length && !(name === "execOracle" && definitions.length === 1)) throw new Error("Unsupported reviewer policy provider shadow binding");
  }
  const runtime = new Set(["run", "request", "candidate", "proposalRecord", "validationEvidence", "ownerApprovalEvidence", "model", "schemaPath", "outputPath", "args"]);
  const pending = Object.values(material).flat().flatMap((value) => [...codeMask(value).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b(?!\s*:)/g)].map((match) => match[1]));
  const builders = {};
  while (pending.length) {
    const name = pending.pop(); if (guarded.has(name) || runtime.has(name) || Object.hasOwn(builders, name)) continue;
    const constant = [...masked.matchAll(new RegExp(`\\bconst\\s+${name}\\s*=`, "g"))];
    const functions = [...masked.matchAll(new RegExp(`\\bfunction\\s+${name}\\s*\\(`, "g"))];
    if (!constant.length && !functions.length) {
      if (new RegExp(`\\b(?:let|var|class)\\s+${name}\\b|\\bimport[^;]*\\b${name}\\b`).test(masked) && !["path", "reviewSeriesPolicy", "reviewSeriesSchemaProperties", "seriesFindingSchema"].includes(name)) throw new Error("Unsupported imported or mutable reviewer policy builder");
      if (!["const", "function", "return", "export", "async", "await", "new", "true", "false", "null", "undefined", "this"].includes(name)) throw new Error(`Unsupported free reviewer policy builder: ${name}`);
      continue;
    }
    if (constant.length + functions.length !== 1) throw new Error("Ambiguous local reviewer policy builder");
    let body;
    if (constant.length) {
      const match = constant[0]; body = expression(source, match.index + match[0].length).trim();
      if (/=>|\b(?:function|class)\b/.test(codeMask(body))) throw new Error("Dynamic local policy builders require explicit complete construction binding");
      allowed.add(match.index + match[0].indexOf(name));
    } else {
      const match = functions[0], start = masked.indexOf("{", match.index + match[0].length);
      body = source.slice(match.index, start + 1) + expression(source, start + 1, "}") + "}";
      const simple = codeMask(body).replace(/\s/g, "");
      if (simple !== `function${name}(){return;}`) throw new Error("Dynamic local policy builder control/call construction is unsupported");
    }
    builders[name] = body; guarded.add(name);
    pending.push(...[...codeMask(body).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b(?!\s*:)/g)].map((match) => match[1]));
  }
  const aliases = {};
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const match of masked.matchAll(/(?<![.\w$])(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)(?:\s*\.[A-Za-z_$][\w$]*|\s*\[[^\]]*\])*\s*;/g)) {
      if (guarded.has(match[2]) && !guarded.has(match[1])) {
        guarded.add(match[1]); aliasRoots[match[1]] = aliasRoots[match[2]] ?? match[2]; aliases[match[1]] = source.slice(match.index, match.index + match[0].length);
        allowed.add(match.index + match[0].indexOf(match[1])); expanded = true;
      }
    }
    for (const match of masked.matchAll(/(?:\b(?:const|let|var)\s+|(?:^|[;{}])\s*)([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)) {
      const target = match[1]; if (guarded.has(target)) continue;
      let value; try { value = expression(source, match.index + match[0].length); } catch { continue; }
      const visible = directArguments(value).replace(/\b(?:JSON\.(?:stringify|parse)|Object\.(?:keys|values|entries|fromEntries|hasOwn|freeze)|path\.(?:isAbsolute|join|relative|resolve|dirname|basename|sep|delimiter)|process\.(?:version|platform|arch|execPath|exitCode)|selectedModel)\b/g, "");
      const root = [...guarded].find((name) => (providers.includes(name) || Object.hasOwn(aliasRoots, name)) && new RegExp(`(?<![.\\w$])${name}\\b(?!\\s*:)`).test(visible));
      if (root) { guarded.add(target); allowed.add(match.index + match[0].indexOf(target)); aliases[target] = value; aliasRoots[target] = aliasRoots[root] ?? root; expanded = true; }
    }
  }
  const readMethods = new Set(["JSON.stringify", "JSON.parse", "Object.keys", "Object.values", "Object.entries", "Object.fromEntries", "Object.hasOwn", "Object.freeze", "process.cwd", "process.once", "process.on", "process.removeListener", "process.stdout.write", "process.stderr.write", "process.argv.slice", "path.isAbsolute", "path.join", "path.relative", "path.resolve", "path.dirname", "path.basename"]);
  const calls = [...masked.matchAll(/\b(Object\.(?:assign|defineProperty|defineProperties)|Reflect\.(?:set|deleteProperty)|[A-Za-z_$][\w$]*)\s*\(/g)].map((call) => {
    const body = expression(source, call.index + call[0].length, ")");
    const receiver = masked.slice(0, call.index).match(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.$/)?.[1];
    const canonicalCall = receiver ? `${aliasRoots[receiver] ?? receiver}.${call[1]}` : call[1];
    const direct = directArguments(body).replace(/\b(?:JSON\.(?:stringify|parse)|Object\.(?:keys|values|entries|fromEntries|hasOwn|freeze)|path\.(?:isAbsolute|join|relative|resolve|dirname|basename|sep|delimiter)|process\.(?:version|platform|arch|execPath|exitCode)|selectedModel)\b/g, "");
    return {name: call[1], canonicalCall, arguments: new Set([...direct.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\b(?!\s*:)/g)].map((item) => item[1])), prefix: masked.slice(Math.max(0, call.index - 10), call.index)};
  });
  for (const name of guarded) {
    if (new RegExp(`(?:\\b(?:const|let|var)\\s+|(?:^|;)\\s*\\(?)[\\[{][^;]*?=\\s*[\\[({]*\\s*${name}\\b(?:\\s*\\.[A-Za-z_$][\\w$]*|\\s*\\[[^\\]]*\\])*\\s*[\\])}]*\\s*(?:;|$)`).test(masked)) throw new Error(`Unsupported destructured reviewer policy alias: ${name}`);
    const target = `\\b${name}(?:\\s*\\.[A-Za-z_$][\\w$]*|\\s*\\[[^\\]]*\\])*`;
    for (const match of masked.matchAll(new RegExp(`${target}\\s*(?:\\+\\+|--|(?:\\*\\*|&&|\\|\\||\\?\\?|[+*/%&|^<>-])?=(?!=|>))`, "g"))) {
      const targetName = match[0].match(/^[^=+*/%&|^<>-]+/)?.[0].replace(/\s/g, "");
      if (!allowed.has(match.index) && !(targetName === "process.exitCode" && !match[0].includes("["))) throw new Error("Unsupported post-assignment reviewer policy mutation");
    }
    if (new RegExp(`(?:\\bdelete\\s+|\\+\\+|--)${target}`).test(masked)) throw new Error("Unsupported reviewer policy member mutation");

    for (const call of masked.matchAll(new RegExp(`(${target}\\s*(?:\\.[A-Za-z_$][\\w$]*|\\[[^\\]]*\\])\\s*(?:\\?\\.)?)\\(`, "g"))) {
      const method = call[1].replace(/\s/g, "").replace(new RegExp(`^${name}\\b`), aliasRoots[name] ?? name);
      if (!readMethods.has(method)) throw new Error(`Unsupported reviewer policy provider or alias method: ${method}`);
    }
    for (const call of calls) {
      if (!readMethods.has(call.canonicalCall) && call.arguments.has(name) && !["Object.keys", "JSON.stringify", "keys", "stringify", "sha256", "recordReviewer", "validate", "execOracle", "spawn"].includes(call.name) && !guarded.has(call.name)) {
        if (!/function\s*$/.test(call.prefix) && !["if", "switch", "for", "while", "catch"].includes(call.name)) throw new Error(`Unsupported call receiving reviewer policy: ${call.name}(${name})`);
      }
    }
  }
  if (/\b(?:eval|Function|import|require)\s*\(|\bcreateRequire\b|\b(?:globalThis|global)\b|\]\s*(?:\?\.)?\(/.test(masked)) throw new Error("Reflective reviewer policy construction is unsupported");
  return {declarations: material, builders, aliases, provider_imports: [...new Set(providerImports)]};
}

const policyCache = new Map();
export function policyFingerprint(review, series, implementation) {
  if (!implementation || Object.keys(implementation).sort().join() !== [...policyModules].sort().join() || implementation["oracle-review.mjs"] !== review || implementation["oracle-series.mjs"] !== series) throw new Error("Incomplete declared reviewer policy implementation closure");
  const key = hash(canonical([review, series, implementation]));
  if (policyCache.has(key)) return policyCache.get(key);
  const material = {
    review: policyConstruction(review, ["trustedReviewerRole", "localExecutionPolicy", "apiVersionRequestPolicy", "apiVersionAssessmentSchema", "responseSchema"], 2, ["reviewSeriesPolicy", "reviewSeriesSchemaProperties", "seriesFindingSchema"]),
    series: policyConstruction(series, ["reviewSeriesPolicy", "text", "strings", "dependencyFields", "reviewSeriesSchemaProperties", "seriesFindingSchema"]),
  };
  const launches = [...review.matchAll(/\b(?:spawn|execOracle)\(/g)];
  material.launches = launches.filter((match) => !review.slice(Math.max(0, match.index - 16), match.index).match(/function\s+$/)).map((match) => expression(review, match.index + match[0].length, ")"));
  if (material.launches.length !== 4) throw new Error("Cannot establish complete reviewer launch policy");
  // An imported provider can mutate emitters through arbitrary side effects,
  // including calls with no provider argument. Alias inspection cannot prove
  // that closure. Bind the complete ordered controlling emission modules for
  // import-bearing construction, including launcher argument transformations.
  // Extractor-only repairs still rederive both originals from verified Git
  // bytes; ordinary product observations retain their scoped dependencies.
  const imported = [review, series].some((value) => /\bimport\b/.test(codeMask(value)));
  if (imported) material.complete_emission_modules = {review, series};
  // Existing imports also execute their own implementation side effects. Bind
  // the declared local governance closure in full, without provider inference.
  material.complete_local_implementation_closure = policyModules.map((name) => [name, implementation[name]]);
  const fingerprint = hash(canonical(material));
  policyCache.set(key, fingerprint);
  if (policyCache.size > 64) policyCache.delete(policyCache.keys().next().value);
  return fingerprint;
}

export async function policyVersion() { return hash(await readFile(new URL("./oracle-policy.mjs", import.meta.url))); }

export async function currentPolicy() {
  const sources = Object.fromEntries(await Promise.all(policyModules.map(async (name) => [name, await readFile(new URL(name, import.meta.url), "utf8")])));
  return policyFingerprint(sources["oracle-review.mjs"], sources["oracle-series.mjs"], sources);
}

export async function legacyPolicy(snapshot, root) {
  try {
    const names = policyModules;
    const sources = await Promise.all(names.map(async (name) => {
      const relative = `scripts/${name}`;
      const {stdout: blob} = await execute("git", ["rev-parse", `${snapshot.tree}:${relative}`], {cwd: root});
      if (snapshot.files[relative] !== blob.trim()) throw new Error("Historical policy source does not match original candidate");
      const {stdout} = await execute("git", ["show", `${snapshot.tree}:${relative}`], {cwd: root, maxBuffer: 4 * 1024 * 1024});
      return {name, source: stdout, sha256: hash(stdout), git_blob: blob.trim()};
    }));
    const originalTools = snapshot.tool_binding_sha256 ?? snapshot.context.tool_sha256;
    const legacyNames = snapshot.tool_source_files ?? (snapshot.files["scripts/oracle-policy.mjs"] ? names.slice(0, 5) : names.slice(0, 4));
    if (legacyNames.some((name) => !names.includes(name)) || originalTools && hash(canonical(legacyNames.map((name) => sources.find((item) => item.name === name).sha256))) !== originalTools) throw new Error("Historical tooling provenance does not match original inputs");
    const implementation = Object.fromEntries(sources.map((item) => [item.name, item.source]));
    return {sha256: policyFingerprint(implementation["oracle-review.mjs"], implementation["oracle-series.mjs"], implementation), provenance: "verified-prior-git-blobs", tree: snapshot.tree, sources: sources.map(({source: _ignored, ...item}) => item)};
  } catch (error) { return {sha256: null, provenance: "unavailable-prior-policy-source", reason: error.message}; }
}
