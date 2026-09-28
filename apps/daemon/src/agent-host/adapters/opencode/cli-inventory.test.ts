/**
 * The CLI fallback inventory (spec §4.5 "Catalogue fallbacks").
 *
 * The parser fixtures below are verbatim shapes from the real
 * `opencode 1.18.5` on this host — `models --verbose`, `agent list` and
 * `debug skill` were each run and their output shortened, not invented.
 */

import assert from "node:assert/strict";
import test from "node:test";
import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { MessageChannel } from "node:worker_threads";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadInventoryFromCli,
  parseAgentListCliOutput,
  parseModelsCliOutput,
  parseSkillsCliOutput
} from "./cli-inventory.ts";

// ---------------------------------------------------------------------------
// parseModelsCliOutput
// ---------------------------------------------------------------------------

const MODELS_OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "variants": {
    "low": { "reasoning": { "effort": "low" } },
    "high": { "reasoning": { "effort": "high" } }
  }
}
openrouter/google/gemini-3.1-flash-lite
{
  "id": "google/gemini-3.1-flash-lite",
  "providerID": "openrouter",
  "name": "Gemini 3.1 Flash Lite"
}
`;

test("models --verbose yields providers, models and the connected list", () => {
  const list = parseModelsCliOutput(MODELS_OUTPUT);
  assert.deepEqual(list.connected.sort(), ["opencode", "openrouter"]);
  const opencode = list.all.find((provider) => provider.id === "opencode");
  assert.equal(opencode?.models["big-pickle"]?.name, "Big Pickle");
  assert.deepEqual(Object.keys(opencode?.models["big-pickle"]?.variants ?? {}), ["low", "high"]);
  // §4.5: the slug splits on the FIRST slash, so a nested model id survives.
  const openrouter = list.all.find((provider) => provider.id === "openrouter");
  assert.equal(
    openrouter?.models["google/gemini-3.1-flash-lite"]?.name,
    "Gemini 3.1 Flash Lite"
  );
});

test("a body line that looks like a slug does not flush the model", () => {
  // T3 learned this the hard way: an OpenRouter model whose `id` is
  // `vendor/model` produces a body line with no interior whitespace that also
  // matches the slug pattern. Without the `{`-guard plus the "only outside a
  // body" rule, the model is silently dropped.
  const output = `openrouter/vendor/model-x
{
"id":
"vendor/model-x",
"name": "Model X"
}
`;
  const list = parseModelsCliOutput(output);
  assert.deepEqual(list.connected, ["openrouter"]);
  assert.equal(list.all[0]?.models["vendor/model-x"]?.name, "Model X");
});

test("an unparseable body drops that one model, never the catalogue", () => {
  const output = `good/one
{ "id": "one", "name": "One" }
bad/two
{ this is not json
good/three
{ "id": "three", "name": "Three" }
`;
  const list = parseModelsCliOutput(output);
  assert.equal(list.all.find((p) => p.id === "good")?.models["one"]?.name, "One");
  assert.equal(list.all.find((p) => p.id === "good")?.models["three"]?.name, "Three");
  assert.equal(list.all.find((p) => p.id === "bad"), undefined);
});

test("empty output is an empty catalogue, not a throw", () => {
  assert.deepEqual(parseModelsCliOutput(""), { all: [], connected: [] });
});

// ---------------------------------------------------------------------------
// parseAgentListCliOutput
// ---------------------------------------------------------------------------

const AGENTS_OUTPUT = `build (primary)
  [
  { "permission": "*", "action": "allow", "pattern": "*" }
]
explore (subagent)
  []
title (primary)
  []
`;

test("agent list yields name, mode and the hidden flag the CLI omits", () => {
  const agents = parseAgentListCliOutput(AGENTS_OUTPUT);
  assert.deepEqual(
    agents.map((agent) => [agent.name, agent.mode, agent.hidden]),
    [
      ["build", "primary", false],
      ["explore", "subagent", false],
      // `title` is always hidden in OpenCode but `agent list` does not say so.
      ["title", "primary", true]
    ]
  );
});

test("agent list tolerates an empty body and trailing whitespace", () => {
  assert.deepEqual(
    parseAgentListCliOutput("plan (primary)\n").map((agent) => agent.name),
    ["plan"]
  );
  assert.deepEqual(parseAgentListCliOutput(""), []);
});

// ---------------------------------------------------------------------------
// parseSkillsCliOutput
// ---------------------------------------------------------------------------

test("debug skill yields name/description/location and drops the huge body", () => {
  const output = JSON.stringify([
    {
      name: "customize-opencode",
      description: "Use ONLY when editing opencode's own configuration.",
      location: "<built-in>",
      content: "x".repeat(10_000)
    },
    { name: "no-location" },
    { notASkill: true }
  ]);
  const skills = parseSkillsCliOutput(output);
  assert.equal(skills.length, 2);
  assert.equal(skills[0]?.name, "customize-opencode");
  assert.equal(skills[0]?.location, "<built-in>");
  // `content` inlines every skill body — megabytes this snapshot never renders.
  assert.equal("content" in (skills[0] as Record<string, unknown>), false);
  assert.equal(skills[1]?.name, "no-location");
});

test("a TRUNCATED skill array still yields every skill that arrived whole", () => {
  // Measured on this host: `opencode debug skill` answers 265 625 bytes to a
  // file and 218 171 through a pipe, for the identical command — the
  // Bun-compiled binary truncates non-TTY stdout (§4.5's reason for
  // preferring the SDK `GET /skill` on the live path). A plain `JSON.parse`
  // of that loses ALL 24 skills; this recovers the complete ones.
  const whole = JSON.stringify([
    { name: "first", description: "one", location: "/a", content: "x".repeat(200) },
    { name: "second", description: "two", location: "/b", content: "y".repeat(200) },
    { name: "third", description: "three", location: "/c", content: "z".repeat(200) }
  ]);
  const cut = whole.slice(0, whole.length - 180);
  assert.throws(() => JSON.parse(cut), "the fixture really is truncated");

  const skills = parseSkillsCliOutput(cut);
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["first", "second"],
    "the two complete objects survive; the severed third is dropped"
  );
  assert.equal(skills[0]?.location, "/a");
});

test("a skill object severed mid-string does not corrupt the ones before it", () => {
  const cut = '[{"name":"kept","location":"/k"},{"name":"hal';
  assert.deepEqual(
    parseSkillsCliOutput(cut).map((skill) => skill.name),
    ["kept"]
  );
});

test("malformed skill output degrades to an empty list", () => {
  assert.deepEqual(parseSkillsCliOutput("not json"), []);
  assert.deepEqual(parseSkillsCliOutput("{}"), []);
  assert.deepEqual(parseSkillsCliOutput(""), []);
});

// ---------------------------------------------------------------------------
// loadInventoryFromCli
// ---------------------------------------------------------------------------

async function harness(t: test.TestContext, mode = "ok") {
  // The daemon supplies other active handles while its retry timer is unref'd.
  // Keep that lifecycle condition here without wall-clock sleeps or a server.
  const lifetime = new MessageChannel();
  lifetime.port1.on("message", () => undefined);
  t.after(() => { lifetime.port1.close(); lifetime.port2.close(); });
  const dir = await mkdtemp(join(tmpdir(), "opencode-inventory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "models.json"), MODELS_OUTPUT);
  await writeFile(join(dir, "agents.json"), AGENTS_OUTPUT);
  const bin = join(dir, "opencode-fixture");
  await writeFile(bin, `#!${process.execPath}
const fs = require("node:fs");
const command = process.argv[2];
const mode = process.env.FIXTURE_MODE;
if (command === "models" && mode === "unavailable") process.exit(127);
if (command === "models" && mode === "retry" && !fs.existsSync("first-attempt")) {
  fs.writeFileSync("first-attempt", "failed");
  process.exit(1);
}
if (command !== "models" && mode === "optional-failure") process.exit(2);
process.stdout.write(command === "models" ? fs.readFileSync("models.json") : command === "agent" ? fs.readFileSync("agents.json") : "[]");
`, { mode: 0o755 });
  const spawn = childProcess.spawn;
  let live = 0;
  let peak = 0;
  let modelsStarted = 0;
  const mocked = t.mock.method(childProcess, "spawn", (command: string, args: readonly string[], options: SpawnOptions) => {
    const child = spawn(command, args, options);
    live += 1;
    peak = Math.max(peak, live);
    if (args[0] === "models") modelsStarted += 1;
    child.once("close", () => { live -= 1; });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return {
    input: { bin, cwd: dir, env: { FIXTURE_MODE: mode } },
    maxInFlight: () => peak,
    modelAttempts: () => modelsStarted
  };
}

test("the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file", async (t) => {
  const h = await harness(t);
  const inventory = await loadInventoryFromCli(h.input);
  assert.equal(h.maxInFlight(), 1, "provider CLI processes never overlap");
  assert.deepEqual(inventory.providers.connected.sort(), ["opencode", "openrouter"]);
  assert.ok(inventory.agents.some((agent) => agent.name === "build"));
});

test("a non-zero exit is retried once and recovers the catalogue sequentially", async (t) => {
  const h = await harness(t, "retry");
  const inventory = await loadInventoryFromCli(h.input);
  assert.equal(h.maxInFlight(), 1);
  assert.equal(h.modelAttempts(), 2);
  assert.deepEqual(inventory.providers.connected.sort(), ["opencode", "openrouter"]);
});

test("agents and skills may each degrade to an empty list", async (t) => {
  const h = await harness(t, "optional-failure");
  const inventory = await loadInventoryFromCli(h.input);
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(inventory.providers.connected.sort(), ["opencode", "openrouter"]);
});

test("a models failure rejects — that one IS the catalogue", async (t) => {
  const h = await harness(t, "unavailable");
  await assert.rejects(loadInventoryFromCli(h.input));
  assert.equal(h.modelAttempts(), 2, "a permanent failure stops after one retry");
});
