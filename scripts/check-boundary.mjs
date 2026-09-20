import {lstat, readdir, readFile} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const ignored = new Set([".git", "node_modules", "dist", "coverage", "Vault"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const forbiddenEverywhere = [
  /(?:^|["'\s])\.\.\/(?:bos_operations_center|LeadDirector|lead-director)(?:\/|["'\s])/i,
  /\/Development\/Projects\/(?:bos|bos_operations_center|LeadDirector|lead-director)\//i,
  /"(?:file|workspace):[^"\n]+"/i
];
const obsoleteProductPatterns = [
  /mcp\/apps\/leaddirector\/crm/i,
  /bos\.fsm\/v1/i
];
const forbiddenSourcePatterns = [
  /bearer\s+[a-z0-9]/i,
  /\/bos\/apps\//i
];

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (ignored.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Repository symlink is forbidden: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) await walk(absolute, files);
    else files.push(absolute);
  }
  return files;
}

const failures = [];
for (const file of await walk(root)) {
  if (!textExtensions.has(path.extname(file))) continue;
  const relative = path.relative(root, file);
  const content = await readFile(file, "utf8");
  for (const pattern of forbiddenEverywhere) if (pattern.test(content)) failures.push(`${relative} matches repository-boundary pattern ${pattern}`);
  if (!relative.startsWith(`tests${path.sep}fixtures${path.sep}`) && !relative.startsWith(`Vault${path.sep}`)) {
    for (const pattern of obsoleteProductPatterns) if (pattern.test(content)) failures.push(`${relative} contains obsolete product behavior ${pattern}`);
  }
  if (relative.startsWith(`src${path.sep}`)) {
    for (const pattern of forbiddenSourcePatterns) if (pattern.test(content)) failures.push(`${relative} contains forbidden client state or route ${pattern}`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Repository and public-client boundary checks passed.");
