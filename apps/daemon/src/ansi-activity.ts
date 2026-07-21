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

export class BellScanner {
  private state: ScannerState = "ground";
  private stringBelTerminates = false;

  feed(chunk: string): number {
    let bells = 0;

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
            this.state = "string";
            this.stringBelTerminates = code === OSC;
          }
          break;

        case "esc":
          if (ch === "[") {
            this.state = "csi";
          } else if (ch === "]" || ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            this.state = "string";
            this.stringBelTerminates = ch === "]";
          } else if (ch === "\\") {
            this.state = "ground";
          } else if (code === ESC) {
            this.state = "esc";
          } else if (code === CSI) {
            this.state = "csi";
          } else if (isStringIntroducer(code)) {
            this.state = "string";
            this.stringBelTerminates = code === OSC;
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
            this.state = "string-esc";
          } else if (code === ST) {
            this.state = "ground";
          } else if (code === BEL) {
            this.state = "ground";
          }
          break;

        case "string-esc":
          if (ch === "\\") {
            this.state = "ground";
          } else if (code === ESC) {
            this.state = "string-esc";
          } else {
            this.state = "string";
          }
          break;
      }
    }

    return bells;
  }
}

import type { SessionActivity, SessionAttention } from "@orquester/api";

/** Silence (ms) after the last output before working → idle. */
export const IDLE_MS = 3000;

export type ActivityCause = "output" | "idle" | "bell" | "hook" | "input";
export type HookEventClass = "working" | "waiting" | "done";

/**
 * Per-session activity state machine — the daemon-side single source of truth
 * behind SessionSummary.activity and "session.activity" events. Structural
 * hook events (agent lifecycle) outrank byte-stream heuristics: output flow
 * never overrides "waiting", and a bell never downgrades a structural
 * attention. `onChange` fires only on real transitions (state or attention
 * changed), never on every output chunk.
 */
export class ActivityTracker {
  private readonly scanner = new BellScanner();
  private lastOutputAt: number | null = null;
  private state: SessionActivity["state"] = "idle";
  private attention: SessionAttention | null = null;
  private hookSource = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange?: (snapshot: SessionActivity, cause: ActivityCause) => void
  ) {}

  get hasHookSource(): boolean {
    return this.hookSource;
  }

  noteOutput(chunk: string, now: number = Date.now()): void {
    this.lastOutputAt = now;
    const rang = this.scanner.feed(chunk) > 0;
    let changed = false;
    if (this.state === "idle") {
      this.state = "working";
      changed = true;
    }
    // "waiting" is structural — a TUI repaint at a permission prompt must not
    // clear it, so output only rearms the idle timer for the "working" state.
    if (this.state === "working") {
      this.armIdleTimer();
    }
    if (rang && this.attention === null) {
      this.attention = "bell";
      changed = true;
    }
    if (changed) {
      this.emit(rang ? "bell" : "output");
    } else if (rang) {
      this.emit("bell");
    }
  }

  noteInput(): void {
    let changed = false;
    if (this.attention !== null) {
      this.attention = null;
      changed = true;
    }
    // Answering a prompt produces no hook event in any agent; the user's
    // keystrokes are the answer. Optimistically resume "working" — the next
    // hook event corrects if wrong.
    if (this.state === "waiting") {
      this.state = "working";
      this.armIdleTimer();
      changed = true;
    }
    if (changed) {
      this.emit("input");
    }
  }

  applyHookEvent(cls: HookEventClass): void {
    this.hookSource = true;
    const before = this.key();
    if (cls === "working") {
      this.state = "working";
      this.attention = null;
      this.armIdleTimer();
    } else if (cls === "waiting") {
      this.state = "waiting";
      this.attention = "needs-input";
      this.clearIdleTimer();
    } else {
      this.state = "idle";
      this.attention = "finished";
      this.clearIdleTimer();
    }
    if (this.key() !== before) {
      this.emit("hook");
    }
  }

  snapshot(): SessionActivity {
    return {
      state: this.state,
      attention: this.attention,
      lastOutputAt: this.lastOutputAt === null ? null : new Date(this.lastOutputAt).toISOString()
    };
  }

  dispose(): void {
    this.clearIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.state === "working") {
        this.state = "idle";
        this.emit("idle");
      }
    }, IDLE_MS);
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
