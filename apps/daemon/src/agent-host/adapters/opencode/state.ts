/**
 * Agent host — the per-thread OpenCode session state and its pure helpers
 * (spec §4.5 OpenCode).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
 * (`OpenCodeSessionContext`, `mergeOpenCodeAssistantText`,
 * `accumulateOpenCodeStepUsage`, `takeOpenCodeTurnTokenUsage`), translated
 * from Effect into plain mutable state.
 *
 * Everything here is deliberately synchronous and side-effect free so the
 * normaliser (`normalize.ts`) can be replayed against a captured fixture
 * without a server.
 */

import type { RuntimeMode, RuntimeTaskStatus, TurnTokenUsage } from "@orquester/api/agent-chat";

import type {
  OpenCodeMessageRole,
  OpenCodePermissionRequest,
  OpenCodeQuestionRequest,
  OpenCodeTokens
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Text parts
// ---------------------------------------------------------------------------

export interface OpenCodeTextPartState {
  id: string;
  messageID: string;
  type: "text" | "reasoning";
  time?: { start?: number; end?: number };
  /** The latest snapshot. `undefined` once a non-text PATCH cleared it. */
  text: string | undefined;
  /** Everything already emitted as `content.delta`. Never cleared. */
  emittedText: string | undefined;
  completed: boolean;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/** A truncated snapshot must never rewind output that already went out. */
function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (
    previousText !== undefined &&
    previousText.length > nextText.length &&
    previousText.startsWith(nextText)
  ) {
    return previousText;
  }
  return nextText;
}

/**
 * Snapshot → delta. Keeps the **previous** text when it is longer *and* a
 * prefix of the incoming one; the prefix length is `previous.length` when the
 * latest starts with it, otherwise a real common-prefix length.
 *
 * In 1.18.5 this is the *defensive* path, not the primary one: text arrives as
 * an empty opening snapshot, then genuinely incremental
 * `message.part.delta {field:"text"}`, then a terminal full snapshot with
 * `time.end` (fixtures README observation 4). Because the delta branch writes
 * **both** `emittedText` and `text` before emitting, that closing snapshot
 * yields `deltaToEmit === ""` here and emits nothing. Keep it anyway — it is
 * what makes a future partial snapshot safe.
 */
export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string
): { latestText: string; deltaToEmit: string } {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  const previous = previousText ?? "";
  const prefixLength = latestText.startsWith(previous)
    ? previous.length
    : commonPrefixLength(previous, latestText);
  return { latestText, deltaToEmit: latestText.slice(prefixLength) };
}

// ---------------------------------------------------------------------------
// Running command output
// ---------------------------------------------------------------------------

/**
 * The head the `bash` tool puts on a command's running output once it passes
 * the 30 000 characters it keeps: `"...\n\n"`, then the last 30 000 (`Ze` in
 * 1.18.32's `ShellTool.run`, read from the source — not captured).
 */
export const OUTPUT_WINDOW_HEAD = "...\n\n";

/**
 * Value → chunk, for a running command part's `state.metadata.output`, which
 * restates ALL the output so far on every frame: what `value` adds to what
 * `mark` — the value last seen — already showed, and the mark to keep. Never
 * text that was already shown; where a value cannot prove what it adds, it
 * adds nothing (fixtures README observation 28):
 *
 * - `value` extends the mark — every running frame 1.18.5 was captured
 *   sending (fixtures 03, 04, 12): the appended text;
 * - `value` is a prefix of the mark, `""` included: nothing, and the mark
 *   stays — a snapshot never rewinds what went out, as with text parts;
 * - `value` carries {@link OUTPUT_WINDOW_HEAD}: past 30 000 characters the
 *   tool keeps that head and the last 30 000, a window that slides instead of
 *   growing. The mark re-bases on it, and what follows the window's longest
 *   overlap with the end of the mark is new; a window keeping nothing of the
 *   mark — a burst longer than itself between two frames — is new whole, its
 *   head marking the gap;
 * - anything else re-bases the mark and adds nothing: without the head, an
 *   overlap proves nothing (a value opening with the mark's last line break
 *   would read as a window that repeats the whole mark).
 *
 * Repetitive output can overlap further than it really did, and then a
 * repeat is lost, never shown twice.
 */
