/**
 * Agent host — the sweep every provider session runs when it ends, natural
 * exits included: what one launch of a provider CLI left running is stopped,
 * by the scope rule of `leftover-processes.ts`.
 *
 * Adapted from T3 Code (MIT): `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`
 * (`spawnClaudeProcessGroup`: once the CLI exits for any reason, the rest of
 * its group gets SIGKILL, #3089 — a plugin's `bun run start` wrapper dies and
 * its `bun server.ts` kept running) and `apps/server/src/process/agentScope.ts`
 * (`stop`, run on the CLI's exit, #21299). T3 reaps the agent's whole systemd
 * scope; here a sweep is narrower, because one agent-browser daemon and its
 * Chromium are shared by every chat on a host.
 *
 * **The rule.** A process is stopped when, and only when:
 * 1. its environment carries `ORQUESTER_AGENT_LAUNCH=<this launch>` exactly —
 *    no process another chat's launch started, nothing outside the host's
 *    agents (the user's tmux, shell, editor) ever matches;
 * 2. it is in this launch's recorded scope:
 *    - the CLI's own process group ({@link watchGroup}), when the CLI leads
 *      one — `spawnProviderChild` starts Codex and OpenCode `detached`, and a
 *      stop already signals that group: the sweep makes a natural exit do the
 *      same. The Claude SDK spawns its CLI into the host's own group, so it
 *      never has one;
 *    - the CLI's helper processes ({@link recordHelpers}): its children once
 *      its session opened, before any of the user's work ran — its MCP
 *      servers — and their descendants that stayed in their session;
 * 3. it is not a shared daemon: no `AGENT_BROWSER_DAEMON` in its environment
 *    (agent-browser's daemon and the browser it launched) and not a tmux
 *    server — and a process that `setsid`s away (how both daemonize) leaves
 *    the group and is never recorded as a helper;
 * 4. it is still the process the recording saw (pid AND `/proc` starttime).
 * SIGTERM first, SIGKILL past the grace to what a fresh scan still finds.
 *
 * What that leaves running, on purpose: the user's work a Claude chat started
 * in the host's group (its background shells — new children of the CLI, never
 * helpers), anything that daemonized, and anything a launch started without
 * the marker. Settings → System lists every marked orphan, killable by hand.
 * Linux-only, like everything that reads `/proc`; elsewhere a no-op.
 */

import {
  AGENT_LAUNCH_ENV_VAR,
  findLaunchRoot,
  recordHelperProcesses,
  recordOwnGroup,
  stopLeftoverProcesses,
  type RecordedGroup,
  type RecordedProcess
} from "./leftover-processes.ts";

export interface ProviderLeftoversLogger {
  debug(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
}

export interface ProviderLeftoversOptions {
  /** The launch's environment: its {@link AGENT_LAUNCH_ENV_VAR} names what the sweep may take. */
  env: Readonly<Record<string, string | undefined>>;
  /** The adapter's name, for the log lines. */
  label: string;
  logger: ProviderLeftoversLogger;
  /** SIGTERM, then SIGKILL this long after. Defaults to `spawn.ts`'s grace. */
  graceMs?: number;
}

/** One launch's leftovers: what it recorded while the CLI lived, and the sweep at its end. */
export class ProviderLeftovers {
  private readonly launchId: string;
  private group: RecordedGroup | null = null;
  private cli: RecordedProcess | null = null;
  private helpers: RecordedProcess[] = [];
  /** The first recording ran: the CLI's children are never taken as helpers again. */
  private rooted = false;
  /** Recordings and sweeps run one at a time, in call order: a sweep sees every recording asked before it. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProviderLeftoversOptions) {
    this.launchId = options.env[AGENT_LAUNCH_ENV_VAR] ?? "";
  }

  /** The CLI was spawned as `pid`: its own process group joins the scope, if it leads one. Never rejects. */
  watchGroup(pid: number | undefined): Promise<void> {
    return this.enqueue("record its process group", async () => {
      this.group ??= await recordOwnGroup(pid);
    });
  }

  /**
   * Record the CLI's helpers. The first call — once the session opened, before any of the
   * user's work ran — takes the CLI's children; a later one only follows what they started
   * since. The CLI is found among the host's children by the launch marker (the Claude SDK
   * spawns it, and keeps its pid). Never rejects.
   */
  recordHelpers(): Promise<void> {
    return this.enqueue("record its helpers", async () => {
      if (this.launchId.length === 0) return;
      if (this.cli === null) {
        if (this.rooted) return;
        this.rooted = true;
        this.cli = await findLaunchRoot(this.launchId);
        if (this.cli === null) return;
        this.helpers = await recordHelperProcesses(this.cli);
        return;
      }
      // Only what the first recording's helpers started since: never a new child of the CLI.
      if (this.helpers.length > 0) this.helpers = await recordHelperProcesses(this.cli, this.helpers);
    });
  }

  /** Stop what the launch left in its scope (the module doc's rule). Repeatable; never rejects. */
  sweep(): Promise<void> {
    return this.enqueue("stop what it left running", async () => {
      const scope = {
        ...(this.group !== null ? { group: this.group } : {}),
        ...(this.helpers.length > 0 ? { processes: this.helpers } : {})
      };
      if (this.launchId.length === 0 || (scope.group === undefined && scope.processes === undefined)) return;
      const result = await stopLeftoverProcesses({
        launchId: this.launchId,
        ...scope,
        ...(this.options.graceMs !== undefined ? { graceMs: this.options.graceMs } : {})
      });
      if (result.found > 0) {
        this.options.logger.debug(`${this.options.label}: stopped what the agent left running`, { ...result });
      }
    });
  }

  private enqueue(what: string, step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step).catch((error: unknown) => {
      this.options.logger.warn(`${this.options.label}: could not ${what}`, error);
    });
    this.queue = next;
    return next;
  }
}
