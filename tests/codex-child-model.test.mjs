import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {selectedModel} from "../scripts/codex-child-model.mjs";

async function withEnvironment(values, run) {
  const keys = ["CODEX_HOME", "CODEX_THREAD_ID", "CODEX_SELECTED_MODEL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try { await run(); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("active task model wins a conflicting inherited hint", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-"));
  try {
    const sessions = path.join(home, "sessions", "2026", "09", "29");
    await mkdir(sessions, {recursive: true});
    await writeFile(path.join(sessions, "rollout-task-123.jsonl"), `${JSON.stringify({type: "turn_context", payload: {model: "gpt-6-sol"}})}\n`);
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "task-123", CODEX_SELECTED_MODEL: "gpt-6-astra"}, async () => assert.equal(await selectedModel(), "gpt-6-sol"));
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("ephemeral child inherits the explicitly propagated model", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-"));
  try {
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "task-123", CODEX_SELECTED_MODEL: "gpt-6-sol"}, async () => assert.equal(await selectedModel(), "gpt-6-sol"));
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("standalone CLI uses configured model", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-"));
  try {
    await writeFile(path.join(home, "config.toml"), 'model = "gpt-5.6-sol"\n');
    await withEnvironment({CODEX_HOME: home}, async () => assert.equal(await selectedModel(), "gpt-5.6-sol"));
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("unknown model fails closed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-"));
  try {
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "task-123"}, async () => assert.rejects(selectedModel(), /refusing to guess/));
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("inactive TOML profile model does not become the standalone default", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-model-"));
  try {
    await writeFile(path.join(home, "config.toml"), '[profiles.expensive]\nmodel = "gpt-6-astra"\n');
    await withEnvironment({CODEX_HOME: home}, async () => assert.rejects(selectedModel(), /No Codex task or configured model/));
  } finally { await rm(home, {recursive: true, force: true}); }
});
