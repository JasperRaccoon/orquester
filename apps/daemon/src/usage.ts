import { EventEmitter } from "node:events";
import type { AgentUsage, UsageResponse } from "@orquester/api";
import { usageAgentEnabled, type UsagePrefs } from "@orquester/config";

interface UsageServiceDeps {
  /** Returns the Claude agent (possibly stale) or null when not logged in. */
  fetchClaude: () => Promise<AgentUsage | null>;
  /** Returns the Codex agent or null when not logged in / API-key mode. */
  readCodex: () => Promise<AgentUsage | null>;
  /** Returns the Grok agent or null when no xai/grok credential exists. */
  readGrok?: () => Promise<AgentUsage | null>;
  getPrefs: () => Promise<UsagePrefs>;
}

const DEFAULT_PREFS: UsagePrefs = {
  enabled: true,
  agents: {},
  chip: "busiest"
};

export class UsageService {
  readonly events = new EventEmitter();
  private cache: UsageResponse = { agents: [] };
  private hash = "";
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private firstReadingDone!: () => void;
  private readonly firstReading = new Promise<void>((resolve) => {
    this.firstReadingDone = resolve;
  });

  constructor(private readonly deps: UsageServiceDeps) {}

  /**
   * Resolves once the first reading after `start()` is held (or `timeoutMs` passed): what reads
   * usage synchronously at boot — a workflow's account selection — waits for it rather than
   * reading an empty snapshot as "usage unknown" for every account.
   */
  async whenFirstReading(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.firstReading,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })
    ]);
    clearTimeout(timer);
  }

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
    if (this.deps.readGrok && usageAgentEnabled(prefs, "grok")) {
      const g = await this.deps.readGrok().catch(() => null);
      if (g) agents.push(g);
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
    this.firstReadingDone();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), 300_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
