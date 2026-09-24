/**
 * Render smoke checks for the command palette's "Search conversations" mode
 * (design 2026-09-23 §C "Search", "Client").
 *
 * `conversation-search.test.ts` owns the decisions; this exists because "a
 * hit shows its thread, project, speaker, the matched words and when",
 * "the highlighted hit is the selected option", "an unavailable index and an
 * empty answer each say so" and "the mode chip reports its state" are claims
 * about markup — a prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSearchHit } from "@orquester/api/agent-chat";

import {
  ConversationSearchChip,
  ConversationSearchResults,
  type ConversationSearchRow
} from "./ConversationSearchResults";

const NOOP = (): void => {};

const hit = (overrides: Partial<ThreadSearchHit>): ThreadSearchHit => ({
  threadId: "s1",
  projectPath: "/w/orquester",
  title: "Index title",
  turnId: "t1",
  ordinal: 1,
  kind: "message",
  id: "m1",
  role: "user",
  activityKind: null,
  snippet: "rename «formatBytes» everywhere",
  at: "2026-09-22T10:00:00.000Z",
  seq: 4,
  ...overrides
});

const row = (key: string, overrides: Partial<ConversationSearchRow> & { hit: ThreadSearchHit }): ConversationSearchRow => ({
  key,
  title: "Rename the helper",
  project: { name: "orquester", workspace: "jaspersito", path: "/w/orquester", isArchived: false },
  icon: null,
  ...overrides
});

function results(props: Partial<Parameters<typeof ConversationSearchResults>[0]>): string {
  return renderToStaticMarkup(
    createElement(ConversationSearchResults, {
      rows: [],
      notice: null,
      highlighted: 0,
      optionId: (candidate: ConversationSearchRow) => `option-${candidate.key}`,
      onHover: NOOP,
      onSelect: NOOP,
      ...props
    }) as ReactElement
  );
}

// ---------------------------------------------------------------------------
// Hits
// ---------------------------------------------------------------------------

const rows = [
  row("a", { hit: hit({}) }),
  row("b", {
    title: "Fix the flaky test",
    hit: hit({
      threadId: "s2",
      id: "m9",
      role: "assistant",
      snippet: "the «flaky» one",
      at: "2026-09-21T08:00:00.000Z"
    })
  })
];
const listed = results({ rows, highlighted: 1 });

assert.equal((listed.match(/role="option"/g) ?? []).length, 2, "one option per hit");
assert.ok(listed.includes("Rename the helper") && listed.includes("Fix the flaky test"), "the thread titles");
assert.ok(listed.includes("orquester"), "the project name");
assert.ok(listed.includes(">You<") && listed.includes(">Assistant<"), "who said it");
assert.ok(
  /data-snippet-match[^>]*>formatBytes</.test(listed) && /data-snippet-match[^>]*>flaky</.test(listed),
  "the matched words are highlighted, the marks themselves are gone"
);
assert.ok(!listed.includes("«") && !listed.includes("»"), "no raw marks reach the screen");
assert.ok(listed.includes("rename ") && listed.includes(" everywhere"), "the words around the match");
assert.ok(
  listed.includes('dateTime="2026-09-22T10:00:00.000Z"') || listed.includes('datetime="2026-09-22T10:00:00.000Z"'),
  "when it was said, machine-readable beside the relative label"
);
assert.ok(/id="option-b"[^>]*aria-selected="true"/.test(listed) || /aria-selected="true"[^>]*id="option-b"/.test(listed), "the highlighted hit is the selected option");
assert.ok(/id="option-a"[^>]*aria-selected="false"/.test(listed) || /aria-selected="false"[^>]*id="option-a"/.test(listed));
assert.ok(!listed.includes("data-search-notice"), "nothing to say while there are hits");

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

const unavailable = results({ notice: { kind: "unavailable", text: "Search is unavailable on this host" } });
assert.ok(
  /data-search-notice="unavailable"[^>]*>Search is unavailable on this host</.test(unavailable),
  "an unavailable index says so"
);
assert.ok(!unavailable.includes('role="option"'));

assert.ok(!unavailable.includes(">Try again<"), "an unavailable index is not something to retry");

const empty = results({ notice: { kind: "empty", text: "No matches" } });
assert.ok(/data-search-notice="empty"[^>]*>No matches</.test(empty), "an empty answer says so");

const failed = results({
  notice: { kind: "error", text: "Couldn't reach the agent host — try again" },
  onRetry: NOOP
});
assert.ok(failed.includes("reach the agent host"), "a failed request says so in words");
assert.ok(/<button[^>]*>Try again<\/button>/.test(failed), "and offers the retry it promises");

const truncated = results({
  rows,
  notice: { kind: "truncated", text: "More matches than shown — keep typing to narrow them" }
});
assert.ok(
  truncated.indexOf("More matches than shown") > truncated.lastIndexOf('role="option"'),
  "the truncation note sits under the hits, not instead of them"
);

// ---------------------------------------------------------------------------
// The mode chip
// ---------------------------------------------------------------------------

const off = renderToStaticMarkup(createElement(ConversationSearchChip, { active: false, onToggle: NOOP }));
const on = renderToStaticMarkup(createElement(ConversationSearchChip, { active: true, onToggle: NOOP }));
assert.ok(off.includes('aria-pressed="false"') && on.includes('aria-pressed="true"'), "the chip reports the mode");
assert.ok(off.includes('aria-label="Search conversations"'), "and names what it toggles");

console.log("conversation-search render checks passed");
