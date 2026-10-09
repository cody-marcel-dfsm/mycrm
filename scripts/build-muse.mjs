import {cp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {readJson, repositoryRoot, sha256File, stableJson, walkFiles} from "./release-utils.mjs";

export const museDirectory = path.join(repositoryRoot, "clients/muse/plugins/my-crm");

async function museSources() {
  const source = path.join(repositoryRoot, "plugins/my-crm");
  const plugin = await readJson(path.join(source, ".codex-plugin/plugin.json"));
  const metadata = await readJson(path.join(source, ".bos-product.json"));
  const files = await walkFiles(path.join(source, "skills"));
  const skills = files.filter((file) => /^[^/]+\/SKILL\.md$/.test(file)).map((file) => ({
    id: file.split("/")[0], path: `skills/${file}`, enabledDefault: true
  }));
  return {source, metadata: {...metadata, client: "muse"}, manifest: {
    schemaVersion: 1, name: plugin.name, displayName: plugin.interface.displayName,
    version: plugin.version, description: plugin.interface.longDescription,
    compat: {source: "native", manifestDir: ".muse-plugin"},
    capabilities: {skills},
    meta: {brandColor: plugin.interface.brandColor, logo: "assets/my-crm-logo.png", dependencies: ["bos"]}
  }};
}

export async function buildMuse({destination = museDirectory} = {}) {
  const {source, metadata, manifest} = await museSources();
  await rm(destination, {recursive: true, force: true});
  await mkdir(path.join(destination, ".muse-plugin"), {recursive: true});
  for (const entry of ["skills", "assets"]) await cp(path.join(source, entry), path.join(destination, entry), {recursive: true});
  for (const entry of ["LICENSE", "NOTICE"]) await cp(path.join(repositoryRoot, entry), path.join(destination, entry));
  await writeFile(path.join(destination, ".muse-plugin/plugin.json"), stableJson(manifest));
  await writeFile(path.join(destination, ".bos-product.json"), stableJson(metadata));
  await writeFile(path.join(destination, "README.md"), [
    "# My CRM for Muse Code", "", "![My CRM](assets/my-crm-logo.png)", "", manifest.description, "",
    "Install the independently distributed BOS Muse product first and complete its native connection setup.",
    "My CRM uses that single BOS connection and adds no MCP registration, login, or credentials.", "",
    "From a published My CRM release checkout, run:", "", "```bash",
    "muse plugins validate clients/muse/plugins/my-crm",
    "muse plugins install clients/muse/plugins/my-crm",
    "muse plugins list", "```", "",
    "Start a new Muse session and check `/skills` for the eight My CRM skills.",
    "For updates, sync the published release, run `muse plugins update my-crm`, and start a new session.",
    "Use `muse plugins inspect my-crm` to inspect the installed version and enabled skills.",
    "Package source checks do not establish native login, authenticated operation, or live service readiness.", "",
    "Manifest reference: https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/manifest/", ""
  ].join("\n"));
  return manifest;
}

export async function checkMuse({directory = museDirectory} = {}) {
  const {source, metadata, manifest} = await museSources();
  for (const [file, expected] of [[".muse-plugin/plugin.json", manifest], [".bos-product.json", metadata]]) {
    if (await readFile(path.join(directory, file), "utf8") !== stableJson(expected)) throw new Error(`Muse package drift: ${file}`);
  }
  const owned = [];
  for (const entry of ["skills", "assets"]) {
    for (const file of await walkFiles(path.join(source, entry))) {
      const relative = `${entry}/${file}`;
      owned.push(relative);
      if (await sha256File(path.join(source, relative)) !== await sha256File(path.join(directory, relative))) throw new Error(`Muse source drift: ${relative}`);
    }
  }
  const allowed = new Set([...owned, ".muse-plugin/plugin.json", ".bos-product.json", "README.md", "LICENSE", "NOTICE"]);
  for (const file of await walkFiles(directory)) if (!allowed.has(file)) throw new Error(`Unexpected Muse package file: ${file}`);
  for (const entry of ["LICENSE", "NOTICE"]) {
    if (await sha256File(path.join(directory, entry)) !== await sha256File(path.join(repositoryRoot, entry))) throw new Error(`Muse source drift: ${entry}`);
  }
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = process.argv.includes("--check") ? await checkMuse() : await buildMuse();
  console.log(`My CRM Muse package: ${manifest.capabilities.skills.length} skills, version ${manifest.version}.`);
}