export function advanceOutputMark(
  mark: string,
  value: string
): { mark: string; chunk: string } {
  if (value.startsWith(mark)) {
    return { mark: value, chunk: value.slice(mark.length) };
  }
  if (mark.startsWith(value)) {
    return { mark, chunk: "" };
  }
  if (!value.startsWith(OUTPUT_WINDOW_HEAD)) {
    return { mark: value, chunk: "" };
  }
  const body = value.slice(OUTPUT_WINDOW_HEAD.length);
  const overlap = suffixPrefixOverlap(mark, body);
  return { mark: value, chunk: overlap > 0 ? body.slice(overlap) : value };
}

/** How much of the stream's end {@link finalOutputRemainder} looks for. */
const FINAL_ANCHOR_CHARS = 512;
/**
 * The shortest end it anchors on. Below it — a line or two — the same text
 * recurs in ordinary output by chance (`ok`, a prompt, a blank line), so
 * finding it proves nothing about where the stream ended.
 */
const FINAL_ANCHOR_FLOOR = 64;

/**
 * The note 1.18.32's `ShellTool.run` opens a final output it cut with, by
 * lines or bytes (read from the source, not captured):
 * `...output truncated...\n\nFull output saved to: <file>\n\n`.
 */
const FINAL_OUTPUT_CUT_NOTE = /^\.\.\.output truncated\.\.\.\n\nFull output saved to: ([^\n]+)\n\n/;

/**
 * The note 1.18.32's generic `Truncate.output` closes an output it cut with
 * (read from the source, not captured): every tool but the shell goes through
 * it — `Tool.define` wraps each built-in one whose result does not say
 * `metadata.truncated` itself, and every MCP tool's result is cut by it — and
 * it keeps the HEAD, its default direction and the only one any tool asks
 * for. `\n\n...<n> lines|bytes truncated...\n\nThe tool call succeeded but the
 * output was truncated. Full output saved to: <file>\n<hint>`, the hint one of
 * two lines, by whether the agent may hand the file to the Task tool; an
 * output whose first line alone passes the byte limit keeps nothing before it.
 */
const GENERIC_OUTPUT_CUT_NOTE = new RegExp(
  String.raw`\n\n\.\.\.\d+ (?:lines|bytes) truncated\.\.\.\n\n` +
    String.raw`The tool call succeeded but the output was truncated\. Full output saved to: [^\n]+\n` +
    String.raw`(?:Use Grep to search the full content or Read with offset/limit to view specific sections\.` +
    String.raw`|Use the Task tool to have explore agent process this file with Grep and Read \(with offset/limit\)\. ` +
    String.raw`Do NOT read the full file yourself - delegate to save context\.)$`
);

/**
 * Whether a command's final `output` is one OpenCode cut, and so holds only
 * part of it: the shell's own cut opens with {@link FINAL_OUTPUT_CUT_NOTE} and
 * keeps the END of the output (`es` in 1.18.32's `ShellTool.run` walks the
 * lines from the last one); the generic cut every other tool goes through
 * keeps the HEAD and closes with {@link GENERIC_OUTPUT_CUT_NOTE} — a
 * command-named MCP tool's, say. Either way a completion carrying it holds no
 * whole output, and says so (`emitToolItem`).
 */
export function isCutFinalOutput(final: string): boolean {
  return FINAL_OUTPUT_CUT_NOTE.test(final) || GENERIC_OUTPUT_CUT_NOTE.test(final);
}

/**
 * What a command's final `output` holds past the stream a client was shown —
 * `mark`, its last running value — for its completion to append before it
 * closes the call. 1.18.32's final output is not always that value
 * (`ShellTool.run`, read from the source): a command it stopped gains a
 * `<shell_metadata>` note (the timeout, "User aborted the command"), an output
 * past its limits is cut again behind a note naming the file that holds all
 * of it, and what a running frame the client never got carried shows only
 * there.
 *
 * - The final output extends the mark: the rest of it.
 * - Otherwise it was cut: what follows the LAST place it holds the mark's
 *   end — its last {@link FINAL_ANCHOR_CHARS} characters, or all of a
 *   shorter mark — is new. A mark shorter than {@link FINAL_ANCHOR_FLOOR}
 *   anchors nothing.
 * - Not found: nothing. The stream then stays as it was shown, and the
 *   completion's own output is what the row's data keeps.
 *
 * A final output the tool cut opens with {@link FINAL_OUTPUT_CUT_NOTE}, which
 * sits before the stream's end and so is never in what follows it: its
 * pointer — where the whole output was saved — closes the remainder whichever
 * way the rest went, so the stream says it too. It repeats nothing.
 */
