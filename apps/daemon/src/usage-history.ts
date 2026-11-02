// The usage ledger: hourly token buckets the Usage view reads (`<appdir>/daemon/usage-history.json`,
// 0600). The Claude CLI deletes transcripts after 30 days; the ledger keeps what the scanners once
// saw, so the 90-day view keeps working. Spec: docs/superpowers/specs/2026-11-02-usage-panel-design.md §4.3.
//
// A bucket is one (source, agent, raw model, speed, UTC hour, project). After each scan the live
// records are merged in by a high-water rule: the live bucket replaces the stored one unless the
// stored one has more requests (its transcript was deleted or truncated), session sets are unioned,
// and stored buckets with no live counterpart are kept. Prices apply at query time, so a price
// edit reprices all history.
//
// File (`version: 1`): `{ version, recordedSince, sessions: string[], buckets: Row[] }`, where a Row is
// `[source, agent, model, speed, hour, project, input, cacheRead, cacheWrite, cacheWrite1h, output,
// reasoning, requests, reportedCostUsd, reportedRequests, sessionIndexes[]]` and sessionIndexes
// point into `sessions`. Unknown top-level fields and extra trailing row columns are written back.

import { realpathSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type {
  UsageCostParts,
  UsageCostSource,
  UsageHistoryBucket,
  UsageHistoryProjectBucket,
  UsageHistoryResponse,
  UsageHistorySessions,
  UsageHistorySource,
  UsagePriceModelInfo,
  UsageSpeed,
  UsageTokenTotals
} from "@orquester/api";

import { writeFileAtomic } from "./agent-hooks.ts";
import { canonicalModel, overrideFor, priceSlice, resolvePricingKey } from "./usage-pricing.ts";
import { HOUR_MS, type UsageRecord, type UsageRecordSource } from "./usage-records.ts";

const VERSION = 1;
const DAY_HOURS = 24;
/** Buckets older than this are dropped. */
const RETENTION_HOURS = 120 * DAY_HOURS;
/** The prices response lists the models of this many recent days. */
const SEEN_MODELS_HOURS = 90 * DAY_HOURS;
/** At most one write per this long. */
const WRITE_INTERVAL_MS = 60_000;
const MAX_RANGE_DAYS = 90;

type Source = UsageRecord["source"];
const SOURCES: readonly Source[] = ["transcripts", "orquester-chats"];
const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];
/** Shown even before they have data: where each agent's usage comes from. */
const KNOWN_SOURCES: readonly { agent: string; scope: Source }[] = [
  { agent: "claude", scope: "transcripts" },
  { agent: "codex", scope: "transcripts" },
  { agent: "grok", scope: "orquester-chats" },
  { agent: "opencode", scope: "orquester-chats" }
];
/** Row columns 0–15; anything after is a newer writer's and kept as is. */
const ROW_COLUMNS = 16;

interface Sums {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
  requests: number;
  reportedCostUsd: number;
  reportedRequests: number;
}

interface Bucket extends Sums {
  source: Source;
  agent: string;
  model: string;
  speed: UsageSpeed;
  hour: number;
  project: string;
  sessions: Set<string>;
  /** Trailing row columns a newer writer added. */
  tail?: unknown[];
}

const SUM_FIELDS = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "reasoning", "requests", "reportedCostUsd", "reportedRequests"] as const;

const emptySums = (): Sums => ({ input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0, requests: 0, reportedCostUsd: 0, reportedRequests: 0 });

function addSums(into: Sums, from: Sums): void {
  for (const field of SUM_FIELDS) into[field] += from[field];
}

const processed = (s: Sums): number => s.input + s.cacheRead + s.cacheWrite + s.output;

const tokensOf = (s: Sums): UsageTokenTotals => ({
  input: s.input, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, cacheWrite1h: s.cacheWrite1h, output: s.output, reasoning: s.reasoning
});

const bucketKey = (b: Pick<Bucket, "source" | "agent" | "model" | "speed" | "hour" | "project">): string =>
  `${b.source}|${b.agent}|${b.model}|${b.speed}|${b.hour}|${b.project}`;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

// --- ranges and zones ---------------------------------------------------------

export type UsageHistoryRange = { label: string; resolution: "hour" } | { label: string; resolution: "day"; days: number };

