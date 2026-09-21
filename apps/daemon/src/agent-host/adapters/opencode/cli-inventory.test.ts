/**
 * The CLI fallback inventory (spec §4.5 "Catalogue fallbacks").
 *
 * The parser fixtures below are verbatim shapes from the real
 * `opencode 1.18.5` on this host — `models --verbose`, `agent list` and
 * `debug skill` were each run and their output shortened, not invented.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  loadInventoryFromCli,
  parseAgentListCliOutput,
  parseModelsCliOutput,
  parseSkillsCliOutput,
  type CliCommandResult,
  type RunOpenCodeCliInput
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

interface Recorded {
  args: string[];
  at: number;
}

function harness(
  answers: (args: readonly string[], call: number) => CliCommandResult
): {
  run: (input: RunOpenCodeCliInput) => Promise<CliCommandResult>;
  calls: Recorded[];
  sleeps: number[];
  inFlight: () => number;
  maxInFlight: () => number;
} {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let live = 0;
  let peak = 0;
  const run = async (input: RunOpenCodeCliInput): Promise<CliCommandResult> => {
    live += 1;
    peak = Math.max(peak, live);
    const call = calls.filter((entry) => entry.args.join(" ") === input.args.join(" ")).length;
    calls.push({ args: [...input.args], at: calls.length });
    await Promise.resolve();
    try {
      return answers(input.args, call);
    } finally {
      live -= 1;
    }
  };
  return { run, calls, sleeps, inFlight: () => live, maxInFlight: () => peak };
}

const OK = (stdout: string): CliCommandResult => ({ stdout, code: 0 });

test("the three probes run SEQUENTIALLY — concurrent runs hit one SQLite file", async () => {
  const h = harness((args) => {
    if (args[0] === "models") {
      return OK(MODELS_OUTPUT);
    }
    if (args[0] === "agent") {
      return OK(AGENTS_OUTPUT);
    }
    return OK("[]");
  });
  const inventory = await loadInventoryFromCli({
    bin: "/usr/bin/opencode",
    cwd: "/tmp",
    env: {},
    run: h.run,
    sleep: async () => undefined
  });
  assert.equal(h.maxInFlight(), 1, "never more than one CLI process at a time");
  assert.deepEqual(
    h.calls.map((call) => call.args.join(" ")),
    ["models --verbose", "agent list", "debug skill"]
  );
  assert.deepEqual(inventory.providers.connected.sort(), ["opencode", "openrouter"]);
  assert.equal(inventory.agents.length, 3);
  assert.deepEqual(inventory.commands, [], "the CLI has no command-list equivalent");
});

test("a non-zero exit is retried once, after a pause, still sequentially", async () => {
  let slept = 0;
  const h = harness((args, call) => {
    if (args[0] === "models") {
      // A `database is locked` on the first attempt, fine on the retry.
      return call === 0 ? { stdout: "", code: 1 } : OK(MODELS_OUTPUT);
    }
    return OK(args[0] === "agent" ? AGENTS_OUTPUT : "[]");
  });
  const inventory = await loadInventoryFromCli({
    bin: "/usr/bin/opencode",
    cwd: "/tmp",
    env: {},
    run: h.run,
    sleep: async (ms) => {
      slept = ms;
    }
  });
  assert.equal(slept, 1_000, "the SQLite-lock retry waits a second");
  assert.equal(h.maxInFlight(), 1);
  assert.equal(
    h.calls.filter((call) => call.args[0] === "models").length,
    2,
    "models is retried exactly once"
  );
  assert.equal(
    h.calls.filter((call) => call.args[0] === "agent").length,
    1,
    "a command that succeeded is not re-run"
  );
  assert.deepEqual(inventory.providers.connected.sort(), ["opencode", "openrouter"]);
});

test("agents and skills may each degrade to an empty list", async () => {
  const h = harness((args) =>
    args[0] === "models" ? OK(MODELS_OUTPUT) : { stdout: "", code: 2 }
  );
  const warnings: unknown[] = [];
  const inventory = await loadInventoryFromCli({
    bin: "/usr/bin/opencode",
    cwd: "/tmp",
    env: {},
    run: h.run,
    sleep: async () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => warnings.push(message),
      error: () => undefined
    }
  });
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.skills, []);
  assert.ok(inventory.providers.all.length > 0, "models is still authoritative");
  assert.equal(warnings.length, 1);
});

test("a models failure rejects — that one IS the catalogue", async () => {
  const h = harness((args) =>
    args[0] === "models" ? { stdout: "", code: 127, failure: "command not found" } : OK("[]")
  );
  await assert.rejects(
    loadInventoryFromCli({
      bin: "/usr/bin/opencode",
      cwd: "/tmp",
      env: {},
      run: h.run,
      sleep: async () => undefined
    }),
    /models --verbose.*command not found/s
  );
});
