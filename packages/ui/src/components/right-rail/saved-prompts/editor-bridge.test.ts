import test from "node:test";
import assert from "node:assert/strict";

import {
  openSavedPromptEditor,
  subscribeSavedPromptEditor,
  type SavedPromptEditorRequest
} from "./editor-bridge.ts";

const request: SavedPromptEditorRequest = { mode: "create", projectPath: null };

test("with no editor host, opening reports false", () => {
  assert.equal(openSavedPromptEditor(request), false);
});

test("a host takes the request, and unsubscribing takes it out", () => {
  const taken: SavedPromptEditorRequest[] = [];
  const stopHost = subscribeSavedPromptEditor((next) => taken.push(next));
  assert.equal(openSavedPromptEditor(request), true);
  assert.deepEqual(taken, [request]);
  stopHost();
  assert.equal(openSavedPromptEditor(request), false, "no host left");
  assert.deepEqual(taken, [request]);
});