/** `24h`, or `<N>d` with 1 ≤ N ≤ 90; null for anything else. */
export function parseUsageHistoryRange(raw: unknown): UsageHistoryRange | null {
  if (raw === "24h") return { label: raw, resolution: "hour" };
  if (typeof raw !== "string") return null;
  const match = /^([1-9]\d?)d$/.exec(raw);
  if (!match) return null;
  const days = Number(match[1]);
  return days <= MAX_RANGE_DAYS ? { label: raw, resolution: "day", days } : null;
}

interface Zone {
  name: string;
  parts: Intl.DateTimeFormat;
}

/** The zone as Intl names it; an invalid or missing one is UTC. */
function zoneOf(timeZone: string | undefined): Zone {
  for (const candidate of [timeZone, "UTC"]) {
    if (!candidate) continue;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: candidate, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      return { name: parts.resolvedOptions().timeZone, parts };
    } catch {
      // RangeError: not a zone
    }
  }
  throw new Error("unreachable: UTC is always a zone");
}

/** The wall-clock fields of `ms` in `zone`. */
function wall(zone: Zone, ms: number): { y: number; m: number; d: number; asUtc: number } {
  const fields: Record<string, number> = {};
  for (const part of zone.parts.formatToParts(ms)) if (part.type !== "literal") fields[part.type] = Number(part.value);
  const { year: y, month: m, day: d } = fields as { year: number; month: number; day: number };
  return { y, m, d, asUtc: Date.UTC(y, m - 1, d, fields.hour % 24, fields.minute, fields.second) };
}

