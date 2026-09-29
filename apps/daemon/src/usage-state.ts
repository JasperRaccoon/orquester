/**
 * The Claude usage sources' persisted state (`<appdir>/daemon/usage-state.json`, 0600): per source,
 * the last good reading and when the rate-limited usage endpoint was last asked. A daemon restart
 * then shows the last numbers at once and waits out the endpoint's window instead of asking it
 * again straight into a 429.
 *
 * A cache, never an authority: a file that cannot be read or parsed is started over (a corrupt one
 * is moved aside), an entry that does not parse is dropped, and a failed write only costs the next
 * restart its head start.
 */

import { readFile, rename } from "node:fs/promises";
import type { AgentUsage, UsageWindow } from "@orquester/api";
import { writeFileAtomic } from "./agent-hooks";
import type { ClaudeUsageRecord, ClaudeUsageStateStore } from "./usage-sources";

const VERSION = 1;
/** Coalesce a burst of readings into one write. */
const WRITE_DELAY_MS = 2_000;
/** Bounded: one entry per account home that ever had a source. */
const MAX_ENTRIES = 128;

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.percent !== "number" || !Number.isFinite(row.percent)) return null;
  return { percent: row.percent, ...(typeof row.resetsAt === "string" ? { resetsAt: row.resetsAt } : {}) };
}

function parseUsage(value: unknown): AgentUsage | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.id !== "claude" || typeof row.asOf !== "string" || !Number.isFinite(Date.parse(row.asOf))) return null;
  const scoped = Array.isArray(row.scopedWindows)
    ? row.scopedWindows.flatMap((entry) => {
        const window = parseWindow(entry);
        const label = (entry as { label?: unknown } | null)?.label;
        return window && typeof label === "string" ? [{ ...window, label }] : [];
      })
    : [];
  return {
    id: "claude",
    available: true,
    stale: false,
    ...(typeof row.plan === "string" ? { plan: row.plan } : {}),
    session: parseWindow(row.session),
    weekly: parseWindow(row.weekly),
    ...(scoped.length > 0 ? { scopedWindows: scoped } : {}),
    asOf: row.asOf
  };
}

/** One persisted entry, or undefined when it does not parse. */
function parseUsageRecord(value: unknown): ClaudeUsageRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  return {
    lastGood: parseUsage(row.lastGood),
    lastFetchAt: finiteNumber(row.lastFetchAt),
    retryAt: finiteNumber(row.retryAt),
    liveAt: finiteNumber(row.liveAt),
    failed: row.failed === true
  };
}

export class UsageStateFile implements ClaudeUsageStateStore {
  private readonly records = new Map<string, ClaudeUsageRecord>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  /** Read the file. Never throws: anything unreadable starts over. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return; // ENOENT (first run) or unreadable → start over
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => undefined);
      this.logger.warn?.(`usage: ${this.file} did not parse; moved aside`);
      return;
    }
    const sources = (parsed as { version?: unknown; sources?: unknown } | null)?.sources;
    if ((parsed as { version?: unknown } | null)?.version !== VERSION || !sources || typeof sources !== "object") return;
    for (const [key, value] of Object.entries(sources as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
      const record = parseUsageRecord(value);
      if (record) this.records.set(key, record);
    }
  }

  get(key: string): ClaudeUsageRecord | undefined {
    return this.records.get(key);
  }

  set(key: string, record: ClaudeUsageRecord): void {
    this.records.delete(key); // re-insert: newest last, so the cap drops the oldest
    this.records.set(key, record);
    while (this.records.size > MAX_ENTRIES) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.schedule();
  }

  /** Write now what is pending (the daemon's stop). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.write();
    }
    await this.writing;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  private write(): void {
    const body = JSON.stringify({ version: VERSION, sources: Object.fromEntries(this.records) });
    this.writing = this.writing
      .then(() => writeFileAtomic(this.file, body, 0o600, false))
      .catch((error: unknown) => {
        this.logger.warn?.(`usage: could not write ${this.file}: ${String(error)}`);
      });
  }
}
