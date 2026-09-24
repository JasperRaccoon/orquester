import test from "node:test";
import assert from "node:assert/strict";

import {
  composerHandle,
  insertComposerText,
  openComposerControl,
  registerComposerHandle,
  sendComposerText,
  stageComposerAttachment,
  type ComposerHandle
} from "./composer-bridge.ts";

function fakeHandle(log: string[], stageResult = true, sendResult = true): ComposerHandle {
  return {
    insertText: (text, mode) => log.push(`insert:${mode ?? "cursor"}:${text}`),
    stageAttachment: (ref) => {
      log.push(`stage:${ref.id}`);
      return stageResult;
    },
    focusAtEnd: () => log.push("focus"),
    openControl: (command) => log.push(`open:${command}`),
    sendText: (text) => {
      log.push(`send:${text}`);
      return sendResult;
    }
  };
}

const REF = { type: "file", id: "/tmp/a.txt", name: "a.txt", sizeBytes: 1 } as const;

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

test("staging an uploaded ref reaches the mounted composer", () => {
  const log: string[] = [];
  const unregister = registerComposerHandle("s3", fakeHandle(log));
  assert.equal(stageComposerAttachment("s3", REF), true);
  assert.deepEqual(log, ["stage:/tmp/a.txt"]);
  unregister();
});

test("staging reports false when no composer is mounted, so the caller can fall back", () => {
  // The fallback is writing the path into the draft: a file that vanishes
  // between the picker and the message is worse than a visible path.
  assert.equal(stageComposerAttachment("never-mounted", REF), false);
});

test("staging reports false when the composer refuses it", () => {
  const log: string[] = [];
  const unregister = registerComposerHandle("s4", fakeHandle(log, false));
  assert.equal(stageComposerAttachment("s4", REF), false);
  unregister();
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

test("goals §8.2: a chip action is sent BY the mounted composer, never around it", () => {
  const log: string[] = [];
  const unregister = registerComposerHandle("s5", fakeHandle(log));
  assert.equal(sendComposerText("s5", "/goal pause"), true);
  assert.deepEqual(log, ["send:/goal pause"], "the composer's own send path, and nothing else");
  unregister();
});

test("goals §8.2: a refused or unmounted send reports false", () => {
  // The composer says why in its own notice; the caller only learns it did not go.
  const log: string[] = [];
  const unregister = registerComposerHandle("s6", fakeHandle(log, true, false));
  assert.equal(sendComposerText("s6", "/goal clear"), false);
  unregister();
  assert.equal(sendComposerText("never-mounted", "/goal clear"), false);
});
