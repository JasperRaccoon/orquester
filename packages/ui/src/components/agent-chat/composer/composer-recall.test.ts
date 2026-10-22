// Cases adapted from T3 Code (MIT): apps/web/src/components/chat/composerPromptHistory.test.ts
import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadItem, ThreadMessageItem } from "@orquester/api/agent-chat";
import { PLAN_IMPLEMENTATION_PROMPT_PREFIX } from "@orquester/api/agent-chat";

import {
  buildPromptRecallEntries,
  promptRecallDirection,
  stepPromptRecall,
  type PromptRecallKey,
  type PromptRecallPosition
} from "./composer-recall";

function message(id: string, role: "user" | "assistant", text: string, extra: Partial<ThreadMessageItem> = {}): ThreadItem {
  return {
    kind: "message",
    id,
    role,
    text,
    streaming: false,
    turnId: null,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:00:00.000Z",
    ...extra
  } as ThreadItem;
}

const entries = buildPromptRecallEntries([
  message("m1", "user", "first"),
  message("a1", "assistant", "reply"),
  message("m2", "user", "second"),
  message("m3", "user", "third")
]);

const backward = (position: PromptRecallPosition | null, currentPrompt: string) =>
  stepPromptRecall({ direction: "backward", entries, position, currentPrompt });
const forward = (position: PromptRecallPosition | null, currentPrompt: string) =>
  stepPromptRecall({ direction: "forward", entries, position, currentPrompt });

test("the entries: the parent's own typed prompts, oldest first, repeats collapsed onto the newest", () => {
  const built = buildPromptRecallEntries([
    message("m1", "user", "same"),
    message("m2", "user", "same"),
    message("m3", "user", "other"),
    message("m4", "user", "same"),
    message("sub", "user", "a subagent's prompt", { agentId: "agent-1" }),
    message("internal", "user", "<task-notification>done</task-notification>"),
    message("compact", "user", "/compact"),
    message("plan", "user", `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}# Plan`),
    message("image", "user", "[Image #1]"),
    message("placeholder", "user", "look at [Image #1] closely"),
    message("thread", "user", "[Sent by thread x]\n\nhello", { context: [{ kind: "thread-message", label: "x" }] }),
    message("merge", "user", "merged result", { context: [{ kind: "merge-back", label: "child" }] })
  ]);
  assert.deepEqual(built, [
    { id: "m2", prompt: "same" },
    { id: "m3", prompt: "other" },
    { id: "m4", prompt: "same" },
    { id: "placeholder", prompt: "look at closely" }
  ]);
});

test("walks back from the newest prompt", () => {
  const first = backward(null, "");
  assert.deepEqual(first, { position: { entryId: "m3", recalled: "third" }, prompt: "third" });
  assert.equal(backward(first!.position, "third")?.prompt, "second");
  assert.equal(backward({ entryId: "m1", recalled: "first" }, "first"), null, "nothing older");
});

test("walks forward, and past the newest prompt empties the composer", () => {
  const newer = forward({ entryId: "m2", recalled: "second" }, "second");
  assert.equal(newer?.prompt, "third");
  assert.deepEqual(forward(newer!.position, "third"), { position: null, prompt: "" });
  assert.equal(forward(null, ""), null, "forward from the draft is the caret's");
});

test("a draft the user typed, or an edited recall, is never replaced", () => {
  assert.equal(backward(null, "my own words"), null);
  const position: PromptRecallPosition = { entryId: "m3", recalled: "third" };
  assert.equal(backward(position, "third edited"), null);
  assert.equal(forward(position, "third edited"), null);
  assert.deepEqual(backward(position, "")?.position, { entryId: "m3", recalled: "third" });
});

test("follows the entry by id when the list grows under it", () => {
  const grown = buildPromptRecallEntries([
    message("m0", "user", "zeroth"),
    message("m1", "user", "A"),
    message("m2", "user", "B"),
    message("m3", "user", "A")
  ]);
  const older = stepPromptRecall({
    direction: "backward",
    entries: grown,
    position: { entryId: "m1", recalled: "A" },
    currentPrompt: "A"
  });
  assert.equal(older?.prompt, "zeroth");
});

const KEY: PromptRecallKey = {
  key: "ArrowUp",
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  menuOpen: false,
  questionPending: false,
  draftHasExtras: false,
  caretOnEdge: () => true
};

test("the arrows walk the history only from the edge line, with nothing else claiming them", () => {
  assert.equal(promptRecallDirection(KEY), "backward");
  assert.equal(promptRecallDirection({ ...KEY, key: "ArrowDown" }), "forward");
  for (const claimed of [
    { key: "ArrowLeft" },
    { shiftKey: true },
    { altKey: true },
    { metaKey: true },
    { ctrlKey: true },
    { isComposing: true },
    { menuOpen: true },
    { questionPending: true },
    { draftHasExtras: true }
  ]) {
    assert.equal(promptRecallDirection({ ...KEY, ...claimed }), null, JSON.stringify(claimed));
  }
  const edges: string[] = [];
  const midText = {
    ...KEY,
    caretOnEdge: (edge: "start" | "end") => {
      edges.push(edge);
      return false;
    }
  };
  assert.equal(promptRecallDirection(midText), null, "a caret below the first line moves up first");
  assert.equal(promptRecallDirection({ ...midText, key: "ArrowDown" }), null);
  assert.deepEqual(edges, ["start", "end"], "ArrowUp asks for the first line, ArrowDown the last");
});
