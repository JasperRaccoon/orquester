import assert from "node:assert/strict";
import test from "node:test";

import {
  checkpointRefForThreadTurn,
  checkpointRefNamespace,
  turnCountFromCheckpointRef
} from "./refs.ts";

test("a checkpoint ref is the thread's base64url namespace plus its turn", () => {
  const ref = checkpointRefForThreadTurn("thread-1", 7);
  assert.equal(ref, "refs/orquester/checkpoints/dGhyZWFkLTE/turn/7");
});

test("the namespace stays inside git's safe ref alphabet for an awkward thread id", () => {
  const threadId = "a b/../~^:?*[\\{@}.lock";
  const namespace = checkpointRefNamespace(threadId);
  const encoded = namespace.slice("refs/orquester/checkpoints/".length);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), threadId);
});

test("an empty thread id or a bad turn count is refused rather than encoded", () => {
  assert.throws(() => checkpointRefNamespace(""), TypeError);
  assert.throws(() => checkpointRefForThreadTurn("t", -1), TypeError);
  assert.throws(() => checkpointRefForThreadTurn("t", 1.5), TypeError);
});

test("turn counts round-trip, and nothing else is read as a checkpoint", () => {
  assert.equal(turnCountFromCheckpointRef("t", "refs/orquester/checkpoints/dA/turn/0"), 0);
  assert.equal(turnCountFromCheckpointRef("t", "refs/orquester/checkpoints/dA/turn/42"), 42);
  const namespace = "refs/orquester/checkpoints/dA";
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/007`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/-1`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/turn/1/extra`), null);
  assert.equal(turnCountFromCheckpointRef("t", `${namespace}/other/1`), null);
  assert.equal(turnCountFromCheckpointRef("t", "refs/heads/main"), null);
  // Another thread's ref, even one whose encoding starts with ours.
  assert.equal(turnCountFromCheckpointRef("t", "refs/orquester/checkpoints/dDI/turn/1"), null);
});