const dayString = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** `day` ("YYYY-MM-DD") moved by `delta` calendar days (UTC arithmetic: no DST). */
function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d + delta));
  return dayString(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** The instant `day` starts in `zone`. */
function startOfDay(zone: Zone, day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let at = target;
  // Two passes: the offset at the first guess, then at the corrected instant (a DST change between).
  for (let i = 0; i < 2; i++) at = target - (wall(zone, at).asUtc - at);
  return at;
}

// --- projects -----------------------------------------------------------------

/** "<workspace>/<project>" when `cwd` lies two or more segments under `root`, else null. */
function projectUnder(root: string, cwd: string): string | null {
  const rel = relative(root, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const segments = rel.split(sep);
  return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
}

// --- the ledger ---------------------------------------------------------------

export interface UsageHistoryOptions {
  path: string;
  /** The workspaces root, read on each ingest (it can change at runtime). */
  workspacesDir: () => string;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

export interface UsageHistoryQuery {
  range: UsageHistoryRange;
  /** IANA zone the days are cut in (invalid → UTC). */
  timeZone?: string;
  /** The first transcript scan has not finished: totals may still grow. */
  scanning: boolean;
}

export class UsageHistory {
  private readonly buckets = new Map<string, Bucket>();
  private recordedSince: string | null = null;
  /** Unknown top-level fields of the file, written back untouched. */
  private extra: Record<string, unknown> = {};
  /** False when the file could not be moved out of the way: never overwrite it. */
  private writable = true;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private writing: Promise<void> = Promise.resolve();
  /** Sources whose records have been merged at least once. */
  private readonly ingested = new WeakSet<UsageRecordSource>();
  private rootCache: { raw: string; real: string } | null = null;

  constructor(private readonly opts: UsageHistoryOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Read the ledger. Never throws: anything unreadable starts empty. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.opts.path, "utf8");
    } catch {
      return; // ENOENT (first run) or unreadable
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const doc = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    if (!doc || typeof doc.version !== "number") {
      await this.moveAside(`${this.opts.path}.corrupt-${this.now()}`, "did not parse");
      return;
    }
    if (doc.version !== VERSION) {
      await this.moveAside(`${this.opts.path}.v${doc.version}.bak`, `has version ${doc.version}`);
      return;
    }
    const { version: _version, recordedSince, sessions, buckets, ...extra } = doc;
    this.extra = extra;
    if (typeof recordedSince === "string" && Number.isFinite(Date.parse(recordedSince))) this.recordedSince = recordedSince;
    const table = Array.isArray(sessions) ? sessions : [];
    const cutoff = this.cutoffHour();
    for (const row of Array.isArray(buckets) ? buckets : []) {
      const bucket = parseRow(row, table);
      if (!bucket) continue;
      if (bucket.hour < cutoff) {
        this.dirty = true;
        continue;
      }
      const key = bucketKey(bucket);
      const stored = this.buckets.get(key);
      if (stored) mergeInto(stored, bucket);
      else this.buckets.set(key, bucket);
    }
  }

  private async moveAside(to: string, why: string): Promise<void> {
    try {
      await rename(this.opts.path, to);
      this.opts.logger?.warn(`usage history: ${this.opts.path} ${why}; moved aside to ${to}, starting empty`);
    } catch {
      this.writable = false;
      this.opts.logger?.warn(`usage history: ${this.opts.path} ${why} and could not be moved aside; not recording`);
    }
  }

  /** True once `source` delivered records (after its first full scan). */
  hasIngested(source: UsageRecordSource): boolean {
    return this.ingested.has(source);
  }

  /**
   * Merge a source's live records (high-water rule). False when it has none yet (no full scan);
   * a change is written within a minute.
   */
  ingest(source: UsageRecordSource): boolean {
    const records = source.historyRecords();
    if (!records) return false;
    this.ingested.add(source);
    const cutoff = this.cutoffHour();
    const projects = new Map<string, string>();
    const live = new Map<string, Bucket>();
    for (const record of records) {
      if (record.hour < cutoff || !SOURCES.includes(record.source)) continue;
      const cwd = record.cwd;
      let project = "";
      if (cwd) {
        const known = projects.get(cwd);
        if (known === undefined) projects.set(cwd, (project = this.projectOf(cwd)));
        else project = known;
      }
      const speed = SPEEDS.includes(record.speed) ? record.speed : "standard";
      const identity = { source: record.source, agent: record.agent, model: record.model, speed, hour: record.hour, project };
      const key = bucketKey(identity);
      let bucket = live.get(key);
      if (!bucket) live.set(key, (bucket = { ...identity, ...emptySums(), sessions: new Set() }));
      for (const field of SUM_FIELDS) bucket[field] += finite(record[field]) ? record[field] : 0;
      if (record.session) bucket.sessions.add(record.session);
    }
    let changed = this.prune(cutoff);
    for (const [key, bucket] of live) {
      const stored = this.buckets.get(key);
      if (!stored) {
        this.buckets.set(key, bucket);
        changed = true;
      } else if (mergeInto(stored, bucket)) changed = true;
    }
    if (changed) this.markDirty();
    return true;
  }

  /** Write now what is pending (the daemon's stop). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.dirty) this.write();
    await this.writing;
  }

  query(q: UsageHistoryQuery): UsageHistoryResponse {
    const now = this.now();
    const zone = zoneOf(q.timeZone);
    const nowHour = Math.floor(now / HOUR_MS);
    let periods: string[];
    let since: number;
    let until: number;
    let periodOf: (hour: number) => number;
    if (q.range.resolution === "hour") {
      const first = nowHour - (DAY_HOURS - 1);
      periods = Array.from({ length: DAY_HOURS }, (_, i) => new Date((first + i) * HOUR_MS).toISOString());
      since = first * HOUR_MS;
      until = (nowHour + 1) * HOUR_MS;
      periodOf = (hour) => (hour >= first && hour <= nowHour ? hour - first : -1);
    } else {
      const today = wall(zone, now);
      const untilDay = dayString(today.y, today.m, today.d);
      const sinceDay = addDays(untilDay, -(q.range.days - 1));
      periods = Array.from({ length: q.range.days }, (_, i) => addDays(sinceDay, i));
      since = startOfDay(zone, sinceDay);
      until = startOfDay(zone, addDays(untilDay, 1));
      const index = new Map(periods.map((day, i) => [day, i]));
      // An hour is in the local day its start instant falls on; a zone with a sub-hour offset
      // (Asia/Kathmandu) is approximated to whole hours. Hours near the window's edges are checked.
      const firstHour = Math.floor(since / HOUR_MS) - 1;
      const lastHour = Math.ceil(until / HOUR_MS) + 1;
      const cache = new Map<number, number>();
      periodOf = (hour) => {
        if (hour < firstHour || hour > lastHour) return -1;
        let period = cache.get(hour);
        if (period === undefined) {
          const local = wall(zone, hour * HOUR_MS);
          cache.set(hour, (period = index.get(dayString(local.y, local.m, local.d)) ?? -1));
        }
        return period;
      };
    }

    interface Cell extends Sums {
      period: number;
      agent: string;
      model: string;
      speed: UsageSpeed;
    }
    interface ProjectCell extends Sums {
      project: string;
      agent: string;
      model: string;
      speed: UsageSpeed;
    }
    const cells = new Map<string, Cell>();
    const projectCells = new Map<string, ProjectCell>();
    const sessions = {
      total: new Set<string>(),
      byAgent: new Map<string, Set<string>>(),
      byModel: new Map<string, Set<string>>(),
      byProject: new Map<string, Set<string>>(),
      byProjectAgent: new Map<string, Set<string>>()
    };
    const addSessions = (map: Map<string, Set<string>>, key: string, ids: Iterable<string>) => {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      for (const id of ids) set.add(id);
    };
    const canonical = new Map<string, string>();
    for (const bucket of this.buckets.values()) {
      const period = periodOf(bucket.hour);
      if (period < 0) continue;
      let model = canonical.get(bucket.model);
      if (model === undefined) canonical.set(bucket.model, (model = canonicalModel(bucket.model)));
      const cellKey = `${period}|${bucket.agent}|${model}|${bucket.speed}`;
      let cell = cells.get(cellKey);
      if (!cell) cells.set(cellKey, (cell = { period, agent: bucket.agent, model, speed: bucket.speed, ...emptySums() }));
      addSums(cell, bucket);
      const projectKey = `${bucket.project}|${bucket.agent}|${model}|${bucket.speed}`;
      let projectCell = projectCells.get(projectKey);
      if (!projectCell) projectCells.set(projectKey, (projectCell = { project: bucket.project, agent: bucket.agent, model, speed: bucket.speed, ...emptySums() }));
      addSums(projectCell, bucket);
      if (bucket.sessions.size === 0) continue;
      // Ids are per agent: the same id under two agents is two sessions.
      const ids = [...bucket.sessions].map((id) => `${bucket.agent}\u0000${id}`);
      for (const id of ids) sessions.total.add(id);
      addSessions(sessions.byAgent, bucket.agent, ids);
      addSessions(sessions.byModel, `${bucket.agent}:${model}`, ids);
      addSessions(sessions.byProject, bucket.project, ids);
      addSessions(sessions.byProjectAgent, `${bucket.agent}:${bucket.project}`, ids);
    }

    const buckets: UsageHistoryBucket[] = [...cells.values()]
      .sort((a, b) => a.period - b.period || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model) || a.speed.localeCompare(b.speed))
      .map((cell) => ({ period: cell.period, agent: cell.agent, model: cell.model, speed: cell.speed, tokens: tokensOf(cell), requests: cell.requests, ...priceCell(cell.model, cell.speed, cell) }));

    // Priced per speed (tiers bill differently), then summed per (project, agent, model).
    const projectTotals = new Map<string, { project: string; agent: string; model: string; sums: Sums; costUsd: number | null; unpricedTokens: number }>();
    for (const cell of projectCells.values()) {
      const key = `${cell.project}|${cell.agent}|${cell.model}`;
      let total = projectTotals.get(key);
      if (!total) projectTotals.set(key, (total = { project: cell.project, agent: cell.agent, model: cell.model, sums: emptySums(), costUsd: null, unpricedTokens: 0 }));
      addSums(total.sums, cell);
      const priced = priceCell(cell.model, cell.speed, cell);
      if (priced.costUsd !== null) total.costUsd = (total.costUsd ?? 0) + priced.costUsd;
      total.unpricedTokens += priced.unpricedTokens;
    }
    const projectBuckets: UsageHistoryProjectBucket[] = [...projectTotals.values()]
      .sort((a, b) => a.project.localeCompare(b.project) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model))
      .map((t) => ({ project: t.project, agent: t.agent, model: t.model, tokens: tokensOf(t.sums), requests: t.sums.requests, costUsd: t.costUsd, unpricedTokens: t.unpricedTokens }));

    const counts = (map: Map<string, Set<string>>) => Object.fromEntries([...map].map(([key, set]) => [key, set.size]));
    const sessionCounts: UsageHistorySessions = {
      total: sessions.total.size,
      byAgent: counts(sessions.byAgent),
      byModel: counts(sessions.byModel),
      byProject: counts(sessions.byProject),
      byProjectAgent: counts(sessions.byProjectAgent)
    };

    return {
      range: q.range.label,
      resolution: q.range.resolution,
      timeZone: zone.name,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      periods,
      buckets,
      projectBuckets,
      sessions: sessionCounts,
      sources: this.sources(),
      recordedSince: this.recordedSince,
      scanning: q.scanning,
      asOf: new Date(now).toISOString(),
      costSource: "api_equivalent"
    };
  }

  /** Every model in the last 90 days, by processed tokens desc, with how it is priced now. */
  seenModels(): UsagePriceModelInfo[] {
    const since = Math.floor(this.now() / HOUR_MS) - SEEN_MODELS_HOURS;
    const seen = new Map<string, { agent: string; model: string; tokens: number; reported: boolean }>();
    for (const bucket of this.buckets.values()) {
      if (bucket.hour < since) continue;
      const key = `${bucket.agent}|${bucket.model}`;
      let entry = seen.get(key);
      if (!entry) seen.set(key, (entry = { agent: bucket.agent, model: bucket.model, tokens: 0, reported: false }));
      entry.tokens += processed(bucket);
      if (bucket.reportedRequests > 0) entry.reported = true;
    }
    return [...seen.values()]
      .map(({ agent, model, tokens, reported }): UsagePriceModelInfo => {
        const target = canonicalModel(model);
        const aliasOf = target !== model.trim() ? target : null;
        const pricingKey = resolvePricingKey(target);
        const status: UsagePriceModelInfo["status"] = aliasOf
          ? "alias"
          : overrideFor(model)
            ? "override"
            : reported
              ? "reported"
              : pricingKey
                ? "builtin"
                : "unpriced";
        return { agent, model, status, pricingKey, aliasOf, tokens };
      })
      .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model) || a.agent.localeCompare(b.agent));
  }

  private sources(): UsageHistorySource[] {
    const oldest = new Map<string, number>();
    for (const bucket of this.buckets.values()) {
      const key = `${bucket.agent}|${bucket.source}`;
      const known = oldest.get(key);
      if (known === undefined || bucket.hour < known) oldest.set(key, bucket.hour);
    }
    const out: UsageHistorySource[] = [];
    const listed = new Set<string>();
    for (const { agent, scope } of KNOWN_SOURCES) {
      listed.add(`${agent}|${scope}`);
      const hour = oldest.get(`${agent}|${scope}`);
      out.push({ agent, scope, oldestAt: hour === undefined ? null : new Date(hour * HOUR_MS).toISOString() });
    }
    for (const [key, hour] of [...oldest].sort(([a], [b]) => a.localeCompare(b))) {
      if (listed.has(key)) continue;
      const [agent, scope] = key.split("|") as [string, Source];
      out.push({ agent, scope, oldestAt: new Date(hour * HOUR_MS).toISOString() });
    }
    return out;
  }

  private cutoffHour(): number {
    return Math.floor(this.now() / HOUR_MS) - RETENTION_HOURS;
  }

  /** Drop buckets past retention; true when any went. */
  private prune(cutoff: number): boolean {
    let dropped = false;
    for (const [key, bucket] of this.buckets) {
      if (bucket.hour >= cutoff) continue;
      this.buckets.delete(key);
      dropped = true;
    }
    return dropped;
  }

  /** The cwd's "<workspace>/<project>", against the workspaces root as given and as resolved. */
  private projectOf(cwd: string): string {
    const raw = resolve(this.opts.workspacesDir());
    if (this.rootCache?.raw !== raw) {
      let real = raw;
      try {
        real = realpathSync(raw);
      } catch {
        // a missing root: compare against the path as given
      }
      this.rootCache = { raw, real };
    }
    const path = resolve(cwd);
    return projectUnder(raw, path) ?? (this.rootCache.real !== raw ? projectUnder(this.rootCache.real, path) : null) ?? "";
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer || !this.writable) return;
    const delay = Math.max(0, this.lastWriteAt + WRITE_INTERVAL_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.write();
    }, delay);
    this.timer.unref?.();
  }

  private write(): void {
    if (!this.writable) return;
    this.dirty = false;
    this.lastWriteAt = this.now();
    this.recordedSince ??= new Date(this.lastWriteAt).toISOString();
    const body = JSON.stringify(this.serialize());
    this.writing = this.writing
      .then(() => writeFileAtomic(this.opts.path, body, 0o600, false))
      .catch((error: unknown) => {
        this.opts.logger?.warn(`usage history: could not write ${this.opts.path}: ${String(error)}`);
      });
  }

  private serialize(): Record<string, unknown> {
    const sessions: string[] = [];
    const index = new Map<string, number>();
    const rows = [...this.buckets.values()]
      .sort((a, b) => a.hour - b.hour || bucketKey(a).localeCompare(bucketKey(b)))
      .map((b) => {
        const ids = [...b.sessions].map((id) => {
          let i = index.get(id);
          if (i === undefined) {
            index.set(id, (i = sessions.length));
            sessions.push(id);
          }
          return i;
        });
        const row: unknown[] = [b.source, b.agent, b.model, b.speed, b.hour, b.project, ...SUM_FIELDS.map((f) => b[f]), ids];
        return b.tail ? [...row, ...b.tail] : row;
      });
    return { ...this.extra, version: VERSION, recordedSince: this.recordedSince, sessions, buckets: rows };
  }
}

