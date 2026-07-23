import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProxyStatus } from "@orquester/api";
import {
  type CliProxySecrets,
  type CliProxyState,
  MODEL_NAME_RE,
  cliproxyDir,
  cliproxyStateFile,
  createDefaultCliProxyState,
  parseCliProxyState
} from "@orquester/config";
import type { Broadcaster } from "./broadcaster.ts";
import { seedHome, writeProjections } from "./cliproxy-files.ts";
import { loadOrInitSecrets } from "./cliproxy-secrets.ts";
import type { RegistryService } from "./registry.ts";
import { SERVICE_SESSION_PREFIX, type Tmux } from "./tmux.ts";

/** Dedicated service session name — MUST live outside the reaped `orq-` namespace. */
const SERVICE_SESSION_NAME = `${SERVICE_SESSION_PREFIX}cliproxy`;
/** Registry launcher entries gated behind the managed proxy. */
const DEPENDENT_ENTRY_IDS = ["claudex", "claudemix"] as const;
/** Crash-supervision cap: after this many failed respawns the manager latches `error`. */
const MAX_RESPAWNS = 3;
/** Exponential backoff base between supervised respawn attempts. */
const BACKOFF_BASE_MS = 1000;
/** `validateModel` bounds its freshness probe so a hung proxy can't stall a launch. */
const VALIDATE_PROBE_TIMEOUT_MS = 2000;

type ProbeResult = { ok: boolean; reachable?: boolean; models?: string[] };

/**
 * Injected side-effect surface, faked wholesale under test. `probe` reports
 * whether the port answered (`reachable`) distinctly from whether OUR key was
 * accepted (`ok`) — the two are what let boot adoption classify a surviving-own
 * proxy (persistence-lost) apart from a foreign listener (port conflict).
 */
export interface CliProxyAdapters {
  probe(port: number, apiKey: string): Promise<ProbeResult>;
  tmux: Pick<Tmux, "newServiceSession" | "hasServiceSession" | "killServiceSession"> | null;
  spawnDirect(bin: string, args: string[]): { kill(): void } | null; // no-tmux fallback
  liveDependentSessionCount(): number; // daemon-managed claudex/claudemix sessions
  now(): number;
  /**
   * Install the pinned proxy binary into `cliproxy/bin` (Task 7 wires the real
   * verified-download installer). Absent (pre-wiring) → `enable()` falls back to
   * requiring an already-present binary.
   */
  install?(): Promise<{ version: string }>;
  /** Source Claude config dir `seedHome` copies shared config from (production:
   *  `CLAUDE_CONFIG_DIR || ~/.claude`). */
  systemClaudeDir?(): string;
}

type ValidateResult = { ok: true; effectiveModel: string } | { ok: false; error: string };

/**
 * Owns the managed CLIProxyAPI lifecycle as a serialized state machine: a single
 * in-flight transition promise (`queue`) guards every mutation so adoption,
 * enable/disable, config changes and crash supervision never interleave. All I/O
 * and process control is injected via {@link CliProxyAdapters}; this class carries
 * only the state logic (Phase 1 — the real source-build pipeline is Phase 2).
 */
export class CliProxyManager {
  private readonly daemonDir: string;
  private readonly registry: RegistryService;
  private readonly broadcaster: Broadcaster;
  private readonly adapters: CliProxyAdapters;

  private state: CliProxyState = createDefaultCliProxyState();
  private secrets: CliProxySecrets | null = null;

  private st: CliProxyStatus["state"] = "off";
  private reasons: string[] = [];
  private detail: string | null = null;

  private errorLatched = false;
  /** Set when boot adoption found an out-of-tmux own proxy (persistence-lost). */
  private external = false;
  private respawnAttempts = 0;
  private nextRespawnAt = 0;
  private directHandle: { kill(): void } | null = null;

