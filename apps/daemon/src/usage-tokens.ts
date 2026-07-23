import { open, readFile, readdir, stat, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { UsageTokenRow, UsageTokensResponse } from "@orquester/api";

// USD per 1,000,000 tokens. Update when models ship. Subscription users don't
// pay per token — this is an "API-equivalent" estimate, labeled as such.
// cacheWrite5m/1h: prompt-cache writes bill 1.25x/2x input depending on TTL.
export const MODEL_PRICING: Record<
  string,
  { input: number; output: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number }
> = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.1-codex": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gpt-5.4-codex": { input: 1.25, output: 10, cacheRead: 0.125 }
};

// Transcripts record versioned model ids (e.g. "claude-opus-4-8-20260115") that
// never equal the bare pricing keys. Resolve a raw id to a known key by exact
// match, then by longest matching prefix (which also absorbs a trailing
// `-YYYYMMDD` release-date suffix). Genuinely unknown models resolve to null.
export function resolveModelKey(model: string): string | null {
  if (MODEL_PRICING[model]) return model;
  let best: string | null = null;
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(key + "-") && (!best || key.length > best.length)) best = key;
  }
  return best;
}

export function estimateCostParts(
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
): { input: number; output: number; cache: number } | null {
  const key = resolveModelKey(model);
  const p = key ? MODEL_PRICING[key] : undefined;
  if (!p) return null;
  const per = (n: number, price: number | undefined) => (price ? (n / 1_000_000) * price : 0);
  // cacheWrite is the total; cacheWrite1h is the (possibly zero) 1h-TTL subset.
  const write1h = Math.min(tok.cacheWrite, tok.cacheWrite1h);
  const write5m = tok.cacheWrite - write1h;
  return {
    input: per(tok.input, p.input),
    output: per(tok.output, p.output),
    cache: per(tok.cacheRead, p.cacheRead) + per(write5m, p.cacheWrite5m) + per(write1h, p.cacheWrite1h ?? p.cacheWrite5m)
  };
}

export function estimateCostUsd(
  _agent: string,
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
): number | null {
  const parts = estimateCostParts(model, tok);
  return parts ? parts.input + parts.output + parts.cache : null;
}

interface RawRow {
  agent: string;
  model: string;
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 1h-TTL subset of {@link cacheWrite} (bills at 2x input instead of 1.25x). */
  cacheWrite1h: number;
  /** Stable identity for cross-file de-duplication (Claude resume/branch copies
   *  prior turns, each still carrying message.usage). Undefined = always count. */
  dedupId?: string;
}

export function aggregateRows(raw: RawRow[]): UsageTokenRow[] {
  const byKey = new Map<string, UsageTokenRow>();
  for (const r of raw) {
    const key = `${r.agent}|${r.model}|${r.day}`;
    const cur =
      byKey.get(key) ??
      { agent: r.agent, model: r.model, day: r.day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, costUsd: null, costSource: "api_equivalent" as const };
    cur.inputTokens += r.input;
    cur.outputTokens += r.output;
    cur.cacheReadTokens += r.cacheRead;
    cur.cacheWriteTokens += r.cacheWrite;
    cur.cacheWrite1hTokens = (cur.cacheWrite1hTokens ?? 0) + r.cacheWrite1h;
    byKey.set(key, cur);
  }
  for (const row of byKey.values()) {
    const parts = estimateCostParts(row.model, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens,
      cacheWrite1h: row.cacheWrite1hTokens ?? 0
    });
    row.costBreakdown = parts;
    row.costUsd = parts ? parts.input + parts.output + parts.cache : null;
  }
  return [...byKey.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.model.localeCompare(b.model)));
}

async function walkJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  await rec(dir);
  return out;
}

