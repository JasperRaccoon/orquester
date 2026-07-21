import { EventEmitter } from "node:events";
import type { AgentUsage, UsageResponse } from "@orquester/api";
import { usageAgentEnabled, type UsagePrefs } from "@orquester/config";

export interface UsageServiceDeps {
  /** Returns the Claude agent (possibly stale) or null when not logged in. */
  fetchClaude: () => Promise<AgentUsage | null>;
  /** Returns the Codex agent or null when not logged in / API-key mode. */
  readCodex: () => Promise<AgentUsage | null>;
  getPrefs: () => Promise<UsagePrefs>;
  now: () => number;
  /**
   * Poll cadence (default 5m fresh / 5m stale). The Anthropic /api/oauth/usage
   * endpoint rate-limits per account (~Retry-After 256s), so polling faster than
   * ~5m just 429s; the 5h/weekly windows move slowly, so 5m is plenty.
   */
  activeMs?: number;
  idleMs?: number;
}

const DEFAULT_PREFS: UsagePrefs = {
  enabled: true,
  agents: {},
  chip: "busiest",
  view: "aggregate"
};

export class UsageService {
  readonly events = new EventEmitter();
  private cache: UsageResponse = { agents: [] };
  private hash = "";
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly deps: UsageServiceDeps) {}

  async recompute(): Promise<void> {
    const prefs = await this.deps.getPrefs().catch(() => DEFAULT_PREFS);
    const agents: AgentUsage[] = [];
    if (usageAgentEnabled(prefs, "claude")) {
      const c = await this.deps.fetchClaude().catch(() => null);
      if (c) agents.push(c);
    }
    if (usageAgentEnabled(prefs, "codex")) {
      const x = await this.deps.readCodex().catch(() => null);
      if (x) agents.push(x);
    }
    this.cache = { agents };
    const h = JSON.stringify(agents); // dedupe on the agents payload
    if (h !== this.hash) {
      this.hash = h;
      this.events.emit("changed", this.cache);
    }
  }

  async snapshot(force = false): Promise<UsageResponse> {
    if (force) await this.recompute();
    return this.cache;
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.recompute().catch(() => undefined);
    if (this.stopped) return;
    const claude = this.cache.agents.find((a) => a.id === "claude");
    const delay = claude?.stale ? this.deps.idleMs ?? 300_000 : this.deps.activeMs ?? 300_000;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
