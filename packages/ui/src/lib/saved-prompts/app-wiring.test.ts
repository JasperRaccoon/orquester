import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
    useAppStore.getState().applyEvent(event("saved-prompts", "savedPrompt.upserted", record));
    assert.equal(savedPromptsStore.getState().prompts.get("wired")?.title, "Wired");
    useAppStore
      .getState()
      .applyEvent(event("saved-prompts", "savedPrompt.deleted", { id: "wired", projectPath: null }));
    assert.equal(savedPromptsStore.getState().prompts.has("wired"), false);
  });

  it("the same message on another channel does not", () => {
    resetSavedPrompts();
    useAppStore.getState().applyEvent(event("elsewhere", "savedPrompt.upserted", record));
    assert.equal(savedPromptsStore.getState().prompts.size, 0);
  });
});
