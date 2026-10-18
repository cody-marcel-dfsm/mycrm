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

export async function selectedSettings() {
  const inherited = process.env.CODEX_SELECTED_MODEL?.trim();
  // A present empty value is the launcher's explicit-default sentinel.
  // Absence leaves configuration fallback available for an unspecified hint.
  const inheritedEffort = Object.hasOwn(process.env, "CODEX_SELECTED_REASONING_EFFORT") ? process.env.CODEX_SELECTED_REASONING_EFFORT.trim() || null : undefined;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configured = async () => {
    const config = await readFile(path.join(codexHome, "config.toml"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    // Inactive profile tables supply neither selected models nor effort.
    const topLevel = config.split(/^\s*\[/m, 1)[0];
    const value = (key) => topLevel.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, "m"))?.[1]?.trim();
    return {model: value("model"), reasoning_effort: value("model_reasoning_effort") ?? null};
  };
  const withEffort = async (model, effort) => ({model, reasoning_effort: effort === undefined ? inheritedEffort === undefined ? (await configured()).reasoning_effort : inheritedEffort : effort});
  const threadId = process.env.CODEX_THREAD_ID;
  if (threadId) {
    if (!/^[A-Za-z0-9-]+$/.test(threadId)) throw new Error("Invalid CODEX_THREAD_ID; refusing to start a child model");
    const sessions = await matchingSessions(path.join(codexHome, "sessions"), threadId);
    if (sessions.length) {
      const dated = await Promise.all(sessions.map(async (filename) => ({filename, modified: (await stat(filename)).mtimeMs})));
      dated.sort((a, b) => b.modified - a.modified);
      let model, effort;
      const lines = createInterface({input: createReadStream(dated[0].filename, {encoding: "utf8"}), crlfDelay: Infinity});
      for await (const line of lines) {
        if (!line.includes('"turn_context"')) continue;
        const event = JSON.parse(line);
        if (event.type !== "turn_context") continue;
        const candidate = event.payload?.model;
        if (typeof candidate === "string" && candidate.trim()) model = candidate.trim();
        // Use the latest turn's explicit default as well as named effort;
        // earlier turns and inherited hints cannot override that selection.
        const key = ["effort", "reasoning_effort", "reasoningEffort"].find((name) => Object.hasOwn(event.payload ?? {}, name));
        const value = key ? event.payload[key] : undefined;
        if (value !== undefined && value !== null && (typeof value !== "string" || !value.trim())) throw new Error("Active Codex task has invalid reasoning effort; refusing to guess");
        effort = typeof value === "string" ? value.trim() : value;
      }
      if (model) return withEffort(model, effort);
      throw new Error("Active Codex task has no selected model; refusing to guess");
    }
    if (inherited) return withEffort(inherited);
    throw new Error("Active Codex task session was not found; refusing to guess its model");
  }
  if (inherited) return withEffort(inherited);
  const config = await configured();
  if (config.model) return {model: config.model, reasoning_effort: inheritedEffort === undefined ? config.reasoning_effort : inheritedEffort};
  throw new Error("No Codex task or configured model; refusing to start a child model");
}

export async function selectedModel() { return (await selectedSettings()).model; }
