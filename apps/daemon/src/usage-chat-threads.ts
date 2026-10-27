// Usage from Orquester's own agent-chat threads (unified MCP final review, ruling: "Grok weekly usage").
//
// Grok has no transcript the Cost tab's scanner (`usage-tokens.ts`) can read, but every Orquester chat
// records, per settled turn, the provider's reported cost and tokens in the thread's durable log:
// `thread.session-set` with `payload.turn {tokenUsage?, totalCostUsd?}` in
// `<appdir>/daemon/agent/threads/<id>/events.ndjson`. This scanner sums those per UTC day and model
// for one agent — Orquester's chats only (closed ones included; the agent's use outside Orquester is
// not here).
//
// Read-only: the agent host owns and appends the logs; this never writes them. A thread's agent is
// read once from its first line (`thread.created`), and a log is re-read only from the byte it was
// parsed to, so a scan costs the bytes appended since. A log that shrank (rebuilt) is read again
// from the start; a thread whose directory is gone is dropped.

import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ChatThreadUsageResponse, ChatThreadUsageRow } from "@orquester/api";

const CHUNK_BYTES = 4 * 1024 * 1024;
/** A line longer than this is skipped (counted in `skippedLines`), never buffered whole. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** How much of a log's head is read to find `thread.created` (its first line). */
const HEAD_BYTES = 64 * 1024;

