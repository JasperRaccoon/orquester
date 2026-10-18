import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ProviderSnapshot } from "@orquester/api/agent-chat";

import { parseThreadCatalogResponse, withThreadCatalog } from "./thread-catalog";

const GLOBAL: Pick<ProviderSnapshot, "slashCommands" | "skills" | "workspaceSnapshots" | "models"> = {
  models: [],
  slashCommands: [{ name: "global-cmd" }],
  skills: [{ name: "global-skill", path: "/home/u/.claude/skills/g/SKILL.md", enabled: true, scope: "user" }],
  workspaceSnapshots: [
    { cwd: "/w/p", checkedAt: "x", slashCommands: [{ name: "global-cmd" }], skills: [{ name: "global-user", path: "/u", enabled: true, scope: "user" }] }
  ]
};

describe("an Agent Profile chat's composer catalog", () => {
  it("a Global chat keeps the provider's catalog untouched", () => {
    assert.equal(withThreadCatalog(GLOBAL, null, null), GLOBAL);
    assert.equal(withThreadCatalog(GLOBAL, "", null), GLOBAL, "an empty id is Global (a deleted profile's fallback)");
  });

  it("a profile chat shows its own catalog, and never the Global one — not even while it loads", () => {
    const own = {
      threadId: "t1",
      source: "session" as const,
      slashCommands: [{ name: "profile-cmd" }],
      skills: [{ name: "profile-skill", path: "/p/SKILL.md", enabled: true }]
    };
    const shown = withThreadCatalog(GLOBAL, "editor", own);
    assert.deepEqual(shown?.slashCommands, own.slashCommands);
    assert.deepEqual(shown?.skills, own.skills);
    assert.equal(shown?.workspaceSnapshots, undefined, "no per-cwd overlay of the Global catalog");
    assert.equal(shown?.models, GLOBAL.models, "everything else is the provider's");
    const loading = withThreadCatalog(GLOBAL, "editor", null);
    assert.deepEqual([loading?.slashCommands, loading?.skills, loading?.workspaceSnapshots], [[], [], undefined]);
  });

  it("source none (the profile is gone: the chat falls back to Global) keeps the provider's", () => {
    assert.equal(withThreadCatalog(GLOBAL, "gone", { threadId: "t1", source: "none", slashCommands: [], skills: [] }), GLOBAL);
  });

  it("parses only a well-formed answer for the asked thread, dropping malformed rows", () => {
    assert.deepEqual(
      parseThreadCatalogResponse(
        {
          threadId: "t1",
          source: "profile",
          slashCommands: [{ name: "ok", description: "d", input: { hint: "<x>" } }, { name: 5 }, null, { name: "bare" }],
          skills: [{ name: "s", path: "/s", enabled: true, scope: "profile" }, { name: "no-path", enabled: true }, "x"]
        },
        "t1"
      ),
      {
        threadId: "t1",
        source: "profile",
        slashCommands: [{ name: "ok", description: "d", input: { hint: "<x>" } }, { name: "bare" }],
        skills: [{ name: "s", path: "/s", enabled: true, scope: "profile" }]
      }
    );
    assert.equal(parseThreadCatalogResponse({ threadId: "t2", source: "session", slashCommands: [], skills: [] }, "t1"), null);
    assert.equal(parseThreadCatalogResponse({ threadId: "t1", source: "global", slashCommands: [], skills: [] }, "t1"), null);
    assert.equal(parseThreadCatalogResponse({ threadId: "t1", source: "session" }, "t1"), null);
    assert.equal(parseThreadCatalogResponse(null, "t1"), null);
  });
});
