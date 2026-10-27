/**
 * Agent-created saved prompts in the right rail (unified MCP D-16, §14.2.10): a visible "by
 * <agent>" badge, and no one-click pin — rendered, not mounted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";

import type { SavedPrompt } from "@orquester/api";

import { SavedPromptItem } from "./SavedPromptItem";

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
const render = (value: SavedPrompt, expanded: boolean): DocumentFragment =>
  JSDOM.fragment(renderToStaticMarkup(
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
  ));

const pin = (view: DocumentFragment): HTMLButtonElement => {
  const button = [...view.querySelectorAll("button")].find((candidate) => candidate.textContent === "Pin");
  assert.ok(button, "the Pin button is available");
  return button;
};

const byAgent = prompt({ createdBy: { kind: "agent", agent: "codex", threadId: "t1", title: "Plan the API" } });

test("an agent's prompt shows its badge collapsed and open, and has no one-click pin", () => {
  const collapsed = render(byAgent, false);
  assert.match(collapsed.textContent ?? "", /by Codex/);
  assert.ok([...collapsed.querySelectorAll("[title]")].some((element) => element.getAttribute("title")?.includes("Plan the API")));
  assert.match(render(byAgent, true).textContent ?? "", /by Codex/);
  for (const value of [byAgent, prompt({ createdBy: { kind: "agent", agent: "future" } })]) {
    const button = pin(render(value, true));
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.disabled, true);
  }
});

test("an already pinned agent prompt can still be unpinned; the user's prompts pin as before", () => {
  const pinned = pin(render({ ...byAgent, pinned: true }, true));
  assert.equal(pinned.getAttribute("aria-pressed"), "true");
  assert.equal(pinned.disabled, false);
  for (const value of [prompt(), prompt({ createdBy: { kind: "user" } })]) {
    const mine = render(value, true);
    assert.doesNotMatch(mine.textContent ?? "", /by Codex/);
    assert.equal(pin(mine).disabled, false);
  }
});
