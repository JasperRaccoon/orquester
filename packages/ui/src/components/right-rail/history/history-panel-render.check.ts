/**
 * Render smoke checks for the right rail's History & checkpoints panel.
 *
 * `lib/prompt-history/*.test.ts` own the rules (which prompts are listed, the
 * merge, the checkpoint join, the rewind verdicts and counts); this exists
 * because "a collapsed prompt shows its turn and its files", "an open one
 * offers Insert / Send and says why they wait", "the rewind confirm says files
 * stay as they are" and "no chat shows only the empty state" are claims about
 * *markup* — and a prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * Every piece is rendered through its presentational component with fake data;
 * the whole panel is rendered once under a provider, to prove the hook path
 * runs.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Checkpoint } from "@orquester/api/agent-chat";

import { OrquesterProvider, type OrquesterProviderProps } from "../../../context/orquester-context";
import {
  deriveCheckpointEntries,
  type CheckpointEntry
} from "../../../lib/prompt-history/checkpoints.logic";
import type { HistoryPrompt } from "../../../lib/prompt-history/prompts.logic";
import { REWIND_BUSY_TITLE } from "../../agent-chat/composer/RewindControl";
import { TurnDiffBody } from "../../agent-chat/timeline/TurnDiffModal";
import { CheckpointCardView, type CheckpointCardViewProps } from "./CheckpointCard";
import {
  CATCHING_UP_NOTE,
  FALLBACK_NOTE,
  NO_CHAT_TITLE,
  NO_PROMPTS_TITLE,
  PROMPT_PREVIEW_CHARS,
  SEARCH_OLDER_HINT,
  SEARCH_PLACEHOLDER,
  SEARCHING_OLDER,
  STARTED_BY_AGENT,
  WHOLE_TEXT_LOADING,
  type IndexView
} from "./history-format";
import type { RewindView } from "./HistoryParts";
import { PromptCardView, type PromptCardViewProps } from "./PromptCard";
import { PromptHistoryPanel, PromptsBody } from "./PromptHistoryPanel";
import { TurnDiffInline } from "./TurnDiffInline";

const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

const NOOP = (): void => {};

/** The app context the hooks read. A thread store only captures its transport while rendering. */
function withProvider(element: ReactElement): string {
  const context = {
    useTitlebar: false,
    api: {
      agentChat: {
        stream: () => ({ close: () => {}, lastSeq: 0, hostInstanceId: null })
      }
    }
  } as unknown as OrquesterProviderProps;
  return renderToStaticMarkup(createElement(OrquesterProvider, { ...context, children: element }));
}

interface RenderedButton {
  attrs: string;
  text: string;
}

/** Every `<button>` of the markup, with its visible text (tags stripped). */
function buttons(html: string): RenderedButton[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attrs: match[1]!,
    text: match[2]!.replace(/<[^>]+>/g, "").trim()
  }));
}

function button(html: string, text: string): RenderedButton {
  const found = buttons(html).find((candidate) => candidate.text === text);
  assert.ok(found, `a "${text}" button in:\n${html}`);
  return found;
}

const isDisabled = (found: RenderedButton) => /\sdisabled=""/.test(found.attrs);

