import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("../Vault", import.meta.url).pathname);
const action = process.argv[2];

async function markdownFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["index", "tmp"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await markdownFiles(absolute, files);
    else if (entry.name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

async function sync() {
  const files = await markdownFiles(root);
  const documents = [];
  for (const absolute of files.sort()) {
    const content = await readFile(absolute, "utf8");
    documents.push({
      path: path.relative(root, absolute),
      sha256: createHash("sha256").update(content).digest("hex"),
      title: content.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(absolute),
      bytes: Buffer.byteLength(content)
    });
  }
  const directory = path.join(root, "index", "manifests");
  await mkdir(directory, { recursive: true });
  const manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), documents };
  await writeFile(path.join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Indexed ${documents.length} Vault documents.`);
}

async function query(term) {
  if (!term) throw new Error("Usage: npm run vault:query -- <search term>");
  const normalized = term.toLocaleLowerCase();
  let matches = 0;
  for (const absolute of await markdownFiles(root)) {
    const content = await readFile(absolute, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (line.toLocaleLowerCase().includes(normalized)) {
        console.log(`${path.relative(root, absolute)}:${index + 1}: ${line.trim()}`);
        matches += 1;
      }
    });
  }
  if (!matches) console.log("No matches.");
}

if (action === "sync") await sync();
else if (action === "query") await query(process.argv.slice(3).join(" "));
else {
  console.error("Usage: node scripts/vault.mjs <sync|query> [term]");
  process.exitCode = 1;
}