  /** Serializes every transition — the tail of the in-flight chain. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: {
    daemonDir: string;
    appdir: string;
    registry: RegistryService;
    broadcaster: Broadcaster;
    adapters: CliProxyAdapters;
  }) {
    this.daemonDir = opts.daemonDir;
    this.registry = opts.registry;
    this.broadcaster = opts.broadcaster;
    this.adapters = opts.adapters;
  }

  status(): CliProxyStatus {
    return {
      state: this.st,
      reasons: [...this.reasons],
      detail: this.detail,
      version: this.state.version,
      defaultModel: this.state.defaultModel,
      backgroundModel: this.state.backgroundModel,
      providers: [],
      accounts: [],
      activeSessionCount: this.adapters.liveDependentSessionCount(),
      testedClaudeCliVersion: this.state.testedClaudeCliVersion
    };
  }

  /** Load persisted state + secrets, then run boot adoption (spec §1). */
  init(): Promise<void> {
    return this.transition(async () => {
      this.state = await this.loadState();
      if (!this.state.enabled) {
        this.setState("off", []);
        this.applyRegistryCoupling();
        return;
      }
      const loaded = await loadOrInitSecrets(this.daemonDir);
      if (loaded.state === "corrupt") {
        // Fail-closed: never regenerate over a corrupt store (would orphan a live
        // proxy + every session) and never rewrite projections from it.
        this.fail("cliproxy secrets are corrupt");
        return;
      }
      this.secrets = loaded.secrets;
      await this.bootAdopt();
    });
  }

  /**
   * Async + idempotent orchestration (Phase 2): secrets → install → projections →
   * seed both managed homes → spawn → probe → healthy. Secrets are loaded FIRST
   * and fail-closed on corruption so a bad store installs nothing and rewrites no
   * projections. Without an injected `install` adapter (pre-Task-7 wiring) it
   * falls back to requiring an already-present binary, latching `error` with
   * "binary not installed" if absent.
   */
  enable(): Promise<void> {
    return this.transition(async () => {
      this.errorLatched = false;
      // Secrets first — fail closed BEFORE installing or writing anything.
      const loaded = await loadOrInitSecrets(this.daemonDir);
      if (loaded.state === "corrupt") {
        this.fail("cliproxy secrets are corrupt");
        return;
      }
      this.secrets = loaded.secrets;
      this.state.enabled = true;

      // Install the pinned binary (injected). Pre-wiring fallback: require one.
      if (this.adapters.install) {
        this.setState("starting", [], "downloading proxy binary");
        const installed = await this.adapters.install();
        this.state.version = installed.version;
      } else if (!existsSync(this.binPath())) {
        this.state.enabled = false;
        this.fail("binary not installed");
        return;
      }

      // Derived projections + both isolated managed homes from the shared config.
      await writeProjections(this.daemonDir, this.secrets, this.state);
      const sysDir = this.resolveSystemClaudeDir();
      await seedHome(this.daemonDir, "claudex", sysDir);
      await seedHome(this.daemonDir, "claudemix", sysDir);

      this.setState("starting", []);
      await this.spawn(false);
      const probed = await this.probe();
      if (probed.ok) {
        this.becomeHealthy(probed.models);
      } else {
        this.fail("proxy down");
      }
      await this.persist();
    });
  }

  /** Source dir `seedHome` copies shared Claude config from. */
  private resolveSystemClaudeDir(): string {
    if (this.adapters.systemClaudeDir) return this.adapters.systemClaudeDir();
    return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  }

