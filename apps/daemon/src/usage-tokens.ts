import { open, readFile, readdir, stat, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { UsageTokenRow, UsageTokensResponse } from "@orquester/api";
import type { SubagentRequest } from "./subagent-cache-ttl.ts";
import { canonicalModel, estimateCostParts, priceSlice, usagePricingRevision } from "./usage-pricing.ts";
import { HOUR_MS, type UsageRecord, type UsageRecordSource, type UsageSpeed } from "./usage-records.ts";

// Prices live in `usage-pricing.ts` (built-in table plus the user's overrides and aliases);
// re-exported here for the callers that predate it.
export { estimateCostParts };

interface RawRow {
  agent: string;
  model: string;
  /** When the request ran (epoch ms): the event's timestamp, else the file's mtime. */
  ts: number;
  /** {@link ts} is the file's mtime (the line has no timestamp): it moves with every later write. */
  undated?: true;
  /** Provider session id (interned per file), or null. */
  session: string | null;
  /** The working directory the request ran in (interned per file), or null. */
  cwd: string | null;
  speed: UsageSpeed;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 1h-TTL subset of {@link cacheWrite} (bills at 2x input instead of 1.25x). */
  cacheWrite1h: number;
  /** Subset of {@link output} (Codex reports it; Anthropic folds thinking into output). */
  reasoning: number;
  /** Stable identity for cross-file de-duplication (Claude resume/branch copies
   *  prior turns, each still carrying message.usage). Undefined = always count. */
  dedupId?: string;
  /** Set on a Claude subagent's request whose timestamp parses: which subagent ({@link ts} is then the event's). */
  sub?: string;
}

/** Token sums of one agent, model, UTC day and speed tier: what the Cost tab's rows are priced from. */
interface DaySlice {
  agent: string;
  model: string;
  day: string;
  speed: UsageSpeed;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

const DAY_MS = 86_400_000;

/** The Cost tab's rows (per agent, model and UTC day) at the prices in force, each speed tier at its own rates. */
function priceSlices(slices: readonly DaySlice[]): UsageTokenRow[] {
  const byKey = new Map<string, UsageTokenRow>();
  for (const s of slices) {
    const key = `${s.agent}|${s.model}|${s.day}`;
    const priced = priceSlice(canonicalModel(s.model), s.speed, s);
    let row = byKey.get(key);
    if (!row) {
      row = { agent: s.agent, model: s.model, day: s.day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, costUsd: null, costSource: "api_equivalent" as const };
      row.costBreakdown = priced ? { input: 0, output: 0, cache: 0 } : null;
      byKey.set(key, row);
    }
    row.inputTokens += s.input;
    row.outputTokens += s.output;
    row.cacheReadTokens += s.cacheRead;
    row.cacheWriteTokens += s.cacheWrite;
    row.cacheWrite1hTokens = (row.cacheWrite1hTokens ?? 0) + s.cacheWrite1h;
    // A model has a price at every tier or at none, so a row's parts are all of its slices'.
    if (priced && row.costBreakdown) {
      row.costBreakdown.input += priced.parts.input;
      row.costBreakdown.output += priced.parts.output;
      row.costBreakdown.cache += priced.parts.cacheRead + priced.parts.cacheWrite;
    }
  }
  for (const row of byKey.values()) {
    const parts = row.costBreakdown;
    row.costUsd = parts ? parts.input + parts.output + parts.cache : null;
  }
  return [...byKey.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.model.localeCompare(b.model)));
}

/** What one walk over the de-duplicated rows yields (see {@link aggregate}). */
interface Aggregates {
  /** Token sums per agent, model, UTC day and speed: the Cost tab's rows are priced from these. */
  slices: DaySlice[];
  /** Rows summed per agent, model, UTC hour, cwd, session and speed: the usage ledger's input. */
  history: UsageRecord[];
  /** Claude subagent requests (rows with {@link RawRow.sub}), in row order. */
  subagentRows: RawRow[];
}

/**
 * Every parsed row, de-duplicated across files (first file by sorted path wins, so a partial rescan
 * can't double-count a shared usage identity), summed once for all three consumers.
 *
 * A row without its own timestamp stays out of the history: its hour (the file's mtime) moves on
 * every later write, and the ledger would keep each hour it was once seen in.
 */
function aggregate(files: ReadonlyMap<string, FileEntry>): Aggregates {
  const seen = new Set<string>();
  const dayNames = new Map<number, string>();
  const slices: DaySlice[] = [];
  const history: UsageRecord[] = [];
  const subagentRows: RawRow[] = [];
  // Rows come in runs of one agent, model, speed, cwd and session: the string-keyed lookups run once
  // per run, and each row only looks up its day and hour (numbers) in the run's series.
  const daySeries = new Map<string, Map<number, DaySlice>>();
  const hourSeries = new Map<string, Map<number, UsageRecord>>();
  let last: RawRow | undefined;
  let days = new Map<number, DaySlice>();
  let hours = new Map<number, UsageRecord>();
  const add = (r: RawRow) => {
    if (r.dedupId !== undefined) {
      if (seen.has(r.dedupId)) return;
      seen.add(r.dedupId);
    }
    if (r.sub !== undefined) subagentRows.push(r);

    if (!last || r.agent !== last.agent || r.model !== last.model || r.speed !== last.speed || r.cwd !== last.cwd || r.session !== last.session) {
      const dayKey = `${r.agent}|${r.model}|${r.speed}`;
      let byDay = daySeries.get(dayKey);
      if (!byDay) daySeries.set(dayKey, (byDay = new Map()));
      // null and "" never meet (interned strings are never empty); NUL never occurs in a path or an id.
      const hourKey = `${dayKey}\0${r.cwd ?? ""}\0${r.session ?? ""}`;
      let byHour = hourSeries.get(hourKey);
      if (!byHour) hourSeries.set(hourKey, (byHour = new Map()));
      days = byDay;
      hours = byHour;
      last = r;
    }

    const dayIndex = Math.floor(r.ts / DAY_MS);
    let slice = days.get(dayIndex);
    if (!slice) {
      let day = dayNames.get(dayIndex);
      if (day === undefined) dayNames.set(dayIndex, (day = new Date(dayIndex * DAY_MS).toISOString().slice(0, 10)));
      slice = { agent: r.agent, model: r.model, day, speed: r.speed, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
      days.set(dayIndex, slice);
      slices.push(slice);
    }
    slice.input += r.input;
    slice.output += r.output;
    slice.cacheRead += r.cacheRead;
    slice.cacheWrite += r.cacheWrite;
    slice.cacheWrite1h += r.cacheWrite1h;

    if (r.undated) return;
    const hour = Math.floor(r.ts / HOUR_MS);
    let rec = hours.get(hour);
    if (!rec) {
      rec = {
        source: "transcripts", agent: r.agent, model: r.model, hour, cwd: r.cwd, session: r.session, speed: r.speed,
        input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0, reportedCostUsd: 0, reportedRequests: 0
      };
      hours.set(hour, rec);
      history.push(rec);
    }
    rec.input += r.input;
    rec.cacheRead += r.cacheRead;
    rec.cacheWrite += r.cacheWrite;
    rec.cacheWrite1h += r.cacheWrite1h;
    rec.output += r.output;
    rec.reasoning += r.reasoning;
    rec.requests += 1;
  };
  for (const path of [...files.keys()].sort()) {
    const entry = files.get(path)!;
    for (const r of entry.rows) add(r);
    for (const r of entry.tailRows) add(r);
  }
  return { slices, history, subagentRows };
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

/** An event's time (epoch ms), else `fallbackMs` (the file's mtime) and `undated`. */
function tsOf(timestamp: unknown, fallbackMs: number): Pick<RawRow, "ts" | "undated"> {
  const t = timestamp ? new Date(timestamp as string).getTime() : Number.NaN;
  return Number.isNaN(t) ? { ts: fallbackMs, undated: true } : { ts: t };
}

/** A file's string pool: one instance per distinct session or cwd, however many rows carry it. */
type Strings = Map<string, string>;

function intern(strings: Strings, value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const known = strings.get(value);
  if (known !== undefined) return known;
  strings.set(value, value);
  return value;
}

const tokens = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Claude Code's local placeholder model: it never reached the API. */
const SYNTHETIC_MODEL = "<synthetic>";

/** Parse a Claude `projects/**.jsonl` transcript into per-turn rows. Each row
 *  carries a dedupId (message.id + requestId, the fields ccusage hashes) so
 *  turns copied into resumed/branched transcripts are counted only once. An
 *  advisor call (`usage.iterations[i]` of type `advisor_message`) runs on its
 *  own model and is its own row; the top-level usage is the executor's only. */
function parseClaudeFile(text: string, mtimeMs: number, path: string, strings: Strings): RawRow[] {
  const rows: RawRow[] = [];
  const inSubagentsDir = path.split(/[\\/]/).includes("subagents");
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
    const model: string = obj?.message?.model ?? "unknown";
    if (model === SYNTHETIC_MODEL) continue;
    const messageId = obj?.message?.id;
    const requestId = obj?.requestId;
    const dedupId =
      typeof messageId === "string" && typeof requestId === "string" ? `${messageId}:${requestId}` : undefined;
    const when = tsOf(obj?.timestamp, mtimeMs);
    const session = intern(strings, obj?.sessionId);
    const cwd = intern(strings, obj?.cwd);
    const speed: UsageSpeed = u.speed === "fast" ? "fast" : "standard";
    const agentId = typeof obj.agentId === "string" && obj.agentId ? obj.agentId : undefined;
    const subagent = obj.isSidechain === true || agentId !== undefined || inSubagentsDir;
    const sub = subagent && Number.isFinite(Date.parse(obj.timestamp)) ? (agentId ?? path) : undefined;
    // `sub` marks the subagent's own request only: an advisor call runs on another model with its
    // own cache, so it says nothing of the subagent's cache lifetime.
    const push = (rowModel: string, usage: any, id: string | undefined, advisor: boolean) => {
      const input = usage.input_tokens ?? 0;
      const output = usage.output_tokens ?? 0;
      const cacheRead = usage.cache_read_input_tokens ?? 0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      // Zero-usage entries would only render as noise rows.
      if (input + output + cacheRead + cacheWrite === 0) return;
      const row: RawRow = {
        agent: "claude",
        model: rowModel,
        ...when,
        session,
        cwd,
        speed,
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        reasoning: 0,
        dedupId: id
      };
      if (sub !== undefined && !advisor) row.sub = sub;
      rows.push(row);
    };
    push(model, u, dedupId, false);
    if (!Array.isArray(u.iterations)) continue;
    u.iterations.forEach((it: any, i: number) => {
      if (it === null || typeof it !== "object" || it.type !== "advisor_message") return;
      if (typeof it.model !== "string" || it.model === "" || it.model === SYNTHETIC_MODEL) return;
      push(it.model, it, dedupId === undefined ? undefined : `${dedupId}:advisor:${i}`, true);
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

/** A fork's or a spawned subagent's rollout replays its parent's history right after its meta. */
function isForkMeta(payload: any): boolean {
  return typeof payload?.forked_from_id === "string" || typeof payload?.source?.subagent?.thread_spawn?.parent_thread_id === "string";
}

function codexSpeed(tier: unknown): UsageSpeed {
  if (tier === "priority" || tier === "fast") return "fast";
  if (tier === "ultrafast") return "ultrafast";
  return "standard";
}

/** A fork's copied history arrives as a burst: a token count closer than this to the previous one is a copy. */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Codex line-parser state carried across incremental chunks of one file: the
 *  last seen model (turn_context/session_meta records precede the token_count
 *  events they describe), the cumulative-total gate, the session, cwd and speed
 *  tier in force, and the fork-copy suppression. Primitives only, so a spread
 *  copies all of it (the unterminated tail is parsed with such a copy). */
interface CodexParseState {
  prevTotal: number;
  model: string;
  session: string | null;
  cwd: string | null;
  speed: UsageSpeed;
  /** The first `session_meta` was read: later ones are copied ancestors' and say nothing of this file. */
  sawMeta: boolean;
  /** Inside a fork's copy burst: token counts only set the cumulative baseline. */
  suppressing: boolean;
  /** The time of the burst's previous event (the meta's, at first). */
  anchorMs: number;
}

const initialCodexState = (): CodexParseState => ({
  prevTotal: 0, model: "unknown", session: null, cwd: null, speed: "standard", sawMeta: false, suppressing: false, anchorMs: 0
});

/** Parse a chunk of a Codex `sessions/**.jsonl` rollout into per-turn rows,
 *  advancing `state` (see {@link CodexParseState}). `last_token_usage` is the
 *  per-turn delta; gate on the cumulative total advancing so repeated events
 *  aren't double-counted. `input_tokens` already INCLUDES the cached and the
 *  cache-written tokens, so subtract them and record the remainder as `input`
 *  (cached goes to `cacheRead`, written to `cacheWrite`). */
function parseCodexFile(text: string, mtimeMs: number, state: CodexParseState, strings: Strings): RawRow[] {
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
    const p = obj?.payload;
    if (obj?.type === "session_meta") {
      if (state.sawMeta) continue;
      state.sawMeta = true;
      state.session = intern(strings, p?.id ?? p?.session_id);
      state.cwd = intern(strings, p?.cwd) ?? state.cwd;
      const at = Date.parse(obj?.timestamp);
      if (isForkMeta(p) && Number.isFinite(at)) {
        state.suppressing = true;
        state.anchorMs = at;
      }
      continue;
    }
    if (obj?.type === "turn_context") state.cwd = intern(strings, p?.cwd) ?? state.cwd;
    const settings = p?.thread_settings;
    if ((obj?.type === "turn_context" || p?.type === "thread_settings_applied") && settings && typeof settings === "object" && "service_tier" in settings) {
      state.speed = codexSpeed(settings.service_tier);
    }
    if (obj?.type !== "event_msg" || p?.type !== "token_count") continue;
    const info = p.info;
    const total = info?.total_token_usage?.total_tokens ?? 0;
    if (state.suppressing) {
      const at = Date.parse(obj?.timestamp);
      if (!Number.isFinite(at) || at - state.anchorMs < FORK_COPY_MAX_GAP_MS) {
        // The parent's history, billed in the parent's rollout: it only moves the baseline.
        if (Number.isFinite(at)) state.anchorMs = at;
        if (total > state.prevTotal) state.prevTotal = total;
        continue;
      }
      state.suppressing = false;
    }
    if (total <= state.prevTotal) continue;
    state.prevTotal = total;
    const last = info?.last_token_usage ?? {};
    const cached = tokens(last.cached_input_tokens ?? last.cache_read_input_tokens);
    const written = tokens(last.cache_write_input_tokens);
    rows.push({
      agent: "codex",
      model: state.model,
      ...tsOf(obj?.timestamp, mtimeMs),
      session: state.session,
      cwd: state.cwd,
      speed: state.speed,
      input: Math.max(0, (last.input_tokens ?? 0) - cached - written),
      output: last.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: written,
      cacheWrite1h: 0,
      reasoning: tokens(last.reasoning_output_tokens)
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
  /** The file's interned sessions and cwds. */
  strings: Strings;
}

export class UsageTokensScanner implements UsageRecordSource {
  private cache: UsageTokensResponse = { rows: [], asOf: new Date(0).toISOString() };
  /** Kept private so callers mutating a snapshot cannot change the next refresh. */
  private aggregateCache: UsageTokenRow[] = [];
  /** Token sums per agent, model, day and speed of the last rebuild: repricing starts here, not at the rows. */
  private slices: DaySlice[] = [];
  /** The `usagePricingRevision()` {@link aggregateCache} was priced at (-1: not yet). */
  private pricedRevision = -1;
  /** The ledger's records of the last rebuild. */
  private history: readonly UsageRecord[] = [];
  /** The subagent requests of the last rebuild. */
  private subagentRows: readonly RawRow[] = [];
  /** Stays dirty after a failed refresh until totals are successfully rebuilt. */
  private aggregateDirty = true;
  /** Per-file parse cache keyed by absolute path. Recompute only re-reads files
   *  whose mtime/size changed or that are new, so cost scales with new bytes,
   *  not total history. Cross-file dedup is resolved at assembly time (below),
   *  so partial rescans stay correct. */
  private fileCache = new Map<string, FileEntry>();

  /** False until one recompute has walked every transcript. */
  private scanned = false;
  private inflight: Promise<void> | null = null;
  private rerun = false;
  private lastRunMs = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly opts: {
      userhome: string;
      cacheFile: string;
      now: () => number;
      /** Extra credential homes to scan (managed accounts) beyond the host home. */
      accountHomes?: () => { agent: "claude" | "codex"; home: string }[];
      /** Called after every finished scan (the usage ledger folds the records in). */
      onScanned?: () => void;
    }
  ) {}

  async init(): Promise<void> {
    try {
      this.cache = JSON.parse(await readFile(this.opts.cacheFile, "utf8"));
    } catch {
      /* first run */
    }
  }

  /** The Cost tab's rows; repriced from the scanned sums (no transcript reread) when the prices changed since. */
  async snapshot(force = false): Promise<UsageTokensResponse> {
    if (force) await this.recompute();
    else if (this.scanned && this.pricedRevision !== usagePricingRevision()) {
      this.reprice();
      this.cache = { rows: structuredClone(this.aggregateCache), asOf: this.cache.asOf };
      await this.persist();
    }
    return this.cache;
  }

  /**
   * Claude subagent requests since `sinceMs`, each counted once; null until the
   * transcripts have been scanned (a daemon that just started knows nothing yet).
   */
  subagentRequests(sinceMs: number): SubagentRequest[] | null {
    if (!this.scanned) return null;
    const out: SubagentRequest[] = [];
    for (const r of this.subagentRows) {
      if (r.sub === undefined || r.ts < sinceMs) continue;
      out.push({ sub: r.sub, ts: r.ts, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, cacheWrite1h: r.cacheWrite1h });
    }
    return out;
  }

  /** Hour-aggregated, de-duplicated records for the usage ledger; null until the first scan. */
  historyRecords(): readonly UsageRecord[] | null {
    return this.scanned ? this.history : null;
  }

  /** File-watcher entry point: rate-limited (leading run + one coalesced
   *  trailing run per cooldown window). With dozens of live agent sessions the
   *  watcher fires continuously; unthrottled recomputes pegged a full core. */
  requestRecompute(): void {
    const interval = 30_000;
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
    const files: { path: string; agent: "claude" | "codex" }[] = [];
    for (const dir of await this.homeDirs("claude", "CLAUDE_CONFIG_DIR", "projects"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "claude" });
    for (const dir of await this.homeDirs("codex", "CODEX_HOME", "sessions"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "codex" });

    // Drop cache entries for files that no longer exist.
    const present = new Set(files.map((f) => f.path));
    for (const path of this.fileCache.keys()) {
      if (!present.has(path)) {
        this.aggregateDirty = true;
        this.fileCache.delete(path);
      }
    }

    // Re-read only new/changed files (mtime or size differs from the cache) —
    // and for append-only growth, only the appended bytes.
    const done = new Set<string>();
    for (const { path, agent } of files) {
      if (done.has(path)) continue; // a path can appear once per home dir; parse it once
      done.add(path);
      let st;
      try {
        st = await stat(path);
      } catch {
        if (this.fileCache.has(path)) {
          this.aggregateDirty = true;
          this.fileCache.delete(path);
        }
        continue;
      }
      const cached = this.fileCache.get(path);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) continue;
      this.aggregateDirty = true;
      await this.updateFile(path, agent, { mtimeMs: st.mtimeMs, size: st.size });
    }

    this.scanned = true;
    // An unchanged transcript set has the same dedup winners and totals. Keep
    // the fresh scan timestamp without revisiting every historical turn.
    if (this.aggregateDirty) {
      // One walk for the day sums, the ledger's records and the subagent requests.
      ({ slices: this.slices, history: this.history, subagentRows: this.subagentRows } = aggregate(this.fileCache));
      this.pricedRevision = -1;
      this.aggregateDirty = false;
    }
    if (this.pricedRevision !== usagePricingRevision()) this.reprice();
    this.cache = { rows: structuredClone(this.aggregateCache), asOf: new Date(this.opts.now()).toISOString() };
    await this.persist();
    this.opts.onScanned?.();
  }

  /** Price the scanned sums at the prices in force now. */
  private reprice(): void {
    this.pricedRevision = usagePricingRevision();
    this.aggregateCache = priceSlices(this.slices);
  }

  private async persist(): Promise<void> {
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
    st: { mtimeMs: number; size: number }
  ): Promise<void> {
    const cached = this.fileCache.get(path);
    const incremental = cached !== undefined && st.size > cached.size;
    const entry: FileEntry = incremental
      ? cached
      : { mtimeMs: 0, size: 0, bytesParsed: 0, rows: [], tailRows: [], codexState: initialCodexState(), strings: new Map() };
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
      entry.rows.push(...parseClaudeFile(completeBuf.toString("utf8"), st.mtimeMs, path, entry.strings));
      entry.tailRows = tailBuf.length > 0 ? parseClaudeFile(tailBuf.toString("utf8"), st.mtimeMs, path, entry.strings) : [];
    } else {
      entry.rows.push(...parseCodexFile(completeBuf.toString("utf8"), st.mtimeMs, entry.codexState, entry.strings));
      entry.tailRows =
        tailBuf.length > 0 ? parseCodexFile(tailBuf.toString("utf8"), st.mtimeMs, { ...entry.codexState }, entry.strings) : [];
    }
    entry.bytesParsed = start + completeBuf.length;
    entry.mtimeMs = st.mtimeMs;
    entry.size = st.size;
    this.fileCache.set(path, entry);
  }

  /** Host home + managed-account transcript directories, deduplicated by realpath. */
  private async homeDirs(
    agent: "claude" | "codex",
    envVar: string,
    subdir: string
  ): Promise<string[]> {
    const host = join(process.env[envVar] || join(this.opts.userhome, agent === "claude" ? ".claude" : ".codex"), subdir);
    const managed = (this.opts.accountHomes?.() ?? [])
      .filter((a) => a.agent === agent)
      .map((a) => join(a.home, subdir));
    // Managed homes now symlink their history dir to the shared store — dedupe by
    // realpath so a shared transcript isn't counted once per account.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const dir of [host, ...managed]) {
      let real = dir;
      try {
        real = await realpath(dir);
      } catch {
        /* missing dir → keep the given path (walkJsonl handles absence) */
      }
      if (seen.has(real)) continue;
      seen.add(real);
      out.push(dir);
    }
    return out;
  }
}
