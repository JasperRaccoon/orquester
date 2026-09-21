import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECKPOINT_REFS_PREFIX,
  checkpointRefForThreadTurn,
  checkpointRefNamespace,
  turnCountFromCheckpointRef
} from "./refs.ts";

test("a checkpoint ref is the thread's base64url namespace plus its turn", () => {
  const ref = checkpointRefForThreadTurn("thread-1", 7);
  assert.equal(ref, `${CHECKPOINT_REFS_PREFIX}/${Buffer.from("thread-1").toString("base64url")}/turn/7`);
  assert.ok(ref.startsWith("refs/orquester/checkpoints/"));
});

test("the namespace stays inside git's safe ref alphabet for an awkward thread id", () => {
  const threadId = "a b/../~^:?*[\\{@}.lock";
  const namespace = checkpointRefNamespace(threadId);
  const encoded = namespace.slice(`${CHECKPOINT_REFS_PREFIX}/`.length);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), threadId);
});

test("an empty thread id or a bad turn count is refused rather than encoded", () => {
  assert.throws(() => checkpointRefNamespace(""), TypeError);
  assert.throws(() => checkpointRefForThreadTurn("t", -1), TypeError);
  assert.throws(() => checkpointRefForThreadTurn("t", 1.5), TypeError);
});

test("turn counts round-trip, and nothing else is read as a checkpoint", () => {
  assert.equal(turnCountFromCheckpointRef("t", checkpointRefForThreadTurn("t", 0)), 0);
  assert.equal(turnCountFromCheckpointRef("t", checkpointRefForThreadTurn("t", 42)), 42);
  const namespace = checkpointRefNamespace("t");
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/007`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/-1`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/1/extra`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/other/1`), null);
  assert.equal(turnCountFromCheckpointRef("t", "refs/heads/main"), null);
  // Another thread's ref, even one whose encoding starts with ours.
  assert.equal(turnCountFromCheckpointRef("t", checkpointRefForThreadTurn("t2", 1)), null);
});
