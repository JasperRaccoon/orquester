import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { agentProfileStore, resetAgentProfile } from "../../../../lib/agent-profile/store";
import { subscribeAgentProfileEditorSaved, type AgentProfileEditorSaved } from "../editor-bridge";
import { publishSaved } from "./saved";

afterEach(() => resetAgentProfile());

function listen(): { heard: AgentProfileEditorSaved[]; stop: () => void } {
  const heard: AgentProfileEditorSaved[] = [];
  const stop = subscribeAgentProfileEditorSaved((saved) => heard.push(saved));
  return { heard, stop };
}

test("a save puts the answer's snapshot in the store and tells the panel what changed", () => {
  const { heard, stop } = listen();
  publishSaved("grok", {
    snapshot: {
      agent: "grok",
      installed: true,
      revision: "r2",
      instructions: { path: "/h/.grok/AGENTS.md", exists: true, bytes: 1, lines: 1, revision: "i", warnings: [] },
      items: [
        {
          id: "mcp:docs",
          kind: "mcp",
          name: "docs",
          enabled: true,
          toggleable: true,
          editable: true,
          deletable: true,
          locked: false,
          source: { type: "user", label: "User" },
          revision: "x",
          warnings: []
        }
      ],
      fileErrors: [],
      readAt: "2026-09-28T00:00:00.000Z"
    },
    itemIds: ["mcp:docs"],
    notes: ["Saved — applies to new sessions", 42]
  });
  stop();
  const entry = agentProfileStore.getState().agents.grok;
  assert.equal(entry.snapshot?.revision, "r2");
  assert.deepEqual(entry.snapshot?.items.map((item) => item.id), ["mcp:docs"]);
  assert.deepEqual(heard, [{ agent: "grok", itemIds: ["mcp:docs"], notes: ["Saved — applies to new sessions"] }]);
});

test("an answer without a usable snapshot still tells the panel, and leaves the store alone", () => {
  const { heard, stop } = listen();
  publishSaved("codex", { snapshot: { agent: "nobody" }, itemIds: "nope" });
  stop();
  assert.equal(agentProfileStore.getState().agents.codex.snapshot, null);
  assert.deepEqual(heard, [{ agent: "codex", itemIds: [], notes: [] }]);
});
