import test from "node:test";
import assert from "node:assert/strict";

import {
  composerHandle,
  insertComposerText,
  openComposerControl,
  registerComposerHandle,
  restoreComposerFailedSend,
  stageComposerAttachment,
  type ComposerHandle
} from "./composer-bridge.ts";
import type { StagedAttachment } from "./ComposerAttachments";
import type { FailedSendRestore } from "./composer-submission";

function fakeHandle(log: string[], stageResult = true, showsThread = true): ComposerHandle {
  return {
    insertText: (text, mode) => log.push(`insert:${mode ?? "cursor"}:${text}`),
    stageAttachment: (ref) => {
      log.push(`stage:${ref.id}`);
      return stageResult;
    },
    focusAtEnd: () => log.push("focus"),
    openControl: (command) => log.push(`open:${command}`),
    restoreFailedSend: (restore) => {
      log.push(`restore:${restore.outcome.notice}`);
      return showsThread;
    }
  };
}

const FAILED: FailedSendRestore<StagedAttachment> = {
  outcome: { kind: "failed", text: "hello", notice: "Could not send the message." },
  sent: []
};

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

test("a failed send's draft reaches the composer that shows its thread", () => {
  const log: string[] = [];
  const unregister = registerComposerHandle("s5", fakeHandle(log));
  assert.equal(restoreComposerFailedSend("s5", FAILED), true);
  assert.deepEqual(log, ["restore:Could not send the message."]);
  unregister();
});

test("a failed send is refused when no composer shows its thread, so the caller writes its persisted draft", () => {
  assert.equal(restoreComposerFailedSend("never-mounted", FAILED), false);
  // A composer can refuse too: it no longer shows the thread its handle names.
  const log: string[] = [];
  const unregister = registerComposerHandle("s6", fakeHandle(log, true, false));
  assert.equal(restoreComposerFailedSend("s6", FAILED), false);
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