export function finalOutputRemainder(mark: string, final: string): string {
  if (final.startsWith(mark)) {
    return final.slice(mark.length);
  }
  const saved = FINAL_OUTPUT_CUT_NOTE.exec(final)?.[1];
  const pointer = saved === undefined ? "" : `\n\nFull output saved to: ${saved}`;
  if (mark.length < FINAL_ANCHOR_FLOOR) {
    return pointer;
  }
  const anchor = mark.slice(-FINAL_ANCHOR_CHARS);
  const at = final.lastIndexOf(anchor);
  return `${at === -1 ? "" : final.slice(at + anchor.length)}${pointer}`;
}

/** How much of the mark's end the overlap search looks for first. */
const OVERLAP_ANCHOR_CHARS = 256;
/** How many places it tries before the linear pass answers instead. */
const OVERLAP_ANCHOR_TRIES = 16;

/**
 * The length of the longest suffix of `left` that is a prefix of `right`.
 *
 * Every such suffix at least {@link OVERLAP_ANCHOR_CHARS} long ends with
 * `left`'s last that-many characters, so a native `lastIndexOf` finds where it
 * can end — the rightmost place first, the longest — and one native comparison
 * confirms it: tens of microseconds on a 30 000-character window, where a
 * loop over its characters costs a millisecond. A shorter one is looked for
 * directly. An output that repeats itself can offer many places to try; past
 * {@link OVERLAP_ANCHOR_TRIES} the linear pass ({@link borderOverlap}) answers,
 * so no window costs more than that.
 */
