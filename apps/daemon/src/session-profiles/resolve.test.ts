import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionProfileItemEntry, SessionProfileItemRecord } from "@orquester/config";
import { resolveForAgent, resolveSessionProfileSettings, type SessionProfileSource } from "./resolve.ts";

function ok(record: Record<string, unknown>): SessionProfileItemEntry {
  return { ok: true, record: { enabled: true, agents: "all", ...record } as SessionProfileItemRecord };
}

function source(items: SessionProfileItemEntry[], overrides: Partial<SessionProfileSource> = {}): SessionProfileSource {
  return {
    profileId: "p1",
    revision: "4",
    name: "Dev",
    dir: "/profiles/p1",
    settings: {},
    instructions: "Be brief.",
    items,
    secrets: {},
    missingContent: new Set(),
    ...overrides
  };
}

describe("resolveForAgent", () => {
  it("keeps enabled items in scope for the agent, with their source paths", () => {
    const resolved = resolveForAgent(
      source([
        ok({ id: "s1", kind: "skill", name: "review", description: "Review" }),
        ok({ id: "s2", kind: "skill", name: "off", enabled: false }),
        ok({ id: "s3", kind: "skill", name: "codex-only", agents: ["codex"] }),
        ok({ id: "c1", kind: "command", name: "git/pr" })
      ]),
      "claude"
    );
    assert.deepEqual(resolved.skills, [
      { id: "s1", name: "review", description: "Review", dir: "/profiles/p1/skills/s1", skillFile: "/profiles/p1/skills/s1/SKILL.md" }
    ]);
    // Commands stay commands for every agent; Codex's preparer converts them.
    assert.deepEqual(resolved.commands, [{ id: "c1", name: "git/pr", file: "/profiles/p1/commands/c1.md" }]);
    assert.equal(resolveForAgent(source([ok({ id: "c1", kind: "command", name: "x" })]), "codex").commands.length, 1);
    assert.equal(resolved.instructions, "Be brief.");
    assert.deepEqual(resolved.skipped, []);
    assert.deepEqual(
      resolveForAgent(source([ok({ id: "s3", kind: "skill", name: "codex-only", agents: ["codex"] })]), "codex").skills.map((s) => s.id),
      ["s3"]
    );
  });

  it("hands MCP servers their REAL secret values, and skips one whose value is missing", () => {
    const mcp = (id: string, keys: string[]) =>
      ok({ id, kind: "mcp", name: id, mcp: { transport: "stdio", command: "srv", envKeys: keys, advanced: { timeout: 5 } } });
    const resolved = resolveForAgent(
      source([mcp("m1", ["TOKEN"]), mcp("m2", ["GONE"])], { secrets: { m1: { env: { TOKEN: "t0k" } } } }),
      "codex"
    );
    assert.deepEqual(resolved.mcpServers, [
      { id: "m1", name: "m1", transport: "stdio", command: "srv", env: { TOKEN: "t0k" }, headers: {}, advanced: { timeout: 5 } }
    ]);
    assert.equal(resolved.skipped.length, 1);
    assert.equal(resolved.skipped[0]!.itemId, "m2");
    assert.match(resolved.skipped[0]!.reason, /GONE is missing/);
  });

  it("skips an MCP transport the agent lacks, for that agent only", () => {
    const items = [ok({ id: "m1", kind: "mcp", name: "events", mcp: { transport: "sse", url: "https://x" } })];
    assert.equal(resolveForAgent(source(items), "claude").mcpServers.length, 1);
    const codex = resolveForAgent(source(items), "codex");
    assert.equal(codex.mcpServers.length, 0);
    assert.match(codex.skipped[0]!.reason, /no sse MCP transport/);
  });

  it("applies plugins and hooks to their one agent and skips an invalid single-agent scope", () => {
    const items = [
      ok({ id: "h1", kind: "hook", name: "Stop", agents: ["claude"], hook: { event: "Stop", command: "n" } }),
      ok({ id: "h2", kind: "hook", name: "bad", agents: "all", hook: { event: "Stop", command: "n" } }),
      ok({ id: "h3", kind: "hook", name: "two", agents: ["claude", "grok"], hook: { event: "Stop", command: "n" } }),
      ok({ id: "h4", kind: "hook", name: "event", agents: ["codex"], hook: { event: "Notification", command: "n" } }),
      ok({ id: "p1", kind: "plugin", name: "sp", agents: ["claude"], plugin: { marketplace: "m" } }),
      ok({ id: "p2", kind: "plugin", name: "both", agents: ["claude", "codex"], plugin: {} })
    ];
    const claude = resolveForAgent(source(items), "claude");
    assert.deepEqual(claude.hooks, [{ id: "h1", name: "Stop", event: "Stop", command: "n" }]);
    assert.deepEqual(claude.plugins, [{ id: "p1", name: "sp", marketplace: "m", cacheDir: "/profiles/p1/plugins/p1" }]);
    assert.deepEqual(claude.skipped.map((skip) => skip.itemId).sort(), ["h2", "h3", "p2"]);
    const codex = resolveForAgent(source(items), "codex");
    assert.deepEqual(codex.hooks, []);
    assert.deepEqual(codex.skipped.map((skip) => skip.itemId).sort(), ["h2", "h4", "p2"]);
    assert.equal(resolveForAgent(source(items), "opencode").plugins.length, 0);
  });

  it("skips items whose content is missing and items that do not read", () => {
    const resolved = resolveForAgent(
      source(
        [
          ok({ id: "s1", kind: "skill", name: "gone" }),
          ok({ id: "p1", kind: "plugin", name: "empty", agents: ["grok"], plugin: {} }),
          { ok: false, raw: { id: "x" }, id: "x", error: "kind: Invalid" }
        ],
        { missingContent: new Set(["s1", "p1"]) }
      ),
      "grok"
    );
    assert.deepEqual(resolved.skills, []);
    assert.deepEqual(resolved.plugins, []);
    assert.deepEqual(resolved.skipped.map((skip) => skip.itemId), ["s1", "p1", "x"]);
  });

  it("ignores an agent id this build does not know", () => {
    const items = [ok({ id: "s1", kind: "skill", name: "a", agents: ["claude", "future-agent"] })];
    assert.equal(resolveForAgent(source(items), "claude").skills.length, 1);
    assert.equal(resolveForAgent(source(items), "grok").skills.length, 0);
  });

  it("resolves the settings with their defaults, per agent", () => {
    assert.deepEqual(resolveSessionProfileSettings(undefined), {
      hideBuiltinSkills: { claude: true, codex: true, grok: true, opencode: true },
      claudeWorkflowTool: true
    });
    const resolved = resolveForAgent(source([], { settings: { hideBuiltinSkills: { codex: false }, claudeWorkflowTool: false } }), "codex");
    assert.deepEqual(resolved.settings, { hideBuiltinSkills: false, claudeWorkflowTool: false });
    assert.equal(resolveForAgent(source([], { settings: { hideBuiltinSkills: { codex: false } } }), "grok").settings.hideBuiltinSkills, true);
  });
});
