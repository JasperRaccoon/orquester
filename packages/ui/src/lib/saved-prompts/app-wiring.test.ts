/**
 * The app store's two hooks into the saved-prompts store: `/events` messages
 * of the `saved-prompts` channel reach it, and a sign-out or a connection
 * switch empties it (another daemon's prompts must never show).
 *
 * The routing runs for real — `applyEvent` on the actual app store. The resets
 * are pinned in the source: driving `signOut`/`selectConnection` under node
 * would build a real `ApiClient`, whose WebSocket session channel connects at
 * construction. What the reset itself does is `store.test.ts`'s.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { SAVED_PROMPTS_CHANNEL } from "@orquester/api";

import { useAppStore } from "../../store/app.ts";
import { resetSavedPrompts, savedPromptsStore } from "./store.ts";

const record = {
  id: "wired",
  title: "Wired",
  description: "",
  body: "Body",
  tags: [],
  projectPath: null,
  pinned: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: null,
  useCount: 0
};

const event = (channel: string, type: string, payload: unknown) => ({
  id: `${channel}:${type}`,
  channel,
  type,
  createdAt: "2026-09-01T00:00:00.000Z",
  payload
});

describe("the app store routes saved-prompt events", () => {
  it("an upsert and a delete on the saved-prompts channel reach the store", () => {
    resetSavedPrompts();
    useAppStore.getState().applyEvent(event(SAVED_PROMPTS_CHANNEL, "savedPrompt.upserted", record));
    assert.equal(savedPromptsStore.getState().prompts.get("wired")?.title, "Wired");
    useAppStore
      .getState()
      .applyEvent(event(SAVED_PROMPTS_CHANNEL, "savedPrompt.deleted", { id: "wired", projectPath: null }));
    assert.equal(savedPromptsStore.getState().prompts.has("wired"), false);
  });

  it("the same message on another channel does not", () => {
    resetSavedPrompts();
    useAppStore.getState().applyEvent(event("elsewhere", "savedPrompt.upserted", record));
    assert.equal(savedPromptsStore.getState().prompts.size, 0);
  });

  it("a malformed payload is ignored without a throw", () => {
    resetSavedPrompts();
    assert.doesNotThrow(() => {
      useAppStore.getState().applyEvent(event(SAVED_PROMPTS_CHANNEL, "savedPrompt.upserted", null));
      useAppStore.getState().applyEvent(event(SAVED_PROMPTS_CHANNEL, "savedPrompt.deleted", 7));
    });
    assert.equal(savedPromptsStore.getState().prompts.size, 0);
  });
});

describe("a sign-out and a connection switch reset the saved prompts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // Comments stripped, so a commented-out call never passes for a live one.
  const source = readFileSync(join(here, "..", "..", "store", "app.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");

  /** The body of the store method `name` (its implementation, not its type), up to the next method. */
  function methodBody(name: string): string {
    const store = source.indexOf("create<AppState>(");
    assert.ok(store >= 0, "app.ts still creates its store with create<AppState>(");
    const start = source.indexOf(`\n  ${name}: `, store);
    assert.ok(start >= 0, `app.ts still has ${name}`);
    const next = source.slice(start + 1).search(/\n {2}[A-Za-z]\w*: /);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }

  for (const name of ["signOut", "selectConnection"]) {
    it(`${name} resets them before it switches the client`, () => {
      const body = methodBody(name);
      const reset = body.indexOf("resetSavedPrompts();");
      assert.ok(reset >= 0, `${name} calls resetSavedPrompts()`);
      assert.ok(reset < body.indexOf("set({"), "before the new client is installed");
    });
  }
});