export function suffixPrefixOverlap(left: string, right: string): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }
  const anchorLength = Math.min(OVERLAP_ANCHOR_CHARS, size);
  const anchor = left.slice(left.length - anchorLength);
  let at = right.lastIndexOf(anchor, size - anchorLength);
  for (let tries = 0; at !== -1; tries += 1) {
    if (tries === OVERLAP_ANCHOR_TRIES) {
      return borderOverlap(left, right);
    }
    if (left.endsWith(right.slice(0, at + anchorLength))) {
      return at + anchorLength;
    }
    at = at === 0 ? -1 : right.lastIndexOf(anchor, at - 1);
  }
  for (let length = anchorLength - 1; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * {@link suffixPrefixOverlap} by Knuth-Morris-Pratt: linear in the window
 * whatever the output, where trying each overlap in turn is quadratic on one
 * that repeats itself.
 */
export function borderOverlap(left: string, right: string): number {
  const size = Math.min(left.length, right.length);
  if (size === 0) {
    return 0;
  }
  // `border[i]`: the longest proper prefix of `right.slice(0, i + 1)` that is
  // also its suffix.
  const border = new Int32Array(size);
  for (let index = 1, length = 0; index < size; index += 1) {
    while (length > 0 && right.charCodeAt(index) !== right.charCodeAt(length)) {
      length = border[length - 1];
    }
    if (right.charCodeAt(index) === right.charCodeAt(length)) {
      length += 1;
    }
    border[index] = length;
  }
  let matched = 0;
  for (let index = left.length - size; index < left.length; index += 1) {
    while (
      matched > 0 &&
      (matched === size || left.charCodeAt(index) !== right.charCodeAt(matched))
    ) {
      matched = border[matched - 1];
    }
    if (left.charCodeAt(index) === right.charCodeAt(matched)) {
      matched += 1;
    }
  }
  return matched;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

export interface OpenCodeStepUsage {
  id: string;
  tokens: OpenCodeTokens;
}

export interface OpenCodeTurnTokenUsageAccumulator {
  partIds: Set<string>;
  /**
   * The prompts whose replies' steps count as this turn's own: the ids the
   * host minted for it (its prompt, each steer's) and every prompt the server
   * wrote itself that the turn claimed (`claimReply` in `normalize.ts` — a
   * background answer that woke the parent, the `continue` prompt an automatic
   * compaction writes). Never a compaction's own prompt: its summary is no
   * reply of the conversation, and stays off the meter.
   */
  promptMessageIds: Set<string>;
  assistantOwnershipByMessageId: Map<string, "owned" | "other" | "unknown">;
  unresolvedStepsByMessageId: Map<string, Map<string, OpenCodeStepUsage>>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
  complete: boolean;
  hasSubagents: boolean;
}

export function makeTurnTokenUsageAccumulator(): OpenCodeTurnTokenUsageAccumulator {
  return {
    partIds: new Set(),
    promptMessageIds: new Set(),
    assistantOwnershipByMessageId: new Map(),
    unresolvedStepsByMessageId: new Map(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    complete: true,
    hasSubagents: false
  };
}

/**
 * `input + cache.read + cache.write` into input, `output + reasoning` into
 * output (§4.5). Every field is present on every `step-finish` in 1.18.5
 * (fixtures README observation 23), so the arithmetic needs no guards — but
 * the defaults keep a future sparse step from producing `NaN`.
 */
export function accumulateStepUsage(
  accumulator: OpenCodeTurnTokenUsageAccumulator,
  part: OpenCodeStepUsage,
  costUsd?: number
): boolean {
  if (accumulator.partIds.has(part.id)) {
    return false;
  }
  accumulator.partIds.add(part.id);
  const tokens = part.tokens;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  accumulator.inputTokens += (tokens.input ?? 0) + cacheRead + cacheWrite;
  accumulator.cachedInputTokens += cacheRead;
  accumulator.cacheCreationTokens += cacheWrite;
  accumulator.outputTokens += (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  accumulator.reasoningTokens += tokens.reasoning ?? 0;
  if (typeof costUsd === "number" && Number.isFinite(costUsd)) {
    accumulator.costUsd += costUsd;
  }
  return true;
}

/**
 * One step's own total — the size of the context that model call carried, and
 * therefore the context meter's numerator (§7.6).
 *
 * `tokens.total` is present on every step in 1.18.5 (fixtures README
 * observation 23) and equals the parts summed; the sum is the guard for a
 * future step that omits it.
 */
export function stepTotalTokens(tokens: OpenCodeTokens): number {
  if (typeof tokens.total === "number" && Number.isFinite(tokens.total) && tokens.total > 0) {
    return Math.round(tokens.total);
  }
  const total =
    (tokens.input ?? 0) +
    (tokens.output ?? 0) +
    (tokens.reasoning ?? 0) +
    (tokens.cache?.read ?? 0) +
    (tokens.cache?.write ?? 0);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : 0;
}

/**
 * Settles `complete` only when the turn completed *and* every step resolved;
 * otherwise `partial`, or `unavailable` when no part carried tokens (§4.5).
 */
export function takeTurnTokenUsage(
  state: OpenCodeSessionState,
  complete: boolean
): TurnTokenUsage {
  const usage = state.turnTokenUsage;
  state.turnTokenUsage = undefined;
  if (usage === undefined || usage.partIds.size === 0) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage?.hasSubagents ?? false
    };
  }
  const settled = complete && usage.complete && usage.unresolvedStepsByMessageId.size === 0;
  return {
    usageStatus: settled ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents
  };
}

// ---------------------------------------------------------------------------
// Completion machines (§4.5 "Turn completion is three machines, not a flag")
// ---------------------------------------------------------------------------

/**
 * Machine (3): `promptAsync` returned, but idle may arrive **before** it did.
 * Fixtures README observation 5 catches this 30 ms after submit in an ordinary
 * two-turn capture — it is the common case, not an edge.
 */
export interface OpenCodePromptAdmission {
  generation: number;
  turnId: string;
  /** The client-minted user message id; `prompt_async` answers 204 with no id. */
  messageId: string;
  /** A `session.command` turn is bounded by the user-message receipt, not a submit cap. */
  requiresMessageReceipt: boolean;
  messageObserved: boolean;
  busyObserved: boolean;
  accepted: boolean;
  cancelled: boolean;
  idleStatusConfirmations: number;
  idleDuringAdmission?: { turnId: string; raw: unknown };
  priorIdle?: { turnId: string; raw: unknown };
  priorAwaitingBusy: boolean;
  recoveryRaw?: unknown;
  recovering: boolean;
}

/** Machine (2): reconcile a bare `idle` against `GET /session/status`. */
export interface OpenCodeIdleReconciliation {
  turnId: string;
  promptGeneration: number;
  raw: unknown;
  warned: boolean;
  dirty: boolean;
  running: boolean;
  cancelled: boolean;
}

// ---------------------------------------------------------------------------
// Subagents (§7.6 roster)
// ---------------------------------------------------------------------------

/**
 * One OpenCode child session, folded into the roster as a task.
 *
 * T3 drops every child frame that is not a permission or a question, which is
 * why its OpenCode roster is thin. The captures show the child is fully
 * observable — 38 frames across eight types in fixture 12 — so the adapter
 * routes them instead (see `normalize.ts`, `demuxChild`). The task id and the
 * agent id are both the **child session id**: it is the only identifier every
 * one of those frames carries.
 */
export interface OpenCodeChildAgent {
  sessionId: string;
  parentSessionId: string;
  /** `"list files (@explore subagent)"` — the child's own session title. */
  title?: string;
  /** The `task` tool's `description`, falling back to the title. */
  description: string;
  /** The `subagent_type` the parent asked for (`explore`, `general`, …). */
  role?: string;
  /** `"<providerID>/<modelID>"`, from the parent tool part's metadata. */
  model?: string;
  /**
   * The parent `task` call that launched the child's CURRENT run — a `task_id`
   * resume relaunches it under a new one (`linkChildFromTaskPart`).
   */
  toolUseId?: string;
  /**
   * Every `task` call that has named this child: its launches, and calls it
   * was handed while it worked. A later frame of any of them is stale — only
   * a call never seen before can relaunch the child.
   */
  seenCallIds?: Set<string>;
  /** Set when this child was itself launched from another child. */
  parentAgentId?: string;
  lastToolName?: string;
  lastStatus?: RuntimeTaskStatus;
  started: boolean;
  completed: boolean;
  /**
   * The child's own `session.idle` ended the current run with no result: the
   * parent's `task` part that settles right after it carries the answer
   * (fixture 12, lines 179-180), and gives it to this run's end once
   * (`linkChildFromTaskPart`) — or, for a run in the background, the answer
   * the tool injects into the parent (`takeBackgroundResult`). Cleared by
   * that, and by a relaunch.
   */
  resultPending?: boolean;
  /**
   * A background run's answer that reached the parent before the child's own
   * `session.idle` ended the run: that end carries it. Cleared by a relaunch.
   */
  pendingResult?: string;
  /**
   * The current run's launching part answered in the BACKGROUND
   * (`metadata.background`): only such a run takes an answer the tool injects
   * into its parent (`takeBackgroundResult`) — a foreground run's answer is its
   * part's, and an injected one is an earlier run's, late — and only such a
   * run, with every run inside it, outlives a turn that fails on its own
   * (`closeLiveChildAgents`). Cleared by a relaunch.
   */
  answersInBackground?: boolean;
  /**
   * The run's end was the adapter's judgement, not the child's own word: its
   * own close (`closeLiveChildAgents`: a Stop, a failed admission's abort, a
   * failed turn) or its launching call cut by an abort (`metadata.interrupted`
   * on the `task` part — the parent's word on its call, which a job the abort
   * did not reach outlives). A report that the run goes on may relaunch it
   * (`reportChildRun`). Cleared by that relaunch and by the provider's.
   */
  endedByAdapter?: boolean;
  /**
   * The server is being asked whether a run the adapter ended still runs
   * (`pending`), or said it does not (`notRunning`: its last frames, reaching
   * the stream late, ask nothing more — only a `busy` asks again). The child's
   * own idle clears it, voiding a check still in flight; each check is
   * numbered (`survivalCheckId`), so one that answers after a newer began is
   * void too.
   */
  survivalCheck?: "pending" | "notRunning";
  survivalCheckId?: number;
  /**
   * The launch id the adapter gives the run's rows in place of the provider's
   * call: `opencode-revive:<callID>:<n>` for the `n`th relaunch (`revivals`)
   * of a run the adapter ended itself, on the server's word that it runs
   * (`settleChildSurvival`) — a changed `toolUseId` on `task.started` is what
   * reopens the roster's terminal row. `toolUseId` stays the provider's
   * launching call, which a `task` part still names. Cleared by a provider
   * relaunch, whose rows name its own new call. (A child no `task` part has
   * named yet starts under `opencode-child:<session id>` — every agent's
   * FIRST start names a launch, the relaunch contract — on that start alone:
   * a part read later names the call, and every row from then on names it.)
   */
  launchId?: string;
  revivals?: number;
  /**
   * The launch the run's start row named, as the adapter wrote it — the
   * provider's call, a relaunch's id, or `opencode-child:<session id>` for a
   * child no part had named yet. Every start this adapter writes names one; a
   * run whose start named none (a log from before) gets a seed first when it
   * is relaunched, or the roster could not reopen it (`settleChildSurvival`).
   */
  startLaunchId?: string;
}

/**
 * A running command part's `state.metadata.output` as last seen — what its
 * `command_output` chunks already showed — and the message holding the part,
 * so a removed message drops its parts' marks.
 */
export interface OpenCodeOutputMark {
  messageId: string;
  value: string;
}

export interface OpenCodeCancellation {
  /** `undefined` = a session-wide stop rather than one turn's interrupt. */
  turnId?: string;
  acknowledged: boolean;
  turnSettled: boolean;
  deferredIdle?: unknown;
  /** Resolves once the abort has been acknowledged (HTTP reply or abort error). */
  acknowledgment: Promise<void>;
  acknowledge: () => void;
  completion: Promise<void>;
  complete: (error?: unknown) => void;
}

// ---------------------------------------------------------------------------
// The session state
// ---------------------------------------------------------------------------

export interface OpenCodeSessionState {
  readonly threadId: string;
  /** The upstream `ses_…` id. Re-pointed by a cwd fork and by a rollback fork. */
  openCodeSessionId: string;
  directory: string;
  runtimeMode: RuntimeMode;

  /** The parent plus every descendant session id seen so far. */
  relatedSessionIds: Set<string>;
  /** Every child session folded into the roster, keyed by its session id. */
  childAgents: Map<string, OpenCodeChildAgent>;

  activeTurnId?: string;
  /**
   * The prompts whose replies a turn owns: every message the host sent
   * (`sendTurn` — a turn's prompt and each steer's), every prompt the server
   * wrote itself that a turn claimed when its reply began (`claimReply` in
   * `normalize.ts`: the turn running then, or the turn that reply opened), and
   * every prompt a rewind's fork copied (`rollbackThread` — the past, under
   * new ids). A reply to any other prompt, beginning while no turn runs, is
   * one the host never started — the parent woken by a background `task`
   * call's answer — and opens a turn of its own. Bounded ({@link claimPrompt}).
   */
  claimedPromptIds: Set<string>;
  /**
   * The thread's own session is running: a `busy` (or `retry`) status since
   * its last `idle` — 1.18.32's `SessionPrompt.run` sets it at the top of
   * every loop iteration, before it writes a reply. A reply the host never
   * started opens a turn only on that evidence (`claimReply`): with no run
   * behind it no `idle` would ever settle the turn, and `turn.started` alone
   * never arms the watchdog, so it would hold a deploy's drain until the user
   * acted. Cleared by `idle` and `session.idle`, and by a reconnect, after
   * which nothing seen before is evidence.
   */
  parentBusy: boolean;
  /**
   * The host's own `/compact` is running: `compact()` in `session.ts` holds it
   * up across its `summarize` request, which answers only once the
   * compaction's run has ended. Its summary is no reply, and opens no turn
   * (`claimReply`). A summary written while it is down and no turn runs is a
   * run's own compaction — one a background answer woke that found its
   * context full — and opens the woken turn.
   */
  hostCompacting: boolean;
  activeAgent?: string;
  activeVariant?: string;
  /**
   * An interrupt is under way: a Stop from its first settle to its end, a
   * failed admission's abort. What reaches the thread meanwhile may come from
   * a run the abort is about to end, so a request is held until it is over
   * (`holdsRequests` in `normalize.ts`). Set by `session.ts`'s `asInterrupt`.
   */
  interrupting: boolean;
  interruptedTurnId?: string;
  reconcileIdleStatus: boolean;
  awaitingBusyAfterInterruption: boolean;
  /**
   * The parent has said idle since the latest interrupt began: the run it
   * interrupted is over — 1.18.32 publishes a cancelled run's idle only once
   * its fiber has ended, after everything that run wrote — so a `busy` from
   * here on is a new run's, and ends the interruption
   * (`endInterruptionAtNewRun` in `normalize.ts`). Reset when an interrupt
   * begins and when one ends.
   */
  idleAfterInterrupt: boolean;
  /**
   * The interruption ended at the `busy` of a run the provider started — no
   * host turn active (`endInterruptionAtNewRun`) — and that run may yet be one
   * the abort cancels: the stream can deliver its `busy` before the abort's
   * own answer, after an idle that was not the stopped run's. Its
   * `MessageAbortedError` is then an echo of that abort, not the provider's
   * failure — dropped once, until the parent's next idle. A host turn's `busy`
   * never arms it: that run began after the abort (`sendTurn` waits for it).
   */
  abortEchoExpected: boolean;
  promptGeneration: number;
  promptAdmission?: OpenCodePromptAdmission;
  pendingIdleReconciliation?: OpenCodeIdleReconciliation;
  cancellation?: OpenCodeCancellation;

  textPartsByMessageId: Map<string, Map<string, OpenCodeTextPartState>>;
  messageRoleById: Map<string, OpenCodeMessageRole>;
  /**
   * A running command part's `state.metadata.output` as last seen, by part id
   * — the high-water mark its `command_output` chunks are cut against
   * (`emitCommandOutput`). Dropped when the part settles or is removed, or its
   * message is; bounded, least recently written first, for a part whose
   * settle never reached the demux.
   */
  outputMarks: Map<string, OpenCodeOutputMark>;
  turnTokenUsage?: OpenCodeTurnTokenUsageAccumulator;

  /**
   * The thread model's `limit.context` from the server's provider catalogue.
   * Absent for a model the catalogue does not describe, in which case the
   * meter degrades to a bare count rather than inventing a denominator (§7.6).
   */
  contextMaxTokens?: number;
  /**
   * Every owned `step-finish` total, summed across the thread — §7.6's "total
   * processed". Deliberately NOT reset with the per-turn accumulator, and
   * deliberately never fed by a child session's steps: those are a different
   * session's spend.
   */
  processedTokens: number;

  pendingPermissions: Map<string, OpenCodePermissionRequest>;
  pendingQuestions: Map<string, OpenCodeQuestionRequest>;
  resolvedRequestIds: Set<string>;
  emittedTerminalRequestIds: Set<string>;
  autoRepliedRequestIds: Set<string>;
  /**
   * Requests that reached the thread while an interrupt was ending its runs,
   * or after one before any run has said `busy`: shown — or answered — only
   * once the server has said whether their asker still waits (`holdsRequests`
   * in `normalize.ts`, `judgeHeldRequest` in `session.ts`). A request answered
   * elsewhere meanwhile leaves the set with no row: it never had a card.
   */
  heldRequestIds: Set<string>;
  /** Child-session request ids awaiting an ancestry probe. */
  requestRelationRetries: Set<string>;

  /**
   * Last `session.error` text for the active turn. A single bad model produces
   * **three** frames, two with a full bun stack trace (fixtures README
   * observation 13) — consecutive duplicates are collapsed.
   */
  lastSessionErrorMessage?: string;
  /**
   * The last title mirrored onto the thread. `session.updated` re-states it on
   * every recompute, so only a genuine change becomes
   * `thread.metadata.updated`.
   */
  lastEmittedTitle?: string;
  stopped: boolean;
}

export function createSessionState(input: {
  threadId: string;
  openCodeSessionId: string;
  directory: string;
  runtimeMode: RuntimeMode;
  contextMaxTokens?: number;
}): OpenCodeSessionState {
  return {
    threadId: input.threadId,
    openCodeSessionId: input.openCodeSessionId,
    directory: input.directory,
    runtimeMode: input.runtimeMode,
    ...(input.contextMaxTokens !== undefined ? { contextMaxTokens: input.contextMaxTokens } : {}),
    processedTokens: 0,
    relatedSessionIds: new Set([input.openCodeSessionId]),
    childAgents: new Map(),
    claimedPromptIds: new Set(),
    parentBusy: false,
    hostCompacting: false,
    interrupting: false,
    reconcileIdleStatus: false,
    awaitingBusyAfterInterruption: false,
    idleAfterInterrupt: false,
    abortEchoExpected: false,
    promptGeneration: 0,
    textPartsByMessageId: new Map(),
    messageRoleById: new Map(),
    outputMarks: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    resolvedRequestIds: new Set(),
    emittedTerminalRequestIds: new Set(),
    autoRepliedRequestIds: new Set(),
    heldRequestIds: new Set(),
    requestRelationRetries: new Set(),
    stopped: false
  };
}

/** Re-point the state at a forked upstream session (cwd change or rollback). */
export function repointSession(state: OpenCodeSessionState, sessionId: string): void {
  state.openCodeSessionId = sessionId;
  state.relatedSessionIds.clear();
  state.relatedSessionIds.add(sessionId);
  state.childAgents.clear();
  state.messageRoleById.clear();
  state.textPartsByMessageId.clear();
  state.outputMarks.clear();
  state.turnTokenUsage = undefined;
  state.activeTurnId = undefined;
  // A fork re-mints every message id (fixtures README observation 17): no
  // prompt the source session held is named in this one, and no run of the
  // source is the fork's.
  state.claimedPromptIds.clear();
  state.parentBusy = false;
  endInterruption(state);
  state.abortEchoExpected = false;
  state.pendingIdleReconciliation = undefined;
  state.lastSessionErrorMessage = undefined;
  state.lastEmittedTitle = undefined;
}

/**
 * An interrupt and its leftovers are over — a later turn settled
 * (`endInterruptionBefore` in `session.ts`), a new run said `busy` after the
 * stopped run's idle (`endInterruptionAtNewRun` in `normalize.ts`), or the
 * thread moved to a fork: nothing the stream sends is dropped or held for it
 * any more.
 */
export function endInterruption(state: OpenCodeSessionState): void {
  state.interruptedTurnId = undefined;
  state.reconcileIdleStatus = false;
  state.awaitingBusyAfterInterruption = false;
  state.idleAfterInterrupt = false;
}

/**
 * Open turn `turnId`: a new prompt generation — so no completion machine
 * armed for an earlier turn can settle this one — a fresh usage accumulator,
 * no `session.error` carried over, and, after a Stop, the wait for the new
 * run's first `busy` (`awaitingBusyAfterInterruption`). The one setup both
 * ways a turn opens share, so they cannot drift: the host's own prompt
 * (`sendTurn` in `session.ts`) and a reply the server started on its own
 * (`claimReply` in `normalize.ts`). Returns the generation.
 */
export function openTurn(state: OpenCodeSessionState, turnId: string): number {
  state.promptGeneration += 1;
  state.activeTurnId = turnId;
  state.turnTokenUsage = makeTurnTokenUsageAccumulator();
  state.lastSessionErrorMessage = undefined;
  state.awaitingBusyAfterInterruption = state.interruptedTurnId !== undefined;
  return state.promptGeneration;
}

/**
 * How many prompts {@link OpenCodeSessionState.claimedPromptIds} remembers. A
 * reply names the prompt it answers as it begins — the newest user message of
 * its run — so only recent prompts are ever named; the oldest go first.
 */
const CLAIMED_PROMPTS_CAP = 256;

/** Record that a turn owns the replies to `promptId`. */
export function claimPrompt(state: OpenCodeSessionState, promptId: string): void {
  state.claimedPromptIds.delete(promptId);
  state.claimedPromptIds.add(promptId);
  while (state.claimedPromptIds.size > CLAIMED_PROMPTS_CAP) {
    const oldest = state.claimedPromptIds.values().next();
    if (oldest.done === true) {
      break;
    }
    state.claimedPromptIds.delete(oldest.value);
  }
}

/**
 * Record a child session of this thread. A child seen during a live turn means
 * that turn used subagents, whether the relation came from `session.created`
 * or from a later ancestry lookup after a reconnect.
 */
export function addRelatedSession(state: OpenCodeSessionState, sessionId: string): void {
  if (state.relatedSessionIds.size < 512) {
    state.relatedSessionIds.add(sessionId);
  }
  if (state.activeTurnId !== undefined && state.turnTokenUsage !== undefined) {
    state.turnTokenUsage.hasSubagents = true;
  }
}

/** A message id whose role is known; `undefined` while it is still unseen. */
export function messageRoleForPart(
  state: OpenCodeSessionState,
  part: { messageID: string }
): OpenCodeMessageRole | undefined {
  return state.messageRoleById.get(part.messageID);
}