/**
 * Fold `live` into `stored` by the high-water rule; true when `stored` changed. The live sums win
 * unless the stored bucket has more requests; sessions are unioned either way.
 */
function mergeInto(stored: Bucket, live: Bucket): boolean {
  let changed = false;
  if (stored.requests <= live.requests) {
    for (const field of SUM_FIELDS) {
      if (stored[field] === live[field]) continue;
      stored[field] = live[field];
      changed = true;
    }
  }
  for (const id of live.sessions) {
    if (stored.sessions.has(id)) continue;
    stored.sessions.add(id);
    changed = true;
  }
  return changed;
}

/** One stored row, or null when it does not parse. */
function parseRow(row: unknown, sessions: unknown[]): Bucket | null {
  if (!Array.isArray(row) || row.length < ROW_COLUMNS) return null;
  const [source, agent, model, speed, hour, project] = row as unknown[];
  if (!SOURCES.includes(source as Source) || !SPEEDS.includes(speed as UsageSpeed)) return null;
  if (typeof agent !== "string" || !agent || typeof model !== "string" || typeof project !== "string") return null;
  if (!Number.isSafeInteger(hour)) return null;
  const sums = emptySums();
  for (let i = 0; i < SUM_FIELDS.length; i++) {
    const value = row[6 + i];
    if (!finite(value) || value < 0) return null;
    sums[SUM_FIELDS[i]!] = value;
  }
  const ids = row[ROW_COLUMNS - 1];
  if (!Array.isArray(ids)) return null;
  const set = new Set<string>();
  for (const i of ids) {
    const id = Number.isInteger(i) ? sessions[i as number] : undefined;
    if (typeof id === "string" && id) set.add(id);
  }
  const bucket: Bucket = { source: source as Source, agent, model, speed: speed as UsageSpeed, hour: hour as number, project, ...sums, sessions: set };
  if (row.length > ROW_COLUMNS) bucket.tail = row.slice(ROW_COLUMNS);
  return bucket;
}

/** Price one (agent, model after aliasing, speed) cell: override > reported > built-in > unpriced. */
function priceCell(
  model: string,
  speed: UsageSpeed,
  sums: Sums
): { costUsd: number | null; cost: UsageCostParts | null; costSource: UsageCostSource; cacheSavingsUsd: number; unpricedTokens: number } {
  const tokens = processed(sums);
  if (!overrideFor(model) && sums.reportedRequests > 0) {
    const unreported = sums.requests > 0 ? Math.max(0, sums.requests - sums.reportedRequests) / sums.requests : 0;
    return { costUsd: sums.reportedCostUsd, cost: null, costSource: "reported", cacheSavingsUsd: 0, unpricedTokens: tokens * unreported };
  }
  const priced = priceSlice(model, speed, sums);
  if (!priced) return { costUsd: null, cost: null, costSource: "unpriced", cacheSavingsUsd: 0, unpricedTokens: tokens };
  return { costUsd: priced.costUsd, cost: priced.parts, costSource: "estimated", cacheSavingsUsd: priced.cacheSavingsUsd, unpricedTokens: 0 };
}
