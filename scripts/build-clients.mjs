import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {buildMuse} from "./build-muse.mjs";
import {readJson, repositoryRoot, sha256File, stableJson, walkFiles} from "./release-utils.mjs";

export const clientsDirectory = path.join(repositoryRoot, "clients");
export const clientPackages = Object.freeze({
  claude: "claude/plugins/my-crm",
  codex: "codex/plugins/my-crm",
  copilot: "copilot/products/my-crm",
  gemini: "gemini/extensions/my-crm",
  muse: "muse/plugins/my-crm"
});
const instructions = {
  claude: ["claude plugin marketplace add ./clients/claude", "claude plugin install my-crm@my-crm"],
  codex: ["codex plugin marketplace add ./clients/codex", "codex plugin add my-crm@my-crm"],
  copilot: ["copilot plugin install ./clients/copilot/products/my-crm"],
  gemini: ["gemini extensions install ./clients/gemini/extensions/my-crm"],
  muse: ["muse plugins validate clients/muse/plugins/my-crm", "muse plugins install clients/muse/plugins/my-crm"]
};

async function writeJson(root, file, value) {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, stableJson(value));
}

export async function buildClients({destination = clientsDirectory} = {}) {
  const source = path.join(repositoryRoot, "plugins/my-crm");
  const codex = await readJson(path.join(source, ".codex-plugin/plugin.json"));
  const claude = await readJson(path.join(source, ".claude-plugin/plugin.json"));
  const metadata = await readJson(path.join(source, ".bos-product.json"));
  for (const [client, relative] of Object.entries(clientPackages)) {
    const target = path.join(destination, relative);
    if (client === "muse") await buildMuse({destination: target});
    else {
      await rm(target, {recursive: true, force: true});
      await mkdir(target, {recursive: true});
      for (const entry of ["skills", "assets"]) await cp(path.join(source, entry), path.join(target, entry), {recursive: true});
      for (const entry of ["LICENSE", "NOTICE"]) await cp(path.join(repositoryRoot, entry), path.join(target, entry));
      await writeJson(target, ".bos-product.json", {...metadata, client});
      if (client === "claude") await writeJson(target, ".claude-plugin/plugin.json", claude);
      if (client === "codex") await writeJson(target, ".codex-plugin/plugin.json", codex);
      if (client === "copilot") await writeJson(target, "plugin.json", {
        name: codex.name, version: codex.version, description: codex.description,
        author: codex.author, license: codex.license, skills: "./skills/"
      });
      if (client === "gemini") {
        await writeJson(target, "gemini-extension.json", {name: codex.name, version: codex.version, description: codex.description});
        await writeJson(target, "plugin.json", {$schema: "https://antigravity.google/schemas/v1/plugin.json", name: codex.name, description: `${codex.description}. Version ${codex.version}.`});
      }
      await writeFile(path.join(target, "README.md"), [
        `# My CRM for ${client}`, "", codex.description, "",
        "Install the published BOS product for this host first. My CRM uses its existing BOS connection.",
        "This package includes eight complete skills and their references; it declares no MCP server, login, or credentials.", "",
        "Installation commands, host format references, skill-content guidance, and acceptance status are in the release's root README under Supported clients.", ""
      ].join("\n"));
    }
    await writeFile(path.join(destination, client, "README.md"), [
      `# My CRM ${client} distribution`, "", `Package: \`${relative.slice(client.length + 1)}\`.`, "",
      "Install BOS for this host first. From a published My CRM release checkout:", "", "```bash", ...instructions[client], "```", "",
      "Restart the host and confirm all eight My CRM skills are available. Use the root README for native verification and update guidance.", "",
      "SKILL.md supplies the instructions. agents/openai.yaml is optional Codex UI metadata; these packages retain it with the complete source trees.", ""
    ].join("\n"));
  }
  await writeJson(destination, "claude/.claude-plugin/marketplace.json", {
    name: "my-crm", owner: {name: codex.author.name},
    plugins: [{name: "my-crm", source: "./plugins/my-crm", description: codex.description}]
  });
  await writeJson(destination, "codex/.agents/plugins/marketplace.json", {
    name: "my-crm", interface: {displayName: "My CRM"},
    plugins: [{name: "my-crm", source: {source: "local", path: "./plugins/my-crm"},
      policy: {installation: "AVAILABLE", authentication: "ON_USE"}, category: "Productivity"}]
  });
  return clientPackages;
}

export async function checkClients({directory = clientsDirectory} = {}) {
  const expected = await mkdtemp(path.join(os.tmpdir(), "my-crm-clients-"));
  try {
    await buildClients({destination: expected});
    const wanted = await walkFiles(expected);
    const actual = await walkFiles(directory);
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error("Client package inventory drift");
    for (const file of wanted) {
      if (await sha256File(path.join(directory, file)) !== await sha256File(path.join(expected, file))) throw new Error(`Client package source drift: ${file}`);
    }
    return clientPackages;
  } finally {
    await rm(expected, {recursive: true, force: true});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packages = process.argv.includes("--check") ? await checkClients() : await buildClients();
  console.log(`My CRM client packages: ${Object.keys(packages).join(", ")}.`);
}
