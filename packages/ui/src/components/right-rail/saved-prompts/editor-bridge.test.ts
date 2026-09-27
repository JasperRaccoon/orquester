import test from "node:test";
import assert from "node:assert/strict";

import {
  openSavedPromptEditor,
  subscribeSavedPromptEditor,
  subscribeSavedPromptEditorOpened,
  type SavedPromptEditorRequest
} from "./editor-bridge.ts";

const request: SavedPromptEditorRequest = { mode: "create", projectPath: null };

test("with no editor host, opening reports false — whoever else is listening", () => {
  // The mobile sheet listens to step aside for the editor; that must never
  // read as an editor, or the panel's own fallback editor never opens.
  const opened: SavedPromptEditorRequest[] = [];
  const stop = subscribeSavedPromptEditorOpened((taken) => opened.push(taken));
  try {
    assert.equal(openSavedPromptEditor(request), false);
    assert.deepEqual(opened, [], "and nobody hears of an editor that did not open");
  } finally {
    stop();
  }
});

test("a host takes the request, and only then are the opened-listeners told", () => {
  const order: string[] = [];
  const stopHost = subscribeSavedPromptEditor((taken) => {
    assert.equal(taken, request);
    order.push("host");
  });
  const stopOpened = subscribeSavedPromptEditorOpened((taken) => {
    assert.equal(taken, request);
    order.push("opened");
  });
  try {
    assert.equal(openSavedPromptEditor(request), true);
    assert.deepEqual(order, ["host", "opened"]);
  } finally {
    stopHost();
    stopOpened();
  }
});

test("unsubscribing takes each listener out of its own list", () => {
  let hosts = 0;
  let opened = 0;
  const stopHost = subscribeSavedPromptEditor(() => {
    hosts += 1;
  });
  const stopOpened = subscribeSavedPromptEditorOpened(() => {
    opened += 1;
  });
  stopOpened();
  assert.equal(openSavedPromptEditor(request), true);
  assert.deepEqual([hosts, opened], [1, 0]);
  stopHost();
  assert.equal(openSavedPromptEditor(request), false, "no host left");
  assert.deepEqual([hosts, opened], [1, 0]);
});
