type ScannerState = "ground" | "esc" | "csi" | "string" | "string-esc";

const BEL = 0x07;
const ESC = 0x1b;
const CSI = 0x9b;
const DCS = 0x90;
const SOS = 0x98;
const OSC = 0x9d;
const ST = 0x9c;
const PM = 0x9e;
const APC = 0x9f;

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isStringIntroducer(code: number): boolean {
  return code === DCS || code === SOS || code === OSC || code === PM || code === APC;
}

/** Cap on a buffered OSC payload; anything longer is not a window title. */
const MAX_OSC_PAYLOAD = 1024;

export class BellScanner {
  private state: ScannerState = "ground";
  /** Payload accumulated for the OSC string being scanned; null = not buffering. */
  private oscPayload: string | null = null;
  private chunkTitleValue: string | null = null;

  /**
   * Last OSC 0 (icon+title) / OSC 2 (title) payload completed during the most
   * recent {@link feed}, or null if that chunk finished no title. Reported by
   * the feed the terminator lands in, so a title split across chunks still
   * counts exactly once.
   */
  get chunkTitle(): string | null {
    return this.chunkTitleValue;
  }

  feed(chunk: string): number {
    let bells = 0;
    this.chunkTitleValue = null;

    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i);
      const ch = chunk[i];

      switch (this.state) {
        case "ground":
          if (code === BEL) {
            bells++;
          } else if (code === ESC) {
            this.state = "esc";
          } else if (code === CSI) {
            this.state = "csi";
          } else if (isStringIntroducer(code)) {
            this.beginString(code === OSC);
          }
          break;

        case "esc":
          if (ch === "[") {
            this.state = "csi";
          } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            this.beginString(ch === "]");
          } else if (ch === "\\") {
            this.state = "ground";
          } else if (code === ESC) {
            this.state = "esc";
          } else if (code === CSI) {
            this.state = "csi";
          } else if (isStringIntroducer(code)) {
            this.beginString(code === OSC);
          } else {
            this.state = "ground";
          }
          break;

        case "csi":
          if (code === ESC) {
            this.state = "esc";
          } else if (isCsiFinal(code)) {
            this.state = "ground";
          }
          break;

        case "string":
          if (code === ESC) {
            // A title payload never contains ESC, so anything but an ST
            // terminator here means this string is not one.
            this.state = "string-esc";
          } else if (code === ST || code === BEL) {
            if (this.endString()) {
              bells++;
            }
          } else if (this.oscPayload !== null) {
            this.oscPayload =
              this.oscPayload.length >= MAX_OSC_PAYLOAD ? null : this.oscPayload + ch;
          }
          break;

        case "string-esc":
          if (ch === "\\") {
            if (this.endString()) {
              bells++;
            }
          } else if (code === ESC) {
            this.oscPayload = null;
            this.state = "string-esc";
          } else {
            this.oscPayload = null;
            this.state = "string";
          }
          break;
      }
    }

    return bells;
  }

  private beginString(isOsc: boolean): void {
    this.state = "string";
    this.oscPayload = isOsc ? "" : null;
  }

  /**
   * Terminator reached. An OSC 0/2 payload is this chunk's title; an OSC 9
   * (iTerm2/ConEmu) or OSC 777 (`notify`) payload is a desktop notification —
   * the sequence IS the attention request, and returning true here is the only
   * way it can be seen, since its terminating BEL was consumed as part of the
   * string. Everything else (including an OSC 0/2 title's own BEL) is silent.
   */
  private endString(): boolean {
    const payload = this.oscPayload;
    this.oscPayload = null;
    this.state = "ground";
    if (payload === null) {
      return false;
    }
    const parts = /^([0-9]{1,4});([\s\S]*)$/.exec(payload);
    if (!parts) {
      return false;
    }
    if (parts[1] === "0" || parts[1] === "2") {
      this.chunkTitleValue = parts[2];
      return false;
    }
    return parts[1] === "9" || parts[1] === "777";
  }
}

import type { SessionActivity, SessionAttention } from "@orquester/api";

/** Silence (ms) after the last output before working → idle. */
export const IDLE_MS = 3000;

/**
 * Idle timeout once a session is title-driven. Longer than {@link IDLE_MS}
 * because only title changes count as heartbeats there, and a spinner retitles
 * at its own (slower, coarser) cadence than it paints bytes. Upstream widens
 * 2s → 3s; this keeps the fork's 3s base and the same 1.5× ratio.
 */
