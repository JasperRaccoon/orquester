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

export function estimateCostUsd(
  _agent: string,
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number | null {
  const p = MODEL_PRICING[model];
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

export class UsageTokensScanner {
  private cache: UsageTokensResponse = { rows: [], asOf: new Date(0).toISOString() };

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
    const raw: RawRow[] = [];
    await this.scanClaude(raw);
    await this.scanCodex(raw);
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

  private async scanClaude(raw: RawRow[]): Promise<void> {
    for (const dir of this.homeDirs("claude", "CLAUDE_CONFIG_DIR", "projects")) {
      for (const file of await walkJsonl(dir)) {
        let mtimeMs = this.opts.now();
        try {
          mtimeMs = (await stat(file)).mtimeMs;
        } catch {
          /* ignore */
        }
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
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
          raw.push({
            agent: "claude",
            model: obj?.message?.model ?? "unknown",
            day: dayOf(obj?.timestamp, mtimeMs),
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0
          });
        }
      }
    }
  }

  private async scanCodex(raw: RawRow[]): Promise<void> {
    for (const dir of this.homeDirs("codex", "CODEX_HOME", "sessions")) {
      for (const file of await walkJsonl(dir)) {
        let mtimeMs = this.opts.now();
        try {
          mtimeMs = (await stat(file)).mtimeMs;
        } catch {
          /* ignore */
        }
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
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
          if (typeof obj?.model === "string") model = obj.model;
          else if (typeof obj?.payload?.model === "string") model = obj.payload.model;
          // Real rollout shape: { type:"event_msg", payload:{ type:"token_count",
          // info:{ total_token_usage, last_token_usage } } }. `last_token_usage` is
          // the per-turn delta; gate on the cumulative total advancing so repeated
          // events aren't double-counted.
          if (obj?.type !== "event_msg" || obj?.payload?.type !== "token_count") continue;
          const info = obj.payload.info;
          const total = info?.total_token_usage?.total_tokens ?? 0;
          if (total <= prevTotal) continue;
          prevTotal = total;
          const last = info?.last_token_usage ?? {};
          raw.push({
            agent: "codex",
            model,
            day: dayOf(obj?.timestamp, mtimeMs),
            input: last.input_tokens ?? 0,
            output: last.output_tokens ?? 0,
            cacheRead: last.cached_input_tokens ?? last.cache_read_input_tokens ?? 0,
            cacheWrite: 0
          });
        }
      }
    }
  }
}
