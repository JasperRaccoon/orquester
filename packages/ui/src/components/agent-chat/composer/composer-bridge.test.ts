import test from "node:test";
import assert from "node:assert/strict";
import { composerHandle, insertComposerText, registerComposerHandle, type ComposerHandle } from "./composer-bridge";

function fakeHandle(log: string[]): ComposerHandle {
  return {
    insertText: (text, mode) => void log.push(`insert:${mode ?? "cursor"}:${text}`),
    stageAttachment: () => false,
    returnMessage: () => [],
    focusAtEnd: () => {},
    openControl: () => {},
    sendText: () => false,
    submitText: () => ({ ok: false, reason: "unavailable" }),
    restoreFailedSend: () => false
  };
}

test("a stale unregister cannot drop the handle that replaced it", () => {
  // A fast tab switch can run the old effect's cleanup after the new effect
  // registered; a blind delete would leave the live composer unreachable.
  const first: string[] = [];
  const second: string[] = [];
  const unregisterFirst = registerComposerHandle("s2", fakeHandle(first));
  const unregisterSecond = registerComposerHandle("s2", fakeHandle(second));
  unregisterFirst();
  insertComposerText("s2", "still here");
  assert.deepEqual(second, ["insert:cursor:still here"]);
  assert.deepEqual(first, []);
  unregisterSecond();
  assert.equal(composerHandle("s2"), null);
});
