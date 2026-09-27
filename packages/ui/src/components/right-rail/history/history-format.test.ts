import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CATCH_UP_MAX_ATTEMPTS, type PromptIndexState } from "../../../lib/prompt-history/index-cache";
import {
  CATCHING_UP_GAVE_UP,
  CATCHING_UP_NOTE,
  checkpointMetaLabel,
  deliveryFeedback,
  diffSummaryTitle,
  FALLBACK_NOTE,
  filesLabel,
  indexViewOf,
  noMatchTitle,
  previewText,
  PROMPT_PREVIEW_CHARS,
  promptMetaLabel,
  showMoreLabel
} from "./history-format";

// Local time, as the row timestamps are shown.
const AT = new Date(2026, 8, 27, 14, 5).toISOString();
const NOW = new Date(2026, 8, 27, 18, 30);

describe("promptMetaLabel", () => {
  it("says which turn the prompt started, a steer, or just when", () => {
    assert.equal(promptMetaLabel({ turnOrdinal: 12, turnId: "t12", createdAt: AT }, NOW), "Turn 12 · 14:05");
    assert.equal(promptMetaLabel({ turnOrdinal: null, turnId: "t12", createdAt: AT }, NOW), "Steer · 14:05");
    assert.equal(promptMetaLabel({ turnOrdinal: null, turnId: null, createdAt: AT }, NOW), "14:05");
    assert.equal(
      promptMetaLabel({ turnOrdinal: 3, turnId: "t3", createdAt: "not a date" }, NOW),
      "Turn 3",
      "an unreadable stamp shrinks the line, never poisons it"
    );
  });

  it("names the day once the prompt is older than today", () => {
    const yesterday = new Date(2026, 8, 26, 9, 0).toISOString();
    assert.equal(checkpointMetaLabel(4, yesterday, NOW), "Turn 4 · Yesterday 09:00");
  });
});

describe("the files chip", () => {
  it("counts files, and says the lines in full for its tooltip", () => {
    assert.equal(filesLabel(1), "1 file");
    assert.equal(filesLabel(3), "3 files");
    assert.equal(filesLabel(0), "No file changes");
    assert.equal(
      diffSummaryTitle({ fileCount: 3, additions: 20, deletions: 1 }),
      "3 files changed, 20 lines added, 1 line removed"
    );
    assert.equal(diffSummaryTitle({ fileCount: 1, additions: 0, deletions: 0 }), "1 file changed");
    assert.equal(diffSummaryTitle({ fileCount: 0, additions: 0, deletions: 0 }), "This turn changed no files");
  });
});

describe("deliveryFeedback", () => {
  it("says what an Insert or a Send did, or why it could not", () => {
    assert.deepEqual(deliveryFeedback({ ok: true, disposition: "inserted" }), { tone: "ok", text: "Inserted" });
    assert.deepEqual(deliveryFeedback({ ok: true, disposition: "sent" }), { tone: "ok", text: "Sent" });
    assert.deepEqual(deliveryFeedback({ ok: true, disposition: "queued" }), {
      tone: "ok",
      text: "Queued — sends when the current turn finishes"
    });
    assert.deepEqual(deliveryFeedback({ ok: false, reason: "Open the chat to send to it." }), {
      tone: "error",
      text: "Open the chat to send to it."
    });
  });
});

describe("indexViewOf", () => {
  const base: PromptIndexState = {
    status: "ready",
    prompts: [],
    before: "c1",
    loadingOlder: false,
    olderError: null,
    error: null,
    catchUpAttempts: 0,
    refreshing: false
  };

  it("maps the cache's states onto the list's edges", () => {
    assert.deepEqual(indexViewOf(undefined), { kind: "loading" });
    assert.deepEqual(indexViewOf({ ...base, status: "loading" }), { kind: "loading" });
    assert.deepEqual(indexViewOf(base), {
      kind: "ready",
      hasOlder: true,
      loadingOlder: false,
      olderError: null,
      autoPaging: false
    });
    assert.deepEqual(indexViewOf({ ...base, before: null }), {
      kind: "ready",
      hasOlder: false,
      loadingOlder: false,
      olderError: null,
      autoPaging: false
    });
    assert.deepEqual(indexViewOf({ ...base, status: "unindexed" }), {
      kind: "fallback",
      note: FALLBACK_NOTE,
      busy: false,
      retryable: false,
      detail: null
    });
    assert.deepEqual(indexViewOf({ ...base, status: "failed", error: "Offline" }), {
      kind: "fallback",
      note: FALLBACK_NOTE,
      busy: false,
      retryable: true,
      detail: "Offline"
    });
  });

  it("says the host is still indexing while it asks by itself, and offers Retry once it gave up", () => {
    const catching: PromptIndexState = { ...base, status: "catchingUp", catchUpAttempts: 2 };
    assert.deepEqual(indexViewOf(catching), {
      kind: "fallback",
      note: CATCHING_UP_NOTE,
      busy: true,
      retryable: false,
      detail: null
    });
    assert.deepEqual(indexViewOf({ ...catching, catchUpAttempts: CATCH_UP_MAX_ATTEMPTS + 1 }), {
      kind: "fallback",
      note: FALLBACK_NOTE,
      busy: false,
      retryable: true,
      detail: CATCHING_UP_GAVE_UP
    });
    assert.deepEqual(
      indexViewOf({ ...catching, catchUpAttempts: CATCH_UP_MAX_ATTEMPTS + 1, refreshing: true }),
      { kind: "fallback", note: CATCHING_UP_NOTE, busy: true, retryable: false, detail: null },
      "the user's Retry is on its way"
    );
  });

  it("reads a search's own paging, and only while a search is typed", () => {
    assert.equal((indexViewOf(base, { searching: true }) as { autoPaging: boolean }).autoPaging, true);
    assert.equal((indexViewOf(base, { searching: false }) as { autoPaging: boolean }).autoPaging, false);
    assert.equal(
      (indexViewOf({ ...base, olderError: "down" }, { searching: true }) as { autoPaging: boolean }).autoPaging,
      false,
      "a failed page stops it: Load older prompts is offered again"
    );
  });
});

describe("previewText", () => {
  it("keeps a short text whole", () => {
    assert.equal(previewText("Fix the login redirect"), "Fix the login redirect");
  });

  it("cuts a long one — a pasted 200 KB log becomes a few hundred characters", () => {
    const log = "x".repeat(200_000);
    const preview = previewText(log);
    assert.equal(preview.length, PROMPT_PREVIEW_CHARS + 1);
    assert.ok(preview.endsWith("…"));
  });

  it("never ends on half a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀${"b".repeat(10)}`;
    const preview = previewText(text, 10);
    assert.equal(preview, `${"a".repeat(9)}…`);
  });
});

describe("showMoreLabel", () => {
  it("offers the next step, or what is left", () => {
    assert.equal(showMoreLabel(1_234), "Show 200 more");
    assert.equal(showMoreLabel(37), "Show 37 more");
  });
});

describe("noMatchTitle", () => {
  it("quotes the query as typed, trimmed", () => {
    assert.equal(noMatchTitle("prompts", "  login bug "), "No prompts match “login bug”");
    assert.equal(noMatchTitle("checkpoints", "x"), "No checkpoints match “x”");
  });
});
