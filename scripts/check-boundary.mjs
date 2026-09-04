import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const ignored = new Set([".git", "node_modules", "dist", "coverage", "Vault"]);
const textExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx", ".yaml", ".yml"]);
const forbidden = [
  /(?:^|["'\s])\.\.\/(?:bos_operations_center|LeadDirector|lead-director)(?:\/|["'\s])/i,
  /\/Development\/Projects\/(?:bos_operations_center|LeadDirector|lead-director)\//i,
  /"(?:file|workspace):[^"\n]+"/i
];

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
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
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) failures.push(`${path.relative(root, file)} matches ${pattern}`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Repository boundary check passed.");
}
