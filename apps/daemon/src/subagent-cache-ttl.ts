import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SubagentCacheTtlStatus } from "@orquester/api";
import { parseSubagentCacheTtlState, type SubagentCacheTtlMode, type SubagentCacheTtlState } from "@orquester/config";
import { writeFileAtomic } from "./agent-hooks.ts";

export type SubagentCacheTtl = SubagentCacheTtlState["ttl"];

/** The cache usage of one Claude subagent request, as its transcript recorded it. */
export interface SubagentRequest {
  /** The subagent the request belongs to. */
  sub: string;
  /** Epoch ms. */
  ts: number;
  cacheRead: number;
  /** All cache writes, of which `cacheWrite1h` went to the 1h cache. */
  cacheWrite: number;
  cacheWrite1h: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How much usage a check looks at, and how long its decision stands. */
const WINDOW_DAYS = 14;
const CHECK_INTERVAL_MS = 7 * DAY_MS;
/** Too little usage to judge: look again sooner than a full interval. */
const RETRY_INTERVAL_MS = DAY_MS;
const MIN_REQUESTS = 500;
/** 1h must beat (or lose to) 5m by more than this to change the choice. */
const MARGIN_PCT = 5;

// Cache prices in hundredths of the base input price, so the sums stay integers.
const WRITE_5M = 125;
const WRITE_1H = 200;
const READ = 10;

/**
 * What the given subagent requests cost in cache writes and reads under a 5m
 * and under a 1h lifetime, in base-input-token units. One of the two is what
 * happened and the other is estimated; they differ in the write price and in
 * the requests that follow a 5-60 minute wait, which re-write the subagent's
 * prefix at 5m and read it at 1h.
 */
export function estimateSubagentCacheCosts(requests: readonly SubagentRequest[]): {
  requests: number;
  cost5m: number;
  cost1h: number;
} {
  const bySub = new Map<string, SubagentRequest[]>();
  for (const r of requests) {
    const list = bySub.get(r.sub);
    if (list) list.push(r);
    else bySub.set(r.sub, [r]);
  }
  let cost5m = 0;
  let cost1h = 0;
  for (const list of bySub.values()) {
    list.sort((a, b) => a.ts - b.ts);
    // A subagent's lifetime is fixed when its session launches.
    let written = 0;
    let written1h = 0;
    for (const r of list) {
      written += r.cacheWrite;
      written1h += Math.min(r.cacheWrite, r.cacheWrite1h);
    }
    const ran1h = written1h * 2 > written;
    // What other sessions keep warm for it (system prompt, tools): all a
    // subagent on 5m still reads after its own prefix expired.
    const shared = list[0]!.cacheRead;
    let prev: SubagentRequest | undefined;
    for (const r of list) {
      const total = r.cacheWrite + r.cacheRead;
      let read5m = r.cacheRead;
      let read1h = r.cacheRead;
      const gap = prev ? r.ts - prev.ts : 0;
      if (prev && gap >= 5 * MINUTE_MS && gap < 60 * MINUTE_MS) {
        if (ran1h) read5m = Math.min(r.cacheRead, shared);
        else read1h = Math.max(r.cacheRead, Math.min(prev.cacheWrite + prev.cacheRead, total));
      }
      cost5m += WRITE_5M * (total - read5m) + READ * read5m;
      cost1h += WRITE_1H * (total - read1h) + READ * read1h;
      prev = r;
    }
  }
  return { requests: requests.length, cost5m: cost5m / 100, cost1h: cost1h / 100 };
}

export interface SubagentCacheTtlDecision {
  outcome: SubagentCacheTtlState["outcome"];
  ttl: SubagentCacheTtl;
  requests: number;
  changePct: number | null;
}

/** Pick the cheaper lifetime for the given usage; `current` stays when neither clearly wins. */
export function decideSubagentCacheTtl(
  requests: readonly SubagentRequest[],
  current: SubagentCacheTtl
): SubagentCacheTtlDecision {
  const costs = estimateSubagentCacheCosts(requests);
  if (costs.requests < MIN_REQUESTS || costs.cost5m <= 0) {
    return { outcome: "insufficient", ttl: "5m", requests: costs.requests, changePct: null };
  }
  const changePct = Math.round(((costs.cost1h - costs.cost5m) / costs.cost5m) * 1000) / 10;
  const outcome = changePct < -MARGIN_PCT ? "1h" : changePct > MARGIN_PCT ? "5m" : "hold";
  return { outcome, ttl: outcome === "hold" ? current : outcome, requests: costs.requests, changePct };
}

/**
 * The `claudeSubagentCacheTtl` pref resolved to what a Claude launch gets. In
 * auto mode the decision is re-made from recent subagent usage once it is a
 * week old, by whichever launch or status read comes first after that.
 */
export class SubagentCacheTtlController {
  private state: SubagentCacheTtlState | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      stateFile: string;
      now: () => number;
      /** Subagent requests since the given time; null while the transcripts are not scanned yet. */
      requests: (sinceMs: number) => SubagentRequest[] | null;
      logger?: Pick<Console, "warn">;
    }
  ) {}

  /** Read the stored decision. Never throws: anything unreadable is decided again. */
  async init(): Promise<void> {
    try {
      this.state = parseSubagentCacheTtlState(JSON.parse(await readFile(this.opts.stateFile, "utf8")));
    } catch {
      this.state = null;
    }
  }

  async resolve(mode: SubagentCacheTtlMode): Promise<SubagentCacheTtl> {
    if (mode !== "auto") return mode;
    this.checkIfDue();
    await this.writing;
    return this.state?.ttl ?? "5m";
  }

  async status(mode: SubagentCacheTtlMode): Promise<SubagentCacheTtlStatus> {
    const ttl = await this.resolve(mode);
    const state = this.state;
    return {
      mode,
      ttl,
      lastCheck: state
        ? {
            at: new Date(state.checkedAt).toISOString(),
            outcome: state.outcome,
            requests: state.requests,
            windowDays: WINDOW_DAYS,
            changePct: state.changePct
          }
        : null,
      nextCheckAt: mode === "auto" && state ? new Date(state.nextCheckAt).toISOString() : null
    };
  }

  private checkIfDue(): void {
    const now = this.opts.now();
    if (this.state && now < this.state.nextCheckAt) return;
    const requests = this.opts.requests(now - WINDOW_DAYS * DAY_MS);
    if (!requests) return;
    const decision = decideSubagentCacheTtl(requests, this.state?.ttl ?? "5m");
    this.state = {
      version: 1,
      ttl: decision.ttl,
      checkedAt: now,
      nextCheckAt: now + (decision.outcome === "insufficient" ? RETRY_INTERVAL_MS : CHECK_INTERVAL_MS),
      outcome: decision.outcome,
      requests: decision.requests,
      changePct: decision.changePct
    };
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(this.opts.stateFile), { recursive: true });
        await writeFileAtomic(this.opts.stateFile, body, 0o600, false);
      })
      .catch((error: unknown) => {
        (this.opts.logger ?? console).warn(`subagent cache ttl: could not write ${this.opts.stateFile}: ${String(error)}`);
      });
  }
}
