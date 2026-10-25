/**
 * Agent-created saved prompts in the right rail (unified MCP D-16, §14.2.10): a visible "by
 * <agent>" badge, and no one-click pin — rendered, not mounted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SavedPrompt } from "@orquester/api";

import { promptCreatorBadge, SavedPromptItem } from "./SavedPromptItem";

const prompt = (extra: Partial<SavedPrompt> = {}): SavedPrompt => ({
  id: "p1",
  title: "Release notes",
  description: "",
  body: "Write the notes.",
  tags: [],
  projectPath: null,
  pinned: false,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  lastUsedAt: null,
  useCount: 0,
  ...extra
});

const noop = (): void => {};
const render = (value: SavedPrompt, expanded: boolean): string =>
  renderToStaticMarkup(
    createElement(SavedPromptItem, {
      prompt: value,
      expanded,
      variant: "docked",
      canDeliver: true,
      busy: null,
      feedback: null,
      canMoveToProject: true,
      onExpand: noop,
      onCollapse: noop,
      onDeliver: noop,
      onTogglePin: noop,
      onEdit: noop,
      onDuplicate: noop,
      onMove: noop,
      onDelete: noop
    })
  );

const byAgent = prompt({ createdBy: { kind: "agent", agent: "codex", threadId: "t1", title: "Plan the API" } });

test("the badge names the agent and, in its title, the chat", () => {
  assert.deepEqual(promptCreatorBadge(byAgent)?.label, "by Codex");
  assert.ok(promptCreatorBadge(byAgent)?.title?.includes("Plan the API"));
  assert.equal(promptCreatorBadge(prompt()), null);
  assert.equal(promptCreatorBadge(prompt({ createdBy: { kind: "user" } })), null);
  assert.equal(promptCreatorBadge(prompt({ createdBy: { kind: "agent", agent: "future" } }))?.label, "by an agent");
});

test("an agent's prompt shows its badge collapsed and open, and has no one-click pin", () => {
  assert.match(render(byAgent, false), /data-created-by="agent"[^>]*>.*by Codex/);
  const open = render(byAgent, true);
  assert.match(open, /by Codex/);
  assert.match(open, /<button\b[^>]*aria-pressed="false"[^>]*disabled=""[^>]*data-agent-pin="disabled"/);
  assert.match(open, /open Edit to read it/);
});

test("an already pinned agent prompt can still be unpinned; the user's prompts pin as before", () => {
  assert.match(render({ ...byAgent, pinned: true }, true), /<button\b[^>]*aria-pressed="true"(?![^>]*disabled="")[^>]*data-agent-pin="unpin"/);
  const mine = render(prompt(), true);
  assert.doesNotMatch(mine, /data-created-by/);
  assert.doesNotMatch(mine, /<button\b[^>]*aria-pressed="false"[^>]*disabled=""/);
});