/** Text as React writes it into markup. */
function escaped(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------------------
// No chat: the empty state, and nothing else — without the app context
// ---------------------------------------------------------------------------

const noChat = renderToStaticMarkup(
  createElement(PromptHistoryPanel, { sessionId: null, projectPath: "/w/p", variant: "docked" })
);
assert.ok(noChat.includes(NO_CHAT_TITLE), "no chat ⇒ says to open one");
assert.ok(!noChat.includes('type="search"'), "no chat ⇒ no search");
assert.ok(!noChat.includes("Checkpoints"), "no chat ⇒ no view switch");
assert.ok(noChat.includes("flex min-h-0 flex-1 flex-col"), "fills the dock's container");

// ---------------------------------------------------------------------------
// A chat: the fixed controls, over a list that is still loading
// ---------------------------------------------------------------------------

const live = withProvider(
  createElement(PromptHistoryPanel, { sessionId: "s1", projectPath: "/w/p", variant: "docked" })
);
assert.ok(live.includes(`placeholder="${escaped(SEARCH_PLACEHOLDER)}"`), "the search field");
assert.ok(/aria-pressed="true"[^>]*>Prompts</.test(live), "Prompts is the default view");
assert.ok(/aria-pressed="false"[^>]*>Checkpoints</.test(live));
assert.ok(live.includes("Loading prompts…"), "no snapshot yet ⇒ loading, never a premature empty state");
assert.ok(live.includes("min-h-0 flex-1 space-y-1.5 overflow-y-auto"), "the list scrolls on its own");

// ---------------------------------------------------------------------------
// A prompt card
// ---------------------------------------------------------------------------

const AT = new Date(2026, 8, 27, 14, 5).toISOString();

function prompt(overrides: Partial<HistoryPrompt> = {}): HistoryPrompt {
  return {
    messageId: "u12",
    text: "Fix the login redirect\nwhen the session expires",
    truncated: false,
    turnId: "t12",
    turnOrdinal: 12,
    createdAt: AT,
    source: "loaded",
    indexRewindable: null,
    ...overrides
  };
}

function rewind(overrides: Partial<RewindView> = {}): RewindView {
  return {
    droppedTurnCount: 2,
    busyReason: null,
    phase: "idle",
    onStart: NOOP,
    onCancel: NOOP,
    onConfirm: NOOP,
    ...overrides
  };
}

function card(overrides: Partial<PromptCardViewProps> = {}): string {
  const props: PromptCardViewProps = {
    prompt: prompt(),
    variant: "docked",
    meta: "Turn 12 · 14:05",
    diff: { fileCount: 3, additions: 20, deletions: 4 },
    expanded: false,
    onToggle: NOOP,
    whole: { status: "ready", text: prompt().text, hostCut: false },
    onRetryWhole: NOOP,
    feedback: null,
    onInsert: NOOP,
    onSend: NOOP,
    onSaveAsPrompt: NOOP,
    onJump: NOOP,
    jumping: false,
    onViewDiff: NOOP,
    rewind: rewind(),
    ...overrides
  };
  return renderToStaticMarkup(createElement(PromptCardView, props));
}

const collapsed = card();
assert.ok(collapsed.includes('aria-expanded="false"'), "collapsed: one button that opens it");
assert.equal(buttons(collapsed).length, 1, "collapsed: no actions yet");
assert.ok(collapsed.includes("line-clamp-2"), "collapsed: the text in two lines");
assert.ok(collapsed.includes("Turn 12 · 14:05"), "the meta line");
assert.ok(collapsed.includes(">3 files<"), "the files chip");
assert.ok(collapsed.includes("+20") && collapsed.includes("−4"), "…with its line counts");
assert.ok(collapsed.includes('title="3 files changed, 20 lines added, 4 lines removed"'));
assert.ok(!card({ diff: null }).includes("files"), "no checkpoint ⇒ no chip");
assert.ok(
  !card({ diff: { fileCount: 0, additions: 0, deletions: 0 } }).includes("No file changes"),
  "a turn that changed nothing gets no chip in the prompt list"
);

// A pasted 200 KB log is never a 200 KB text node, nor the row's accessible name.
const pasted = "L".repeat(200_000);
const collapsedLog = card({ prompt: prompt({ text: pasted }) });
assert.ok(collapsedLog.length < PROMPT_PREVIEW_CHARS + 3_000, "a collapsed card previews its prompt");
assert.ok(collapsedLog.includes("…"), "…and says it was cut");
const confirmingLog = card({
  expanded: true,
  prompt: prompt({ text: pasted }),
  whole: { status: "ready", text: pasted, hostCut: false },
  rewind: rewind({ phase: "confirm" })
});
assert.ok(
  confirmingLog.length < pasted.length + PROMPT_PREVIEW_CHARS + 20_000,
  "an open card shows the whole text once — the confirm quotes a preview, not a second copy"
);

const open = card({ expanded: true });
assert.ok(open.includes('aria-expanded="true"'), "open: its header collapses it");
assert.ok(open.includes("whitespace-pre-wrap") && open.includes("max-h-[40vh]"), "the whole text, scrolling");
assert.ok(open.includes("Fix the login redirect\nwhen the session expires"), "…as sent");
assert.ok(!isDisabled(button(open, "Insert")), "Insert");
assert.ok(!isDisabled(button(open, "Send")), "Send");
for (const action of ["Save as prompt", "Jump to", "View diff", "Rewind to here"]) {
  assert.ok(!isDisabled(button(open, action)), action);
}
assert.ok(button(open, "Insert").attrs.includes("w-full"), "Insert and Send share the row, as in Saved prompts");
assert.ok(!button(open, "Insert").attrs.includes("h-10"), "docked: the app's own button height");
const onPhone = card({ expanded: true, variant: "sheet" });
assert.ok(button(onPhone, "Insert").attrs.includes("h-10"), "in the sheet: finger-sized");
assert.ok(button(onPhone, "Send").attrs.includes("h-10"));
assert.ok(button(onPhone, "Jump to").attrs.includes("h-9"));
assert.ok(card({ variant: "sheet" }).includes("py-3"), "…and so is a collapsed row");

const noTurn = card({ expanded: true, onJump: null, onViewDiff: null, rewind: null });
for (const action of ["Jump to", "View diff", "Rewind to here"]) {
  assert.ok(!buttons(noTurn).some((found) => found.text === action), `${action} is absent when not offered`);
}

const loadingWhole = card({ expanded: true, whole: { status: "loading" } });
assert.ok(loadingWhole.includes(WHOLE_TEXT_LOADING), "a cut prompt says it is reading the rest");
for (const action of ["Insert", "Send", "Save as prompt"]) {
  const found = button(loadingWhole, action);
  assert.ok(isDisabled(found), `${action} waits for the whole text`);
  assert.ok(found.attrs.includes(`title="${WHOLE_TEXT_LOADING}"`), `${action} says why`);
  assert.ok(found.attrs.includes("disabled:pointer-events-auto"), `${action}'s reason shows on hover`);
}

const failedWhole = card({ expanded: true, whole: { status: "failed", error: "Couldn't read the whole prompt." } });
assert.ok(failedWhole.includes('role="alert"') && failedWhole.includes("Couldn&#x27;t read the whole prompt."));
assert.ok(button(failedWhole, "Retry"), "…and offers to try again");
assert.ok(isDisabled(button(failedWhole, "Insert")));

const busy = card({ expanded: true, rewind: rewind({ busyReason: REWIND_BUSY_TITLE }) });
const busyRewind = button(busy, "Rewind to here");
assert.ok(isDisabled(busyRewind), "a rewind waits while the agent works");
assert.ok(busyRewind.attrs.includes(`title="${REWIND_BUSY_TITLE}"`), "…and says so");

const confirming = card({ expanded: true, rewind: rewind({ phase: "confirm" }) });
assert.ok(confirming.includes('data-rewind-confirm="true"'), "the confirm opens inline");
assert.ok(confirming.includes("Removes 2 later turns from this chat."), "…naming what goes");
assert.ok(confirming.includes("Files stay as they are."), "…and what stays");
assert.ok(button(confirming, "Rewind") && button(confirming, "Back"));

const running = card({ expanded: true, rewind: rewind({ phase: "running" }) });
const runningRewind = button(running, "Rewinding…");
assert.ok(isDisabled(runningRewind) && runningRewind.attrs.includes('aria-busy="true"'), "a rewind in flight spins");

assert.ok(card({ expanded: true, jumping: true }).includes("Jumping…"));

const sent = card({ expanded: true, feedback: { tone: "ok", text: "Sent" } });
assert.ok(/role="status"[^>]*>(<svg[\s\S]*?<\/svg>)?Sent</.test(sent), "success is a status");
assert.ok(sent.includes("lucide-check"), "…with the Saved prompts panel's check mark");
const refused = card({ expanded: true, feedback: { tone: "error", text: "Open the chat to send to it." } });
assert.ok(/role="alert"[^>]*>Open the chat to send to it.</.test(refused), "a refusal is an alert");
assert.ok(refused.includes("text-danger"));

// ---------------------------------------------------------------------------
// A checkpoint card
// ---------------------------------------------------------------------------

function checkpointEntry(
  files: Checkpoint["files"],
  opener: "prompt" | "agent"
): CheckpointEntry {
  const checkpoint: Checkpoint = {
    turnId: "t7",
    checkpointTurnCount: 7,
    checkpointRef: "refs/orquester/checkpoints/x/turn/7",
    status: "ready",
    files,
    assistantMessageId: null,
    completedAt: AT
  };
  const turn = {
    turnId: "t7",
    state: "completed" as const,
    turnCount: 7,
    requestedAt: AT,
    startedAt: AT,
    completedAt: AT,
    assistantMessageId: null,
    ...(opener === "prompt" ? { userMessageId: "u7" } : {})
  };
  return deriveCheckpointEntries({
    ready: [checkpoint],
    turns: [turn],
    ordinals: new Map([["t7", 7]]),
    prompts: [prompt({ messageId: "u7", turnId: "t7", turnOrdinal: 7, text: "Add the settings page" })],
    unlisted: new Map()
  })[0]!;
}

function checkpointCard(overrides: Partial<CheckpointCardViewProps> = {}): string {
  const props: CheckpointCardViewProps = {
    variant: "docked",
    entry: checkpointEntry(
      [
        { path: "src/settings/page.tsx", additions: 18, deletions: 2 },
        { path: "README.md", additions: 2, deletions: 2 }
      ],
      "prompt"
    ),
    meta: "Turn 7 · 14:05",
    expanded: false,
    onToggle: NOOP,
    onViewDiff: NOOP,
    rewind: rewind(),
    feedback: null,
    ...overrides
  };
  return renderToStaticMarkup(createElement(CheckpointCardView, props));
}

const shut = checkpointCard();
assert.ok(shut.includes("Turn 7 · 14:05") && shut.includes(">2 files<"), "turn, time and files");
assert.ok(shut.includes("Add the settings page"), "the prompt that started it");
assert.equal(buttons(shut).length, 1, "collapsed: just its header");

const longOrigin = checkpointEntry([], "prompt");
if (longOrigin.origin.kind === "prompt") {
  const quoted = checkpointCard({
    entry: { ...longOrigin, origin: { kind: "prompt", prompt: prompt({ messageId: "u7", text: pasted }) } }
  });
  assert.ok(quoted.length < PROMPT_PREVIEW_CHARS + 3_000, "a checkpoint's opening prompt is a one-line preview");
}

const byAgent = checkpointCard({ entry: checkpointEntry([], "agent") });
assert.ok(byAgent.includes(STARTED_BY_AGENT), "a turn nobody prompted");
assert.ok(byAgent.includes("No file changes"), "a checkpoint that changed nothing says so");

const unfolded = checkpointCard({ expanded: true });
assert.ok(unfolded.includes('aria-label="Changed files"'), "the changed files");
assert.ok(unfolded.includes(">page.tsx<") && unfolded.includes(">src/settings<"), "name first, folder after");
assert.ok(unfolded.includes('title="src/settings/page.tsx"'), "the whole path on hover");
assert.ok(button(unfolded, "View diff") && button(unfolded, "Rewind to here"));
assert.ok(
  !buttons(checkpointCard({ expanded: true, rewind: null })).some((found) => found.text === "Rewind to here"),
  "no prompt to go back to ⇒ no rewind"
);

const many = checkpointCard({
  expanded: true,
  entry: checkpointEntry(
    Array.from({ length: 53 }, (_, index) => ({ path: `src/f${index}.ts`, additions: 1, deletions: 0 })),
    "prompt"
  )
});
assert.equal((many.match(/<li /g) ?? []).length, 50, "at most fifty files listed");
assert.ok(many.includes("+3 more"), "…and how many more");

// ---------------------------------------------------------------------------
// The Prompts view's edges and empty states
// ---------------------------------------------------------------------------

function body(overrides: Partial<Parameters<typeof PromptsBody>[0]> = {}): string {
  const props: Parameters<typeof PromptsBody>[0] = {
    prompts: [prompt()],
    total: 1,
    query: "",
    index: { kind: "ready", hasOlder: false, loadingOlder: false, olderError: null, autoPaging: false },
    loading: false,
    renderPrompt: (item) => createElement("div", { key: item.messageId, "data-card": item.messageId }),
    onShowMore: NOOP,
    onLoadOlder: NOOP,
    onRetry: NOOP,
    ...overrides
  };
  return renderToStaticMarkup(createElement(PromptsBody, props));
}

const ready = (overrides: Partial<Extract<IndexView, { kind: "ready" }>> = {}): IndexView => ({
  kind: "ready",
  hasOlder: true,
  loadingOlder: false,
  olderError: null,
  autoPaging: false,
  ...overrides
});

assert.ok(body().includes('data-card="u12"'), "the cards");
assert.ok(!body().includes("Load older prompts"), "nothing older ⇒ no button");
assert.ok(!isDisabled(button(body({ index: ready() }), "Load older prompts")), "older pages ⇒ the button");
const loadingOlder = button(body({ index: ready({ loadingOlder: true }) }), "Loading older prompts…");
assert.ok(isDisabled(loadingOlder), "…spinning, not pressable twice");
const olderFailed = body({ index: ready({ olderError: "Couldn't load older prompts." }) });
assert.ok(olderFailed.includes('role="alert"') && button(olderFailed, "Load older prompts"), "a failed page, retryable");
assert.ok(body({ index: { kind: "loading" } }).includes("Loading older prompts…"), "the first page on its way");

const fallback = body({
  index: { kind: "fallback", note: FALLBACK_NOTE, busy: false, retryable: true, detail: "Offline" }
});
assert.ok(fallback.includes(FALLBACK_NOTE) && fallback.includes('title="Offline"'), "the fallback note");
assert.ok(button(fallback, "Retry"), "…retryable after a failure");
const unindexed = body({
  index: { kind: "fallback", note: FALLBACK_NOTE, busy: false, retryable: false, detail: null }
});
assert.ok(unindexed.includes(FALLBACK_NOTE) && !buttons(unindexed).some((found) => found.text === "Retry"));
const indexing = body({
  prompts: [],
  total: 0,
  loading: true,
  index: { kind: "fallback", note: CATCHING_UP_NOTE, busy: true, retryable: false, detail: null }
});
assert.ok(indexing.includes(escaped(CATCHING_UP_NOTE)), "the host is still indexing: said so");
assert.ok(indexing.includes("animate-spin"), "…while it asks again by itself");
assert.ok(!buttons(indexing).some((found) => found.text === "Retry"), "…with nothing to press");
assert.ok(indexing.includes("Loading prompts…"), "…and no premature \"No prompts yet\"");

// The render cap: the list mounts the first cards, the rest behind "Show more".
const hundreds = Array.from({ length: 450 }, (_, index) => prompt({ messageId: `m${index}` }));
const capped = body({ prompts: hundreds, total: 450, renderLimit: 200, index: ready() });
assert.equal((capped.match(/data-card=/g) ?? []).length, 200, "200 cards mounted");
assert.ok(button(capped, "Show 200 more"), "…and the next 200 one press away");
assert.ok(!capped.includes("Load older prompts"), "older pages wait until every loaded prompt is shown");
const lastStep = body({ prompts: hundreds, total: 450, renderLimit: 400, index: ready() });
assert.ok(button(lastStep, "Show 50 more"));
const allShown = body({ prompts: hundreds, total: 450, renderLimit: 600, index: ready() });
assert.equal((allShown.match(/data-card=/g) ?? []).length, 450);
assert.ok(button(allShown, "Load older prompts"), "all shown: older pages again");

// A search pages the rest of the thread in by itself — said, not offered.
const paging = body({ index: ready({ autoPaging: true }) });
assert.ok(paging.includes(SEARCHING_OLDER), "a search paging older prompts in says so");
assert.ok(!paging.includes("Load older prompts"), "…and offers no button while it runs");
const pagingNoMatch = body({ prompts: [], total: 4, query: "zebra", index: ready({ autoPaging: true }) });
assert.ok(pagingNoMatch.includes(SEARCHING_OLDER) && !pagingNoMatch.includes(SEARCH_OLDER_HINT));

assert.ok(body({ prompts: [], total: 0 }).includes(NO_PROMPTS_TITLE), "no prompts yet");
assert.ok(body({ prompts: [], total: 0, loading: true }).includes("Loading prompts…"));
const noMatch = body({ prompts: [], total: 4, query: "zebra", index: ready() });
assert.ok(noMatch.includes("No prompts match “zebra”"), "a search with no match");
assert.ok(noMatch.includes(SEARCH_OLDER_HINT) && button(noMatch, "Load older prompts"), "…and where to look further");

// ---------------------------------------------------------------------------
// A turn's diff
// ---------------------------------------------------------------------------

assert.ok(renderToStaticMarkup(createElement(TurnDiffBody, { state: { loading: true } })).includes("Loading diff…"));
assert.ok(
  renderToStaticMarkup(createElement(TurnDiffBody, { state: { loading: false, diff: "" } })).includes(
    "This turn changed no files."
  )
);
const diffError = renderToStaticMarkup(
  createElement(TurnDiffBody, { state: { loading: false, error: "That turn's diff could not be read." } })
);
assert.ok(diffError.includes("text-danger") && diffError.includes("diff could not be read"));
const inline = withProvider(
  createElement(TurnDiffInline, { request: { sessionId: "s1", turnCount: 7, title: "Turn 7" }, onBack: NOOP })
);
assert.ok(inline.includes("Turn 7") && button(inline, "Back") && inline.includes("Loading diff…"), "the sheet's inline diff");
assert.ok(inline.includes('role="region"') && inline.includes('aria-label="Turn 7"'), "…a named region over the list");

console.log("history-panel-render.check: ok");
