import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyWhiteboardFile,
  isWhiteboardFile,
  isWhiteboardScene,
  whiteboardTitle,
  whiteboardsDirOf
} from "./whiteboard.ts";

test("whiteboard files are recognised by their extension, case-insensitively", () => {
  assert.equal(isWhiteboardFile("plan.excalidraw"), true);
  assert.equal(isWhiteboardFile("PLAN.Excalidraw"), true);
  assert.equal(isWhiteboardFile("plan.excalidraw.json"), false);
  assert.equal(isWhiteboardFile("excalidraw"), false);
});

test("a whiteboard's title is its file name without the extension", () => {
  assert.equal(whiteboardTitle("/w/acme/app/whiteboards/Untitled (1).excalidraw"), "Untitled (1)");
  assert.equal(whiteboardTitle("/w/acme/app/.excalidraw"), ".excalidraw");
  assert.equal(whiteboardTitle("/w/acme/app/notes.json"), "notes.json");
});

test("new whiteboards go in the project's whiteboards folder", () => {
  assert.equal(whiteboardsDirOf("/w/acme/app"), "/w/acme/app/whiteboards");
  assert.equal(whiteboardsDirOf("/w/acme/app/"), "/w/acme/app/whiteboards");
});

test("a new whiteboard is an empty Excalidraw scene", () => {
  const file = emptyWhiteboardFile();
  assert.deepEqual(JSON.parse(file), {
    type: "excalidraw",
    version: 2,
    source: "orquester",
    elements: [],
    appState: {},
    files: {}
  });
});

test("only an Excalidraw scene opens as one", () => {
  assert.equal(isWhiteboardScene('{"type":"excalidraw","elements":[{"id":"a"}]}'), true);
  assert.equal(isWhiteboardScene('{"type":"excalidrawlib","elements":[],"libraryItems":[]}'), false);
  assert.equal(isWhiteboardScene('{"type":"excalidraw"}'), false);
  assert.equal(isWhiteboardScene("[]"), false);
  assert.equal(isWhiteboardScene("null"), false);
  assert.equal(isWhiteboardScene("not json"), false);
});
