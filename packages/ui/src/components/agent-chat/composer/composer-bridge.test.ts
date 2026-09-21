import test from "node:test";
import assert from "node:assert/strict";

import {
  composerHandle,
  insertComposerText,
  openComposerControl,
  registerComposerHandle,
  type ComposerHandle
} from "./composer-bridge.ts";

function fakeHandle(log: string[]): ComposerHandle {
  return {
    insertText: (text, mode) => log.push(`insert:${mode ?? "cursor"}:${text}`),
    focusAtEnd: () => log.push("focus"),
    openControl: (command) => log.push(`open:${command}`)
  };
}

test("a registered handle receives text and control requests", () => {
  const log: string[] = [];
  const unregister = registerComposerHandle("s1", fakeHandle(log));
  insertComposerText("s1", "hello");
  insertComposerText("s1", "tail", "append");
  openComposerControl("s1", "model");
  assert.deepEqual(log, ["insert:cursor:hello", "insert:append:tail", "open:model"]);
  unregister();
});

test("a call for a session that is not mounted is a silent no-op", () => {
  // A tab closed while a request was in flight must not throw on delivery.
  assert.doesNotThrow(() => insertComposerText("gone", "text"));
  assert.doesNotThrow(() => openComposerControl("gone", "mode"));
  assert.equal(composerHandle("gone"), null);
});

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
