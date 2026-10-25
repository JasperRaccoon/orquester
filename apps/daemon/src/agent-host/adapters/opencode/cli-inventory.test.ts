/**
 * The CLI fallback inventory (spec §4.5 "Catalogue fallbacks").
 *
 * The parser fixtures below are verbatim shapes from the real
 * `opencode 1.18.5` on this host — `models --verbose`, `agent list` and
 * `debug skill` were each run and their output shortened, not invented.
 */

import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";

import { loadInventoryFromCli } from "./cli-inventory.ts";

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

test("models --verbose yields providers, models and the connected list", async (t) => {
  const list = (await loadInventoryFromCli((await harness(t, "ok", { models: MODELS_OUTPUT })).input)).providers;
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

test("a body line that looks like a slug does not flush the model", async (t) => {
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
  const list = (await loadInventoryFromCli((await harness(t, "ok", { models: output })).input)).providers;
  assert.deepEqual(list.connected, ["openrouter"]);
  assert.equal(list.all[0]?.models["vendor/model-x"]?.name, "Model X");
});

test("an unparseable body drops that one model, never the catalogue", async (t) => {
  const output = `good/one
{ "id": "one", "name": "One" }
bad/two
{ this is not json
good/three
{ "id": "three", "name": "Three" }
`;
  const list = (await loadInventoryFromCli((await harness(t, "ok", { models: output })).input)).providers;
  assert.equal(list.all.find((p) => p.id === "good")?.models["one"]?.name, "One");
  assert.equal(list.all.find((p) => p.id === "good")?.models["three"]?.name, "Three");
  assert.equal(list.all.find((p) => p.id === "bad"), undefined);
});

test("empty output is an empty catalogue, not a throw", async (t) => {
  assert.deepEqual((await loadInventoryFromCli((await harness(t, "ok", { models: "" })).input)).providers, { all: [], connected: [] });
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

test("agent list yields name, mode and the hidden flag the CLI omits", async (t) => {
  const agents = (await loadInventoryFromCli((await harness(t, "ok", { agents: AGENTS_OUTPUT })).input)).agents;
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

test("agent list tolerates an empty body and trailing whitespace", async (t) => {
  const h = await harness(t, "ok", { agents: "plan (primary)\n" });
  assert.deepEqual((await loadInventoryFromCli(h.input)).agents.map((agent) => agent.name), ["plan"]);
  h.output.agents = "";
  assert.deepEqual((await loadInventoryFromCli(h.input)).agents, []);
});

// ---------------------------------------------------------------------------
// parseSkillsCliOutput
// ---------------------------------------------------------------------------

test("debug skill yields name/description/location and drops the huge body", async (t) => {
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
  const skills = (await loadInventoryFromCli((await harness(t, "ok", { skills: output })).input)).skills;
  assert.equal(skills.length, 2);
  assert.equal(skills[0]?.name, "customize-opencode");
  assert.equal(skills[0]?.location, "<built-in>");
  // `content` inlines every skill body — megabytes this snapshot never renders.
  assert.equal("content" in (skills[0] as Record<string, unknown>), false);
  assert.equal(skills[1]?.name, "no-location");
});

test("a TRUNCATED skill array still yields every skill that arrived whole", async (t) => {
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

  const skills = (await loadInventoryFromCli((await harness(t, "ok", { skills: cut })).input)).skills;
  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["first", "second"],
    "the two complete objects survive; the severed third is dropped"
  );
  assert.equal(skills[0]?.location, "/a");
});

test("malformed skill output degrades to an empty list", async (t) => {
  const h = await harness(t);
  for (const output of ["not json", "{}", ""]) {
    h.output.skills = output;
    assert.deepEqual((await loadInventoryFromCli(h.input)).skills, []);
  }
});

// ---------------------------------------------------------------------------
// loadInventoryFromCli
// ---------------------------------------------------------------------------

function harness(t: test.TestContext, mode = "ok", supplied: { models?: string; agents?: string; skills?: string } = {}) {
  // The CLI is external: supply its raw stdout and exit status, leaving the
  // real stream reader, parser and retry policy under test. Actual CLI spawn
  // plumbing is exercised by snapshot-budget.test.ts's cwd-less refresh.
  const output = { models: MODELS_OUTPUT, agents: AGENTS_OUTPUT, skills: "[]", ...supplied };
  let live = 0;
  let peak = 0;
  let modelsStarted = 0;
  let skillsStarted = 0;
  if (mode !== "ok") t.mock.timers.enable({ apis: ["setTimeout"] });
  const mocked = t.mock.method(childProcess, "spawn", (_command: string, args: readonly string[]) => {
    const command = args[0];
    const model = command === "models";
    if (model) modelsStarted += 1;
    if (command === "debug") skillsStarted += 1;
    const code = model && mode === "unavailable" ? 127
      : model && mode === "retry" && modelsStarted === 1 ? 1
      : !model && mode === "optional-failure" ? 2 : 0;
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: []
    });
    live += 1;
    peak = Math.max(peak, live);
    setImmediate(() => {
      child.stdout.end(code === 0 ? model ? output.models : command === "agent" ? output.agents : output.skills : "");
      child.stderr.end();
      child.stdin.end();
      // EOF is not process exit: keep this child live for another turn so
      // starting the next SQLite probe on stdout end would fail the peak check.
      setImmediate(() => {
        live -= 1;
        child.emit("close", code, null);
        // The last initial probe has closed. Its continuation schedules the
        // retry pause before this next loop turn advances virtual time.
        if (mode !== "ok" && command === "debug" && skillsStarted === 1) {
          setImmediate(() => t.mock.timers.runAll());
        }
      });
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return {
    // An absent executable prevents the optional nice/lifeline wrappers from
    // changing these CLI arguments; no fixture file or process is needed.
    input: { bin: "/__orquester_test__/opencode-fixture", cwd: process.cwd(), env: {} },
    output,
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
  await assert.rejects(loadInventoryFromCli(h.input), /models --verbose.*exited with code 127/);
  assert.equal(h.modelAttempts(), 2, "a permanent failure stops after one retry");
});