function dayOf(iso: string | undefined, fallbackMs: number): string {
  const d = iso ? new Date(iso) : new Date(fallbackMs);
  return Number.isNaN(d.getTime()) ? new Date(fallbackMs).toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Parse a Claude `projects/**.jsonl` transcript into per-turn rows. Each row
 *  carries a dedupId (message.id + requestId, the fields ccusage hashes) so
 *  turns copied into resumed/branched transcripts are counted only once. */
function parseClaudeFile(text: string, mtimeMs: number, label: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const u = obj?.message?.usage;
    if (!u) continue;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    // Zero-usage entries (e.g. the "<synthetic>" model on error turns) would
    // only render as noise rows.
    if (input + output + cacheRead + cacheWrite === 0) continue;
    const messageId = obj?.message?.id;
    const requestId = obj?.requestId;
    const dedupId =
      typeof messageId === "string" && typeof requestId === "string" ? `${messageId}:${requestId}` : undefined;
    rows.push({
      agent: label,
      model: obj?.message?.model ?? "unknown",
      day: dayOf(obj?.timestamp, mtimeMs),
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      dedupId
    });
  }
  return rows;
}

/** Codex rollout files carry the model on `turn_context`/`session_meta` records,
 *  not on the `token_count` events. Read it from the real key paths, keeping the
 *  older bare keys as fallback. */
function extractCodexModel(obj: any): string | undefined {
  const p = obj?.payload;
  const candidates = [
    obj?.model,
    p?.model,
    p?.turn_context?.model,
    p?.thread_settings?.model,
    p?.info?.model,
    p?.collaboration_mode?.settings?.model
  ];
  for (const c of candidates) if (typeof c === "string") return c;
  return undefined;
}

/** Codex line-parser state carried across incremental chunks of one file: the
 *  last seen model (turn_context/session_meta records precede the token_count
 *  events they describe) and the cumulative-total gate. */
interface CodexParseState {
  prevTotal: number;
  model: string;
}

/** Parse a chunk of a Codex `sessions/**.jsonl` rollout into per-turn rows,
 *  advancing `state` (see {@link CodexParseState}). `last_token_usage` is the
 *  per-turn delta; gate on the cumulative total advancing so repeated events
 *  aren't double-counted. `input_tokens` already INCLUDES the cached tokens,
 *  so subtract them and record the non-cached remainder as `input` (cached
 *  goes to `cacheRead` and is billed at the cheaper cache-read rate). */
function parseCodexFile(text: string, mtimeMs: number, state: CodexParseState, label: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const m = extractCodexModel(obj);
    if (m) state.model = m;
    if (obj?.type !== "event_msg" || obj?.payload?.type !== "token_count") continue;
    const info = obj.payload.info;
    const total = info?.total_token_usage?.total_tokens ?? 0;
    if (total <= state.prevTotal) continue;
    state.prevTotal = total;
    const last = info?.last_token_usage ?? {};
    const cached = last.cached_input_tokens ?? last.cache_read_input_tokens ?? 0;
    rows.push({
      agent: label,
      model: state.model,
      day: dayOf(obj?.timestamp, mtimeMs),
      input: Math.max(0, (last.input_tokens ?? 0) - cached),
      output: last.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
      cacheWrite1h: 0
    });
  }
  return rows;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  /** Byte offset just past the last complete ("\n"-terminated) line parsed.
   *  An append-only growth re-reads from here, not from byte 0 — active
   *  multi-MB transcripts made full re-reads a sustained CPU hog. */
  bytesParsed: number;
  /** Rows parsed from the complete region (before {@link bytesParsed}). */
  rows: RawRow[];
  /** Rows from the unterminated tail line, REPLACED on every update so a tail
   *  that later gains its newline is never counted twice. */
  tailRows: RawRow[];
  /** Codex line-parser state at {@link bytesParsed} (claude is stateless). */
  codexState: CodexParseState;
}

