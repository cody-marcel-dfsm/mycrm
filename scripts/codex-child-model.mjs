import {createReadStream} from "node:fs";
import {readFile, readdir, stat} from "node:fs/promises";
import {createInterface} from "node:readline";
import os from "node:os";
import path from "node:path";

async function matchingSessions(directory, threadId) {
  const matches = [];
  for (const entry of await readdir(directory, {withFileTypes: true}).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...await matchingSessions(fullPath, threadId));
    else if (entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`)) matches.push(fullPath);
  }
  return matches;
}

export async function selectedModel() {
  const inherited = process.env.CODEX_SELECTED_MODEL?.trim();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const threadId = process.env.CODEX_THREAD_ID;
  if (threadId) {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) throw new Error("Invalid CODEX_THREAD_ID; refusing to start a child model");
    const sessions = await matchingSessions(path.join(codexHome, "sessions"), threadId);
    if (sessions.length) {
      const dated = await Promise.all(sessions.map(async (filename) => ({filename, modified: (await stat(filename)).mtimeMs})));
      dated.sort((a, b) => b.modified - a.modified);
      let model;
      const lines = createInterface({input: createReadStream(dated[0].filename, {encoding: "utf8"}), crlfDelay: Infinity});
      for await (const line of lines) {
        if (!line.includes('"turn_context"')) continue;
        const event = JSON.parse(line);
        const candidate = event.type === "turn_context" ? event.payload?.model : undefined;
        if (typeof candidate === "string" && candidate.trim()) model = candidate.trim();
      }
      if (model) return model;
      throw new Error("Active Codex task has no selected model; refusing to guess");
    }
    if (inherited) return inherited;
    throw new Error("Active Codex task session was not found; refusing to guess its model");
  }
  if (inherited) return inherited;
  const config = await readFile(path.join(codexHome, "config.toml"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  // A profile table can contain `model`; it is inactive without profile selection.
  const topLevel = config.split(/^\s*\[/m, 1)[0];
  const model = topLevel.match(/^model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1]?.trim();
  if (model) return model;
  throw new Error("No Codex task or configured model; refusing to start a child model");
}
