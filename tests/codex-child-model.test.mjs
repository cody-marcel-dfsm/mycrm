import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {selectedModel, selectedSettings} from "../scripts/codex-child-model.mjs";

async function withEnvironment(values, run) {
  const keys = ["CODEX_HOME", "CODEX_THREAD_ID", "CODEX_SELECTED_MODEL", "CODEX_SELECTED_REASONING_EFFORT"];
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

test("latest active task settings preserve selected effort and explicit default over inherited hints", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-settings-"));
  try {
    const sessions = path.join(home, "sessions"); await mkdir(sessions);
    const filename = path.join(sessions, "rollout-task-123.jsonl");
    const turns = [{model: "synthetic-model", effort: "medium"}, {model: "synthetic-model", effort: "high"}];
    await writeFile(filename, turns.map(payload => JSON.stringify({type: "turn_context", payload})).join("\n") + "\n");
    await writeFile(path.join(home, "config.toml"), 'model_reasoning_effort = "low"\n');
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "task-123", CODEX_SELECTED_MODEL: "other-model", CODEX_SELECTED_REASONING_EFFORT: "minimal"}, async () => {
      assert.deepEqual(await selectedSettings(), {model: "synthetic-model", reasoning_effort: "high"});
      await writeFile(filename, JSON.stringify({type: "turn_context", payload: {model: "synthetic-model", effort: null}}) + "\n");
      assert.deepEqual(await selectedSettings(), {model: "synthetic-model", reasoning_effort: null});
    });
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("ephemeral and standalone settings retain explicit effort and ignore inactive profile values", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-settings-"));
  try {
    await writeFile(path.join(home, "config.toml"), 'model = "synthetic-model"\nmodel_reasoning_effort = "medium"\n[profiles.inactive]\nmodel_reasoning_effort = "high"\n');
    await withEnvironment({CODEX_HOME: home}, async () => assert.deepEqual(await selectedSettings(), {model: "synthetic-model", reasoning_effort: "medium"}));
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "ephemeral", CODEX_SELECTED_MODEL: "inherited-model", CODEX_SELECTED_REASONING_EFFORT: "low"}, async () => assert.deepEqual(await selectedSettings(), {model: "inherited-model", reasoning_effort: "low"}));
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "ephemeral", CODEX_SELECTED_MODEL: "inherited-model", CODEX_SELECTED_REASONING_EFFORT: ""}, async () => assert.deepEqual(await selectedSettings(), {model: "inherited-model", reasoning_effort: null}));
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "ephemeral", CODEX_SELECTED_MODEL: "inherited-model"}, async () => assert.deepEqual(await selectedSettings(), {model: "inherited-model", reasoning_effort: "medium"}));
  } finally { await rm(home, {recursive: true, force: true}); }
});

test("malformed active reasoning effort fails before child selection", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-settings-"));
  try {
    const sessions = path.join(home, "sessions"); await mkdir(sessions);
    await writeFile(path.join(sessions, "rollout-task-123.jsonl"), JSON.stringify({type: "turn_context", payload: {model: "synthetic-model", effort: {unexpected: true}}}) + "\n");
    await withEnvironment({CODEX_HOME: home, CODEX_THREAD_ID: "task-123"}, async () => assert.rejects(selectedSettings(), /invalid reasoning effort/));
  } finally { await rm(home, {recursive: true, force: true}); }
});
