/**
 * ArrowUp / ArrowDown prompt recall (§7.4): walk back through this chat's own
 * sent prompts from an empty composer, and forward again to the empty draft.
 *
 * The rules are T3's:
 *
 *  - **Recall starts only from an empty composer.** Text the user typed is
 *    theirs, so a non-empty draft that is not an unedited recall leaves the
 *    arrows to the caret. Editing a recalled prompt makes it a fresh draft.
 *  - **The caret must be on the edge it moves past**: the first visual line
 *    for ArrowUp, the last for ArrowDown — a wrapped or multi-line prompt
 *    moves the caret line by line until it reaches that edge.
 *  - **Never with a modifier, an IME composition, an open slash or mention
 *    menu** (the menu's highlight takes the arrows), **a pending question**
 *    (the composer is answering it), **or anything attached or quoted** — a
 *    recall is text only and must not drop what the draft holds.
 *  - Forward past the newest prompt empties the composer (the draft recall
 *    started from was empty).
 *  - Only what the user typed: provider-internal rows, `/compact`, the plan's
 *    Implement prompt and image-only messages (`recallablePromptText`), and
 *    messages another chat or Orquester sent, are skipped; consecutive repeats
 *    collapse onto the newest.
 */

import {
  isMergeBackMessage,
  isThreadAuthoredMessage,
  isToolsetContinueMessage,
  recallablePromptText
} from "@orquester/api/agent-chat";
import type { ThreadItem } from "@orquester/api/agent-chat";

export interface PromptRecallEntry {
  /** The message id, so a position survives the list changing under it. */
  id: string;
  prompt: string;
}

/** Where the composer is in the history: the entry shown, and its text as recalled. */
export interface PromptRecallPosition {
  entryId: string;
  recalled: string;
}

export interface PromptRecallStep {
  /** `null`: back at the empty draft. */
  position: PromptRecallPosition | null;
  prompt: string;
}

/**
 * The chat's recallable prompts, oldest first: the parent's own user messages
 * (never a subagent's), as the user typed them.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/chat/composerPromptHistory.ts
export function buildPromptRecallEntries(items: readonly ThreadItem[]): PromptRecallEntry[] {
  const entries: PromptRecallEntry[] = [];
  for (const item of items) {
    if (item.kind !== "message" || item.role !== "user") continue;
    if (item.agentId !== undefined && item.agentId.length > 0) continue;
    // Another chat's message or reply, a merge back, Orquester's own continue: not typed here.
    if (isThreadAuthoredMessage(item) || isMergeBackMessage(item) || isToolsetContinueMessage(item)) continue;
    const prompt = recallablePromptText(item.text);
    if (prompt === null) continue;
    const previous = entries[entries.length - 1];
    if (previous && previous.prompt === prompt) {
      entries[entries.length - 1] = { id: item.id, prompt };
      continue;
    }
    entries.push({ id: item.id, prompt });
  }
  return entries;
}

function findActive(entries: readonly PromptRecallEntry[], position: PromptRecallPosition): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.prompt === position.recalled) return index;
  }
  return -1;
}

/** One step through the history, or `null` when the arrow is the caret's. */
// Adapted from T3 Code (MIT): apps/web/src/components/chat/composerPromptHistory.ts
export function stepPromptRecall(input: {
  direction: "backward" | "forward";
  entries: readonly PromptRecallEntry[];
  position: PromptRecallPosition | null;
  currentPrompt: string;
}): PromptRecallStep | null {
  const { entries, position, currentPrompt } = input;
  const activeIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "" };
  return { position: { entryId: entry.id, recalled: entry.prompt }, prompt: entry.prompt };
}

/** The keydown facts the gate needs, read off the event and the composer. */
export interface PromptRecallKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  /** A slash or mention menu is open: its highlight owns the arrows. */
  menuOpen: boolean;
  /** A provider question is pending: the composer is its answer. */
  questionPending: boolean;
  /** The draft holds attachments or quotes. */
  draftHasExtras: boolean;
  /** The caret is on the first visual line (ArrowUp) or the last (ArrowDown). */
  caretOnEdge: (edge: "start" | "end") => boolean;
}

/** Which way an arrow walks the history, or `null` when it is the caret's (or the menu's). */
export function promptRecallDirection(input: PromptRecallKey): "backward" | "forward" | null {
  if (input.key !== "ArrowUp" && input.key !== "ArrowDown") return null;
  if (input.shiftKey || input.altKey || input.metaKey || input.ctrlKey || input.isComposing) return null;
  if (input.menuOpen || input.questionPending || input.draftHasExtras) return null;
  const direction = input.key === "ArrowUp" ? "backward" : "forward";
  return input.caretOnEdge(direction === "backward" ? "start" : "end") ? direction : null;
}

/**
 * Whether the textarea's collapsed caret sits on its first (`start`) or last
 * (`end`) visual line. A newline on the way out answers at once; soft-wrapped
 * lines are measured on a hidden mirror of the field. Where nothing can be
 * measured (no layout) the logical line decides.
 */
export function textareaCaretOnEdge(element: HTMLTextAreaElement, edge: "start" | "end"): boolean {
  const { value, selectionStart, selectionEnd } = element;
  if (value.length === 0) return true;
  if (selectionStart !== selectionEnd) return false;
  const passed = edge === "start" ? value.slice(0, selectionStart) : value.slice(selectionStart);
  if (passed.includes("\n")) return false;
  const caretTop = mirrorCaretTop(element, selectionStart);
  const edgeTop = mirrorCaretTop(element, edge === "start" ? 0 : value.length);
  if (caretTop === null || edgeTop === null) return true;
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const threshold = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight / 2 : 1;
  return Math.abs(caretTop - edgeTop) < threshold;
}

const MIRRORED_STYLES = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "tabSize",
  "textIndent"
] as const;

/** The top of the caret at `index` in a hidden copy of the field's text and box, or `null` unmeasurable. */
function mirrorCaretTop(element: HTMLTextAreaElement, index: number): number | null {
  const document = element.ownerDocument;
  const style = getComputedStyle(element);
  const mirror = document.createElement("div");
  for (const property of MIRRORED_STYLES) mirror.style[property] = style[property];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = element.value.slice(0, index);
  const marker = document.createElement("span");
  // A zero-width marker would sit on the previous line at a wrap point.
  marker.textContent = element.value.slice(index, index + 1) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  try {
    // No layout at all (a test DOM, a hidden tab): nothing to measure.
    if (mirror.offsetHeight === 0) return null;
    return marker.offsetTop;
  } finally {
    mirror.remove();
  }
}
