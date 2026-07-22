import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { UsageTokenRow, UsageTokensResponse } from "@orquester/api";

// USD per 1,000,000 tokens. Update when models ship. Subscription users don't
// pay per token — this is an "API-equivalent" estimate, labeled as such.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number; cacheWrite?: number }> = {
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
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

export function estimateCostUsd(
  _agent: string,
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number | null {
  const key = resolveModelKey(model);
  const p = key ? MODEL_PRICING[key] : undefined;
  if (!p) return null;
  const per = (n: number, price: number | undefined) => (price ? (n / 1_000_000) * price : 0);
  return per(tok.input, p.input) + per(tok.output, p.output) + per(tok.cacheRead, p.cacheRead) + per(tok.cacheWrite, p.cacheWrite);
}

interface RawRow {
  agent: string;
  model: string;
  day: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
      { agent: r.agent, model: r.model, day: r.day, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, costSource: "api_equivalent" as const };
    cur.inputTokens += r.input;
    cur.outputTokens += r.output;
    cur.cacheReadTokens += r.cacheRead;
    cur.cacheWriteTokens += r.cacheWrite;
    byKey.set(key, cur);
  }
  for (const row of byKey.values()) {
    row.costUsd = estimateCostUsd(row.agent, row.model, {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens
    });
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
function parseClaudeFile(text: string, mtimeMs: number): RawRow[] {
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
    const messageId = obj?.message?.id;
    const requestId = obj?.requestId;
    const dedupId =
      typeof messageId === "string" && typeof requestId === "string" ? `${messageId}:${requestId}` : undefined;
    rows.push({
      agent: "claude",
      model: obj?.message?.model ?? "unknown",
      day: dayOf(obj?.timestamp, mtimeMs),
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
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

/** Parse a Codex `sessions/**.jsonl` rollout into per-turn rows. `last_token_usage`
 *  is the per-turn delta; gate on the cumulative total advancing so repeated
 *  events aren't double-counted. `input_tokens` already INCLUDES the cached
 *  tokens, so subtract them and record the non-cached remainder as `input`
 *  (cached goes to `cacheRead` and is billed at the cheaper cache-read rate). */
function parseCodexFile(text: string, mtimeMs: number): RawRow[] {
  const rows: RawRow[] = [];
  let prevTotal = 0;
  let model = "unknown";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const m = extractCodexModel(obj);
    if (m) model = m;
    if (obj?.type !== "event_msg" || obj?.payload?.type !== "token_count") continue;
    const info = obj.payload.info;
    const total = info?.total_token_usage?.total_tokens ?? 0;
    if (total <= prevTotal) continue;
    prevTotal = total;
    const last = info?.last_token_usage ?? {};
    const cached = last.cached_input_tokens ?? last.cache_read_input_tokens ?? 0;
    rows.push({
      agent: "codex",
      model,
      day: dayOf(obj?.timestamp, mtimeMs),
      input: Math.max(0, (last.input_tokens ?? 0) - cached),
      output: last.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0
    });
  }
  return rows;
}

interface FileEntry {
  mtimeMs: number;
  size: number;
  rows: RawRow[];
}

export class UsageTokensScanner {
  private cache: UsageTokensResponse = { rows: [], asOf: new Date(0).toISOString() };
  /** Per-file parse cache keyed by absolute path. Recompute only re-reads files
   *  whose mtime/size changed or that are new, so cost scales with new bytes,
   *  not total history. Cross-file dedup is resolved at assembly time (below),
   *  so partial rescans stay correct. */
  private fileCache = new Map<string, FileEntry>();

  constructor(
    private readonly opts: {
      userhome: string;
      cacheFile: string;
      now: () => number;
      /** Extra credential homes to scan (managed accounts) beyond the host home. */
      accountHomes?: () => { agent: "claude" | "codex"; home: string }[];
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

  async recompute(): Promise<void> {
    const files: { path: string; agent: "claude" | "codex" }[] = [];
    for (const dir of this.homeDirs("claude", "CLAUDE_CONFIG_DIR", "projects"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "claude" });
    for (const dir of this.homeDirs("codex", "CODEX_HOME", "sessions"))
      for (const f of await walkJsonl(dir)) files.push({ path: f, agent: "codex" });

    // Drop cache entries for files that no longer exist.
    const present = new Set(files.map((f) => f.path));
    for (const path of [...this.fileCache.keys()]) if (!present.has(path)) this.fileCache.delete(path);

    // Re-read only new/changed files (mtime or size differs from the cache).
    const done = new Set<string>();
    for (const { path, agent } of files) {
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
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        this.fileCache.delete(path);
        continue;
      }
      const rows = agent === "claude" ? parseClaudeFile(text, st.mtimeMs) : parseCodexFile(text, st.mtimeMs);
      this.fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, rows });
    }

    // Assemble with deterministic cross-file dedup (first file wins by sorted
    // path) so a partial rescan can't double-count a shared usage identity.
    const raw: RawRow[] = [];
    const seen = new Set<string>();
    for (const path of [...this.fileCache.keys()].sort()) {
      for (const r of this.fileCache.get(path)!.rows) {
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

  /** Host home + every managed-account home for an agent (M3: managed-account
   *  sessions write transcripts under their own CONFIG_DIR/CODEX_HOME). */
  private homeDirs(agent: "claude" | "codex", envVar: string, subdir: string): string[] {
    const host = join(process.env[envVar] || join(this.opts.userhome, agent === "claude" ? ".claude" : ".codex"), subdir);
    const managed = (this.opts.accountHomes?.() ?? [])
      .filter((a) => a.agent === agent)
      .map((a) => join(a.home, subdir));
    return [host, ...managed];
  }
}