interface RowSums {
  turns: number;
  costedTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

interface ThreadEntry {
  /** The thread's agent adapter; null when its first line did not say (yet). */
  adapter: string | null;
  bytesParsed: number;
  /** The model selection in force at `bytesParsed` (created / meta-updated / turn-start). */
  model: string;
  /** `day|model` → sums. */
  rows: Map<string, RowSums>;
  /** Inside an over-long line at `bytesParsed` (read up to there): skip to its newline. */
  skipping: boolean;
  /** Over-long lines skipped so far. */
  skippedLines: number;
}

const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function modelOf(payload: Record<string, unknown>): string | undefined {
  const selection = payload.modelSelection;
  return isRecord(selection) && typeof selection.model === "string" && selection.model !== "" ? selection.model : undefined;
}

/** Apply one log line to `entry` (lines that cannot matter are skipped before parsing). */
function applyLine(entry: ThreadEntry, line: string): void {
  const settles = line.includes('"thread.session-set"') && line.includes('"turn"');
  const names = line.includes('"modelSelection"');
  if (!settles && !names) return;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(event) || !isRecord(event.payload)) return;
  const payload = event.payload;
  if (event.type === "thread.created" || event.type === "thread.meta-updated" || event.type === "thread.turn-start-requested") {
    const model = modelOf(payload);
    if (model !== undefined) entry.model = model;
    return;
  }
  if (event.type !== "thread.session-set" || !isRecord(payload.turn)) return;
  const at = typeof event.occurredAt === "string" ? Date.parse(event.occurredAt) : Number.NaN;
  if (Number.isNaN(at)) return;
  const day = new Date(at).toISOString().slice(0, 10);
  const usage = isRecord(payload.turn.tokenUsage) ? payload.turn.tokenUsage : {};
  const cost = finite(payload.turn.totalCostUsd);
  const key = `${day}|${entry.model}`;
  const sums = entry.rows.get(key) ?? { turns: 0, costedTurns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  sums.turns += 1;
  sums.inputTokens += finite(usage.inputTokens) ?? 0;
  sums.outputTokens += finite(usage.outputTokens) ?? 0;
  sums.cachedInputTokens += finite(usage.cachedInputTokens) ?? 0;
  if (cost !== undefined) {
    sums.costedTurns += 1;
    sums.costUsd += cost;
  }
  entry.rows.set(key, sums);
}

/** The adapter a log's first line (`thread.created`) names, or null. */
async function adapterOf(path: string): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buffer, 0, HEAD_BYTES, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = head.indexOf("\n");
    if (newline < 0) return null;
    const event = JSON.parse(head.slice(0, newline)) as unknown;
    if (isRecord(event) && event.type === "thread.created" && isRecord(event.payload) && typeof event.payload.adapter === "string") return event.payload.adapter;
    return null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export class ChatThreadUsageScanner {
  private readonly threads = new Map<string, ThreadEntry>();
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      threadsDir: string;
      /** Tests: a smaller line cap ({@link MAX_LINE_BYTES}) and read size. */
      maxLineBytes?: number;
      chunkBytes?: number;
      /** The agents whose logs are read (others: only their first line, once). */
      agents: readonly string[];
      now: () => number;
      logger?: Pick<Console, "warn">;
    }
  ) {}

  /** Every settled turn of `agent`'s Orquester chats, summed per UTC day and model (a fresh scan first). */
  async snapshot(agent: string): Promise<ChatThreadUsageResponse> {
    if (!this.opts.agents.includes(agent)) return { agent, scope: "orquester-chats", rows: [], asOf: new Date(this.opts.now()).toISOString() };
    await this.scan();
    const merged = new Map<string, ChatThreadUsageRow>();
    let skippedLines = 0;
    for (const entry of this.threads.values()) {
      if (entry.adapter !== agent) continue;
      skippedLines += entry.skippedLines;
      for (const [key, sums] of entry.rows) {
        const [day, model] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
        const row = merged.get(key) ?? { day, model, turns: 0, costedTurns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null };
        row.turns += sums.turns;
        row.costedTurns += sums.costedTurns;
        row.inputTokens += sums.inputTokens;
        row.outputTokens += sums.outputTokens;
        row.cachedInputTokens += sums.cachedInputTokens;
        if (sums.costedTurns > 0) row.costUsd = (row.costUsd ?? 0) + sums.costUsd;
        merged.set(key, row);
      }
    }
    // Float sums of many small costs: keep ten decimals (far below a cent), so equal spends read equal.
    for (const row of merged.values()) if (row.costUsd !== null) row.costUsd = Math.round(row.costUsd * 1e10) / 1e10;
    const rows = [...merged.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.model.localeCompare(b.model)));
    return { agent, scope: "orquester-chats", rows, asOf: new Date(this.opts.now()).toISOString(), ...(skippedLines > 0 ? { skippedLines } : {}) };
  }

  /** Single-flight: a scan asked for while one runs waits for that one. */
  private scan(): Promise<void> {
    this.inflight ??= this.doScan().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doScan(): Promise<void> {
    let ids: string[];
    try {
      ids = (await readdir(this.opts.threadsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      ids = [];
    }
    const present = new Set(ids);
    for (const id of [...this.threads.keys()]) if (!present.has(id)) this.threads.delete(id);
    for (const id of ids) {
      try {
        await this.updateThread(id);
      } catch (error) {
        this.opts.logger?.warn(`chat usage: thread ${id} could not be read (${(error as NodeJS.ErrnoException)?.code ?? "error"})`);
        this.threads.delete(id);
      }
    }
  }

  private async updateThread(id: string): Promise<void> {
    const path = join(this.opts.threadsDir, id, "events.ndjson");
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      this.threads.delete(id);
      return;
    }
    let entry = this.threads.get(id);
    if (entry && size < entry.bytesParsed) entry = undefined; // rebuilt: read again from the start
    if (!entry) {
      entry = { adapter: await adapterOf(path), bytesParsed: 0, model: "unknown", rows: new Map(), skipping: false, skippedLines: 0 };
      this.threads.set(id, entry);
    }
    if (entry.adapter === null) entry.adapter = await adapterOf(path);
    // Another agent's thread is never read past its first line (a thread's agent never changes).
    if (entry.adapter === null || !this.opts.agents.includes(entry.adapter)) return;
    if (size === entry.bytesParsed) return;
    const fh = await open(path, "r");
    const maxLine = this.opts.maxLineBytes ?? MAX_LINE_BYTES;
    const chunkBytes = this.opts.chunkBytes ?? CHUNK_BYTES;
    try {
      let position = entry.bytesParsed;
      // The unterminated line so far, as bytes (never more than `maxLine`).
      let carry: Buffer[] = [];
      let carryBytes = 0;
      let skipping = entry.skipping;
      while (position < size) {
        const length = Math.min(chunkBytes, size - position);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await fh.read(buffer, 0, length, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        position += bytesRead;
        let start = 0;
        for (let newline = chunk.indexOf(0x0a, start); newline >= 0; newline = chunk.indexOf(0x0a, start)) {
          const piece = chunk.subarray(start, newline);
          if (skipping) {
            skipping = false;
            entry.skippedLines += 1;
          } else if (carryBytes + piece.length > maxLine) {
            entry.skippedLines += 1;
          } else {
            const line = (carryBytes > 0 ? Buffer.concat([...carry, piece]) : piece).toString("utf8");
            if (line !== "") applyLine(entry, line);
          }
          carry = [];
          carryBytes = 0;
          start = newline + 1;
          // Only complete lines advance the cursor: an unterminated tail is read again next time.
          entry.bytesParsed = position - (chunk.length - start);
        }
        const rest = chunk.subarray(start);
        if (rest.length === 0 || skipping) continue;
        if (carryBytes + rest.length > maxLine) {
          // Over-long: dropped as it is read, never held whole; skipped up to its newline.
          skipping = true;
          carry = [];
          carryBytes = 0;
        } else {
          carry.push(rest);
          carryBytes += rest.length;
        }
      }
      // Inside an over-long line at the end of the log: what was read of it is never read again.
      if (skipping) entry.bytesParsed = position;
      entry.skipping = skipping;
    } finally {
      await fh.close();
    }
  }
}