export const TITLE_DRIVEN_IDLE_MS = 4500;

/**
 * Output arriving within this window of local input is treated as the echo of
 * what was just typed, not as the session doing work. Only ever blocks an
 * idle → working WAKE-UP (see {@link ActivityTracker.noteOutput}).
 */
export const INPUT_ECHO_GRACE_MS = 1500;

/**
 * Bells are suppressed for a much shorter window than heartbeats: a terminal's
 * own beep (readline's tab-completion / end-of-history bell) lands essentially
 * with the keystroke's echo, while an agent ringing to ask a question does so
 * later. 1500ms swallowed real prompts — worst for the agents with no hook
 * coverage (gemini/deepseek) and for shells, where the bell is the ONLY
 * attention signal there is.
 */
export const BELL_ECHO_GRACE_MS = 250;

/** Max gap between title changes to stay on the same streak / stay title-driven. */
export const TITLE_STREAK_WINDOW_MS = 3000;

/** Title changes inside the window before titles become the sole heartbeat. */
export const TITLE_STREAK_THRESHOLD = 2;

/**
 * Is `stamp` within `window` ms before `now`? A negative age (the wall clock
 * jumped backwards) reads as "no", so a clock step can't leave a session
 * echo-suppressed or title-driven until the clock catches up.
 */
function within(stamp: number | null, now: number, window: number): boolean {
  if (stamp === null) {
    return false;
  }
  const age = now - stamp;
  return age >= 0 && age < window;
}

export type ActivityCause = "output" | "idle" | "bell" | "hook" | "input" | "exit";
export type HookEventClass = "working" | "waiting" | "done";

/**
 * Per-session activity state machine — the daemon-side single source of truth
 * behind SessionSummary.activity and "session.activity" events. Structural
 * hook events (agent lifecycle) outrank byte-stream heuristics: output flow
 * never overrides "waiting", and a bell never downgrades a structural
 * attention. `onChange` fires only on real transitions (state or attention
 * changed), never on every output chunk.
 *
 * Two heuristics keep the byte stream honest. Output within
 * {@link INPUT_ECHO_GRACE_MS} of local input is the echo of what the user just
 * typed and cannot WAKE an idle session (nor, within the tighter
 * {@link BELL_ECHO_GRACE_MS}, ring it — a readline beep on tab-completion is
 * not the session asking for attention). And once a session has retitled
 * itself {@link TITLE_STREAK_THRESHOLD} times inside
 * {@link TITLE_STREAK_WINDOW_MS} it is "title-driven": a live status spinner,
 * whose constant repaints would otherwise read as endless work. From then on
 * only a title *change* is a heartbeat — which is also what distinguishes the
 * spinner from a one-off shell-prompt retitle.
 */
export class ActivityTracker {
  private readonly scanner = new BellScanner();
  private lastOutputAt: number | null = null;
  private state: SessionActivity["state"] = "idle";
  private attention: SessionAttention | null = null;
  private attentionAt: number | null = null;
  private hookSource = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInputAt: number | null = null;
  private lastTitle: string | null = null;
  private lastTitleChangeAt: number | null = null;
  private titleStreak = 0;

  constructor(
    private readonly onChange?: (snapshot: SessionActivity, cause: ActivityCause) => void
  ) {}

  get hasHookSource(): boolean {
    return this.hookSource;
  }

  noteOutput(chunk: string, now: number = Date.now()): void {
    this.lastOutputAt = now;
    const rang = this.scanner.feed(chunk) > 0;
    const titleChanged = this.noteTitle(this.scanner.chunkTitle, now);
    // Echo grace only blocks a WAKE-UP. A session that is already working is
    // streaming real output, and typing into it must not suppress its
    // heartbeats: a keystroke every <1500ms (a user typing at a REPL/agent
    // prompt while it prints) otherwise starved the idle timer of every rearm
    // and the session went dark mid-stream.
    const echo = this.state !== "working" && within(this.lastInputAt, now, INPUT_ECHO_GRACE_MS);
    const heartbeat = !echo && (titleChanged || !this.isTitleDriven(now));
    const belled = rang && !within(this.lastInputAt, now, BELL_ECHO_GRACE_MS);

    let changed = false;
    if (heartbeat && this.state === "idle") {
      this.state = "working";
      changed = true;
    }
    // "waiting" is structural — a TUI repaint at a permission prompt must not
    // clear it, so output only rearms the idle timer for the "working" state.
    if (heartbeat && this.state === "working") {
      this.armIdleTimer(now);
    }
    if (belled && this.attention === null) {
      this.setAttention("bell", now);
      changed = true;
    }
    if (changed) {
      this.emit(belled ? "bell" : "output");
    } else if (belled) {
      this.emit("bell");
    }
  }

