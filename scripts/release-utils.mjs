import {createHash} from "node:crypto";
import {lstat, readFile, readdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

export const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256File(file) {
  return sha256(await readFile(file));
}

export async function walkFiles(root, directory = root, files = []) {
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in release artifacts: ${path.relative(root, absolute)}`);
    if (entry.isDirectory()) await walkFiles(root, absolute, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`Unsupported release artifact entry: ${path.relative(root, absolute)}`);
  }
  return files;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertSafeRelativePath(value, label = "path") {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  const normalized = path.posix.normalize(value.replace(/^\.\//, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${label} must not escape its bundle root`);
  }
  return normalized;
}