export class UsageTokensScanner {
  private cache: UsageTokensResponse = { rows: [], asOf: new Date(0).toISOString() };
  /** Per-file parse cache keyed by absolute path. Recompute only re-reads files
   *  whose mtime/size changed or that are new, so cost scales with new bytes,
   *  not total history. Cross-file dedup is resolved at assembly time (below),
   *  so partial rescans stay correct. */
  private fileCache = new Map<string, FileEntry>();

  private inflight: Promise<void> | null = null;
  private rerun = false;
  private lastRunMs = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly opts: {
      userhome: string;
      cacheFile: string;
      now: () => number;
      /** Extra credential homes to scan (managed accounts) beyond the host home.
       *  A `launcherId` (e.g. the claudex/claudemix proxy homes) re-tags records
       *  found under that home with the launcher id instead of the bare agent, so
       *  GPT/Kimi transcripts routed through a Claude harness are attributed to the
       *  launcher and excluded from the Claude-account aggregate. */
      accountHomes?: () => { agent: "claude" | "codex"; home: string; launcherId?: string }[];
      /** Watcher-triggered recomputes run at most once per this window (default 30 s). */
      minRecomputeIntervalMs?: number;
    }
  ) {}

  async init(): Promise<void> {
    try {
      this.cache = JSON.parse(await readFile(this.opts.cacheFile, "utf8"));
    } catch {
      /* first run */
    }
  }

  async snapshot(force = false): Promise<UsageTokensResponse> {
    if (force) await this.recompute();
    return this.cache;
  }

  /** File-watcher entry point: rate-limited (leading run + one coalesced
   *  trailing run per cooldown window). With dozens of live agent sessions the
   *  watcher fires continuously; unthrottled recomputes pegged a full core. */
  requestRecompute(): void {
    const interval = this.opts.minRecomputeIntervalMs ?? 30_000;
    const due = this.lastRunMs + interval - this.opts.now();
    if (due <= 0) {
      this.lastRunMs = this.opts.now();
      void this.recompute();
      return;
    }
    if (this.cooldownTimer) return; // trailing run already scheduled
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      this.lastRunMs = this.opts.now();
      void this.recompute();
    }, due);
    this.cooldownTimer.unref?.();
  }

  /** Single-flight: a recompute requested while one runs coalesces into one
   *  follow-up pass instead of piling up concurrent directory walks. */
  async recompute(): Promise<void> {
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.rerun = false;
          await this.doRecompute();
        } while (this.rerun);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async doRecompute(): Promise<void> {
    const files: { path: string; agent: "claude" | "codex"; label: string }[] = [];
    for (const { dir, label } of await this.homeDirs("claude", "CLAUDE_CONFIG_DIR", "projects"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "claude", label });
    for (const { dir, label } of await this.homeDirs("codex", "CODEX_HOME", "sessions"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "codex", label });

    // Drop cache entries for files that no longer exist.
    const present = new Set(files.map((f) => f.path));
    for (const path of [...this.fileCache.keys()]) if (!present.has(path)) this.fileCache.delete(path);

    // Re-read only new/changed files (mtime or size differs from the cache) —
    // and for append-only growth, only the appended bytes.
    const done = new Set<string>();
    for (const { path, agent, label } of files) {
      if (done.has(path)) continue; // a path can appear once per home dir; parse it once
      done.add(path);
      let st;
      try {
        st = await stat(path);
      } catch {
        this.fileCache.delete(path);
        continue;
      }
      const cached = this.fileCache.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      await this.updateFile(path, agent, label, { mtimeMs: st.mtimeMs, size: st.size });
    }

    // Assemble with deterministic cross-file dedup (first file wins by sorted
    // path) so a partial rescan can't double-count a shared usage identity.
    const raw: RawRow[] = [];
    const seen = new Set<string>();
    for (const path of [...this.fileCache.keys()].sort()) {
      const entry = this.fileCache.get(path)!;
      for (const r of [...entry.rows, ...entry.tailRows]) {
        if (r.dedupId !== undefined) {
          if (seen.has(r.dedupId)) continue;
          seen.add(r.dedupId);
        }
        raw.push(r);
      }
    }

    this.cache = { rows: aggregateRows(raw), asOf: new Date(this.opts.now()).toISOString() };
    await mkdir(dirname(this.opts.cacheFile), { recursive: true });
    await writeFile(this.opts.cacheFile, JSON.stringify(this.cache), { mode: 0o600 });
  }

  /** Parse a changed file into its cache entry. Append-only growth (size grew)
   *  reads from the cached byte offset; anything else (new file, truncation,
   *  same-size mtime change) is a full re-read. Only complete lines advance
   *  `bytesParsed`; the unterminated tail is parsed into `tailRows` with a
   *  cloned codex state, and re-parsed (replaced) once more bytes arrive. */
  private async updateFile(
    path: string,
    agent: "claude" | "codex",
    label: string,
    st: { mtimeMs: number; size: number }
  ): Promise<void> {
    const cached = this.fileCache.get(path);
    const incremental = cached !== undefined && st.size > cached.size;
    const entry: FileEntry = incremental
      ? cached
      : { mtimeMs: 0, size: 0, bytesParsed: 0, rows: [], tailRows: [], codexState: { prevTotal: 0, model: "unknown" } };
    const start = incremental ? entry.bytesParsed : 0;
    let buf: Buffer;
    try {
      const fh = await open(path, "r");
      try {
        const len = Math.max(0, st.size - start);
        const b = Buffer.alloc(len);
        const { bytesRead } = await fh.read(b, 0, len, start);
        buf = b.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      this.fileCache.delete(path);
      return;
    }
    const lastNl = buf.lastIndexOf(0x0a);
    const completeBuf = lastNl >= 0 ? buf.subarray(0, lastNl + 1) : Buffer.alloc(0);
    const tailBuf = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf;
    if (agent === "claude") {
      entry.rows.push(...parseClaudeFile(completeBuf.toString("utf8"), st.mtimeMs, label));
      entry.tailRows = tailBuf.length > 0 ? parseClaudeFile(tailBuf.toString("utf8"), st.mtimeMs, label) : [];
    } else {
      entry.rows.push(...parseCodexFile(completeBuf.toString("utf8"), st.mtimeMs, entry.codexState, label));
      entry.tailRows =
        tailBuf.length > 0 ? parseCodexFile(tailBuf.toString("utf8"), st.mtimeMs, { ...entry.codexState }, label) : [];
    }
    entry.bytesParsed = start + completeBuf.length;
    entry.mtimeMs = st.mtimeMs;
    entry.size = st.size;
    this.fileCache.set(path, entry);
  }

  /** Host home + every managed-account home for an agent (M3: managed-account
   *  sessions write transcripts under their own CONFIG_DIR/CODEX_HOME). */
  private async homeDirs(
    agent: "claude" | "codex",
    envVar: string,
    subdir: string
  ): Promise<{ dir: string; label: string }[]> {
    const host = {
      dir: join(process.env[envVar] || join(this.opts.userhome, agent === "claude" ? ".claude" : ".codex"), subdir),
      label: agent
    };
    // A proxy home carries a `launcherId` (claudex/claudemix) which re-tags its
    // records; managed account homes keep the bare agent label.
    const managed = (this.opts.accountHomes?.() ?? [])
      .filter((a) => a.agent === agent)
      .map((a) => ({ dir: join(a.home, subdir), label: a.launcherId ?? agent }));
    // Managed homes now symlink their history dir to the shared store — dedupe by
    // realpath so a shared transcript isn't counted once per account.
    const seen = new Set<string>();
    const out: { dir: string; label: string }[] = [];
    for (const item of [host, ...managed]) {
      let real = item.dir;
      try {
        real = await realpath(item.dir);
      } catch {
        /* missing dir → keep the given path (walkJsonl handles absence) */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(item);
    }
    return out;
  }
}