  /**
   * A write reached the PTY. `programmatic` marks a write the daemon itself
   * made (the MCP terminal-control tools): it is not a keystroke, so it must
   * not open an echo window — a tool that writes and then waits for the bell
   * would otherwise suppress the very answer it is waiting for.
   */
  noteInput(now: number = Date.now(), options: { programmatic?: boolean } = {}): void {
    if (!options.programmatic) {
      this.lastInputAt = now;
    }
    let changed = false;
    if (this.attention !== null) {
      this.setAttention(null, now);
      changed = true;
    }
    // Answering a prompt produces no hook event in any agent; the user's
    // keystrokes are the answer. Optimistically resume "working" — the next
    // hook event corrects if wrong.
    if (this.state === "waiting") {
      this.state = "working";
      this.armIdleTimer(now);
      changed = true;
    }
    if (changed) {
      this.emit("input");
    }
  }

  /**
   * Latch hook coverage without a transition — called for every valid managed
   * hook delivery, including events that classify to no structural state
   * (e.g. a generic Claude Notification), so bells demote to state-only as
   * soon as ANY hook event has arrived.
   */
  noteHookSource(): void {
    this.hookSource = true;
  }

  applyHookEvent(cls: HookEventClass, now: number = Date.now()): void {
    this.hookSource = true;
    const before = this.key();
    if (cls === "working") {
      this.state = "working";
      this.setAttention(null, now);
      this.armIdleTimer(now);
    } else if (cls === "waiting") {
      this.state = "waiting";
      this.setAttention("needs-input", now);
      this.clearIdleTimer();
    } else {
      this.state = "idle";
      this.setAttention("finished", now);
      this.clearIdleTimer();
    }
    if (this.key() !== before) {
      this.emit("hook");
    }
  }

  /**
   * The session's command exited (upstream sessions.rs sets needs_attention on
   * exit too): a finished process is something the user should look at, so it
   * raises "finished" attention with a timestamp for the Attention Center. No
   * push rides this — the "exit" cause is deliberately not one of the
   * push-triggering causes, since a hook-reporting agent already pushed
   * "finished" and a bell-only one already pushed its bell.
   */
  noteExit(now: number = Date.now()): void {
    this.clearIdleTimer();
    const before = this.key();
    this.state = "idle";
    this.setAttention("finished", now);
    if (this.key() !== before) {
      this.emit("exit");
    }
  }

  snapshot(): SessionActivity {
    return {
      state: this.state,
      attention: this.attention,
      lastOutputAt: this.lastOutputAt === null ? null : new Date(this.lastOutputAt).toISOString(),
      needsAttentionAt: this.attentionAt === null ? null : new Date(this.attentionAt).toISOString()
    };
  }

  dispose(): void {
    this.clearIdleTimer();
  }

  /**
   * Record the title this chunk ended on and keep the streak. Returns true only
   * when the title actually CHANGED — a repaint that re-emits the same title is
   * not a heartbeat.
   */
  private noteTitle(title: string | null, now: number): boolean {
    if (title === null || title === this.lastTitle) {
      return false;
    }
    const streaking = within(this.lastTitleChangeAt, now, TITLE_STREAK_WINDOW_MS);
    this.titleStreak = streaking ? this.titleStreak + 1 : 1;
    this.lastTitle = title;
    this.lastTitleChangeAt = now;
    return true;
  }

  private isTitleDriven(now: number): boolean {
    return (
      this.titleStreak >= TITLE_STREAK_THRESHOLD &&
      within(this.lastTitleChangeAt, now, TITLE_STREAK_WINDOW_MS)
    );
  }

  private setAttention(next: SessionAttention | null, now: number): void {
    if (this.attention === next) {
      return;
    }
    this.attention = next;
    this.attentionAt = next === null ? null : now;
  }

  private armIdleTimer(now: number = Date.now()): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state === "working") {
        this.state = "idle";
        this.emit("idle");
      }
    }, this.isTitleDriven(now) ? TITLE_DRIVEN_IDLE_MS : IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private key(): string {
    return `${this.state}|${this.attention ?? ""}`;
  }

  private emit(cause: ActivityCause): void {
    this.onChange?.(this.snapshot(), cause);
  }
}