  /** Force-gated stop. Refuses while daemon-managed sessions are live unless forced. */
  disable(force: boolean): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.transition(async () => {
      const live = this.adapters.liveDependentSessionCount();
      if (!force && live > 0) {
        return { ok: false, affectedSessions: live };
      }
      await this.killProxy();
      this.errorLatched = false;
      this.external = false;
      this.state.enabled = false;
      this.setState("off", []);
      this.applyRegistryCoupling();
      await this.persist();
      return { ok: true, affectedSessions: force ? live : 0 };
    });
  }

  /**
   * Change default/background model. A change needing a proxy restart is refused
   * while sessions are live unless forced (disclosure alone is not quiescence).
   */
  setConfig(
    cfg: { defaultModel?: string; backgroundModel?: string },
    force: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.transition(async () => {
      const changesDefault = cfg.defaultModel !== undefined && cfg.defaultModel !== this.state.defaultModel;
      const changesBackground =
        cfg.backgroundModel !== undefined && cfg.backgroundModel !== this.state.backgroundModel;
      const needsRestart = (changesDefault || changesBackground) && this.st !== "off";
      const live = this.adapters.liveDependentSessionCount();
      if (needsRestart && !force && live > 0) {
        return { ok: false, affectedSessions: live };
      }
      if (cfg.defaultModel !== undefined) this.state.defaultModel = cfg.defaultModel;
      if (cfg.backgroundModel !== undefined) this.state.backgroundModel = cfg.backgroundModel;
      if (this.secrets && this.state.enabled) {
        await writeProjections(this.daemonDir, this.secrets, this.state);
        if (needsRestart) {
          this.setState("starting", []);
          await this.spawn(true);
          const probed = await this.probe();
          if (probed.ok) this.becomeHealthy(probed.models);
          else this.fail("proxy down");
        } else {
          this.setState(this.st, this.reasons);
        }
      }
      await this.persist();
      return { ok: true, affectedSessions: force ? live : 0 };
    });
  }

  /**
   * Resolve the effective model (request wins over the configured default) and
   * verify it against a fresh, time-bounded probe. Not serialized through the
   * transition queue — it is a read-only check that must run concurrently.
   */
  async validateModel(_entryId: string, model?: string): Promise<ValidateResult> {
    const effectiveModel = model ?? this.state.defaultModel;
    if (!MODEL_NAME_RE.test(effectiveModel)) {
      return { ok: false, error: `invalid model name "${effectiveModel}"` };
    }
    if (!this.secrets) {
      const loaded = await loadOrInitSecrets(this.daemonDir);
      if (loaded.state !== "corrupt") this.secrets = loaded.secrets;
    }
    const probed = await this.probeBounded(VALIDATE_PROBE_TIMEOUT_MS);
    if (!probed.ok) {
      return { ok: false, error: "proxy unavailable — could not verify the model" };
    }
    const models = probed.models ?? [];
    if (!models.includes(effectiveModel)) {
      return { ok: false, error: `model "${effectiveModel}" is not offered by any configured provider` };
    }
    return { ok: true, effectiveModel };
  }

  /** Re-evaluate the persistence-lost respawn window when the session set changes. */
  handleSessionSetChanged(): void {
    if (!this.external) return;
    if (this.adapters.liveDependentSessionCount() > 0) return;
    void this.transition(async () => {
      if (!this.external || this.adapters.liveDependentSessionCount() > 0) return;
      this.setState("starting", []);
      await this.spawn(true);
      const probed = await this.probe();
      if (probed.ok) {
        this.external = false;
        this.becomeHealthy(probed.models);
      } else {
        this.fail("proxy down");
      }
      await this.persist();
    });
  }

  /**
   * Runtime crash supervision (spec §1): when a health probe finds an owned-but-dead
   * proxy, respawn with bounded backoff; after {@link MAX_RESPAWNS} failures latch
   * `error` and emit exactly one crash notification. Driven by the daemon's poll.
   */
  checkHealth(): Promise<void> {
    return this.transition(async () => {
      if (this.errorLatched) return;
      if (this.st !== "healthy" && this.st !== "degraded") return;
      const probed = await this.probe();
      if (probed.ok) {
        this.becomeHealthy(probed.models);
        await this.persist();
        return;
      }
      if (this.adapters.now() < this.nextRespawnAt) return; // still backing off
      this.respawnAttempts++;
      await this.spawn(true);
      this.nextRespawnAt = this.adapters.now() + this.backoffMs(this.respawnAttempts);
      const reprobed = await this.probe();
      if (reprobed.ok) {
        this.becomeHealthy(reprobed.models);
        await this.persist();
        return;
      }
      if (this.respawnAttempts >= MAX_RESPAWNS) {
        this.errorLatched = true;
        this.setState("error", ["proxy down"]);
        this.applyRegistryCoupling();
        this.broadcaster.publish("cliproxy", "cliproxy.crashed", {
          reason: "proxy down",
          respawnAttempts: this.respawnAttempts
        });
        await this.persist();
      }
    });
  }

  // --- internals -----------------------------------------------------------

  /**
   * Ownership-verified boot adoption, authenticated probe FIRST (spec §1):
   *   (1) our tmux session exists → probe → adopt if healthy, else restart.
   *   (2) no owned session but the port answers → probe:
   *         key accepted → our own out-of-tmux proxy → persistence-lost (warn-only);
   *         key rejected → foreign listener → error "port conflict" (never kill/adopt).
   *   (3) nothing on the port → spawn and poll readiness.
   */
  private async bootAdopt(): Promise<void> {
    const name = SERVICE_SESSION_NAME;
    if (this.adapters.tmux && (await this.adapters.tmux.hasServiceSession(name))) {
      const probed = await this.probe();
      if (probed.ok) {
        this.becomeHealthy(probed.models);
        await this.persist();
        return;
      }
      this.setState("starting", []);
      await this.spawn(true);
      const reprobed = await this.probe();
      if (reprobed.ok) this.becomeHealthy(reprobed.models);
      else this.fail("proxy down");
      await this.persist();
      return;
    }

    const probed = await this.probe();
    if (probed.ok) {
      this.external = true;
      this.setState("degraded", ["persistence-lost"]);
      this.applyRegistryCoupling();
      await this.persist();
      return;
    }
    if (probed.reachable) {
      this.setState("error", ["port conflict"]);
      this.applyRegistryCoupling();
      await this.persist();
      return;
    }

    this.setState("starting", []);
    await this.spawn(false);
    const spawned = await this.probe();
    if (spawned.ok) this.becomeHealthy(spawned.models);
    else this.fail("proxy down");
    await this.persist();
  }

  private async spawn(killFirst: boolean): Promise<void> {
    const bin = this.binPath();
    if (this.adapters.tmux) {
      if (killFirst) await this.adapters.tmux.killServiceSession(SERVICE_SESSION_NAME).catch(() => undefined);
      await this.adapters.tmux.newServiceSession({
        name: SERVICE_SESSION_NAME,
        cwd: cliproxyDir(this.daemonDir),
        env: {},
        bin,
        args: []
      });
    } else {
      this.directHandle?.kill();
      this.directHandle = this.adapters.spawnDirect(bin, []);
    }
  }

  private async killProxy(): Promise<void> {
    if (this.adapters.tmux) {
      await this.adapters.tmux.killServiceSession(SERVICE_SESSION_NAME).catch(() => undefined);
    } else {
      this.directHandle?.kill();
      this.directHandle = null;
    }
  }

  private async probe(): Promise<ProbeResult> {
    if (!this.secrets) return { ok: false, reachable: false };
    return this.adapters.probe(this.state.port, this.secrets.apiKey);
  }

  private probeBounded(ms: number): Promise<ProbeResult> {
    return Promise.race<ProbeResult>([
      this.probe(),
      new Promise<ProbeResult>((resolve) => {
        setTimeout(() => resolve({ ok: false }), ms);
      })
    ]);
  }

  private becomeHealthy(models?: string[]): void {
    this.respawnAttempts = 0;
    this.nextRespawnAt = 0;
    this.external = false;
    this.errorLatched = false;
    if (models) {
      this.state.modelCatalog = { models, asOf: new Date(this.adapters.now()).toISOString() };
    }
    this.setState("healthy", []);
    this.applyRegistryCoupling();
  }

  /** Latch `error` with a single reason and disable the dependent launchers. */
  private fail(reason: string): void {
    this.errorLatched = true;
    this.setState("error", [reason]);
    this.applyRegistryCoupling();
  }

  private setState(st: CliProxyStatus["state"], reasons: string[], detail: string | null = null): void {
    this.st = st;
    this.reasons = reasons;
    this.detail = detail;
    this.broadcaster.publish("cliproxy", "cliproxy.changed", this.status());
  }

  /**
   * Reason→consequence coupling (spec §1): a launchable proxy (`healthy`, or a
   * warn-only `degraded`) enables the dependent entries; otherwise they are
   * visible-but-disabled with a "proxy down" reason.
   */
  private applyRegistryCoupling(): void {
    const launchable = this.st === "healthy" || this.st === "degraded";
    for (const id of DEPENDENT_ENTRY_IDS) {
      if (launchable) {
        this.registry.setRuntimeState(id, { enabled: true });
      } else {
        this.registry.setRuntimeState(id, { enabled: false, disabledReason: "proxy down" });
      }
    }
  }

  private backoffMs(attempt: number): number {
    return BACKOFF_BASE_MS * 2 ** (attempt - 1);
  }

  private binPath(): string {
    return join(cliproxyDir(this.daemonDir), "bin", "cli-proxy-api");
  }

  private async loadState(): Promise<CliProxyState> {
    try {
      const raw = await readFile(cliproxyStateFile(this.daemonDir), "utf8");
      return parseCliProxyState(JSON.parse(raw));
    } catch {
      return createDefaultCliProxyState();
    }
  }

  private async persist(): Promise<void> {
    await mkdir(cliproxyDir(this.daemonDir), { recursive: true });
    await writeFile(cliproxyStateFile(this.daemonDir), JSON.stringify(this.state, null, 2), "utf8");
  }

  /** Chain `fn` onto the serialized transition queue and return its result. */
  private transition<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}
