import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliProxyProviderId, CliProxyProviderStatus, CliProxyStatus } from "@orquester/api";
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
import { loadOrInitSecrets, setOpenRouterKey } from "./cliproxy-secrets.ts";
import {
  accessTokenFreshMs,
  accountPrefix,
  claudeStorageFromCredentials,
  codexStorageFromAuthJson
} from "./cliproxy-seed.ts";
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
/**
 * A credential must have at least this much life left to be seeded. Seeding a
 * near-expired token would make the proxy immediately refresh it — the very
 * dual-refresher rotation the owner rule (spec §4) exists to avoid. Refuse
 * instead and ask the user to refresh the account in Orquester first.
 */
const SEED_FRESH_THRESHOLD_MS = 5 * 60 * 1000;

type ProbeResult = { ok: boolean; reachable?: boolean; models?: string[] };

/** A managed account seeded into the proxy's `auth/` dir (proxy-owned mapping). */
interface SeededAccount {
  id: string;
  provider: CliProxyProviderId;
  label: string;
  email?: string;
  state: "ok" | "expired";
  lastVerifiedAt: string | null;
}

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
  /**
   * Restore the previously-installed proxy binary from `bin.prev/` (production:
   * `rollbackBinary`). Returns true when a prior binary existed and was restored.
   * `enable()` uses it as a last resort when a freshly-installed binary never
   * probes healthy. Absent → no rollback attempted.
   */
  rollback?(): Promise<boolean>;
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

  /**
   * Accounts seeded into `auth/`, keyed by accountId — the in-memory proxy-owned
   * mapping (spec §4). Drives `status().accounts` and per-provider registry
   * coupling. Kept in-memory this phase; a restart rebuilds provider availability
   * from a fresh probe, and accounts are re-seeded idempotently by the UI.
   */
  private readonly seededAccounts = new Map<string, SeededAccount>();

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
      providers: this.providerStatuses(),
      accounts: [...this.seededAccounts.values()].map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        ...(a.email ? { email: a.email } : {})
      })),
      activeSessionCount: this.adapters.liveDependentSessionCount(),
      testedClaudeCliVersion: this.state.testedClaudeCliVersion
    };
  }

  /** Load persisted state + secrets, then run boot adoption (spec §1). */
  init(): Promise<void> {
    return this.transition(async () => {
      this.state = await this.loadState();
      // Rebuild the in-memory proxy-owned account map from persisted state so a
      // restart keeps provider availability (and the launcher coupling) without a
      // re-seed. Persisted records carry no token freshness, so they rehydrate as
      // "ok"; a stale credential re-degrades on the next seed/verify.
      this.rebuildSeededAccounts();
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
      let probed = await this.probe();
      // A freshly-installed binary that never probes healthy: if a previous binary
      // survives in bin.prev/, roll back and respawn once before latching error.
      // `rollback()` returns false when there is nothing to roll back to.
      if (!probed.ok && this.adapters.rollback) {
        const rolled = await this.adapters.rollback();
        if (rolled) {
          await this.spawn(true);
          probed = await this.probe();
          if (probed.ok) {
            this.becomeHealthy(probed.models);
            this.setState("healthy", ["rolled back to previous binary"]);
            await this.persist();
            return;
          }
        }
      }
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
    cfg: { defaultModel?: string; backgroundModel?: string; claudeDefaultModel?: string },
    force: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.transition(async () => {
      const changesDefault = cfg.defaultModel !== undefined && cfg.defaultModel !== this.state.defaultModel;
      const changesBackground =
        cfg.backgroundModel !== undefined && cfg.backgroundModel !== this.state.backgroundModel;
      // claudeDefaultModel only feeds validateModel's default resolution — it is not
      // written into config.yaml/env projections, so changing it needs no restart.
      const needsRestart = (changesDefault || changesBackground) && this.st !== "off";
      const live = this.adapters.liveDependentSessionCount();
      if (needsRestart && !force && live > 0) {
        return { ok: false, affectedSessions: live };
      }
      if (cfg.defaultModel !== undefined) this.state.defaultModel = cfg.defaultModel;
      if (cfg.backgroundModel !== undefined) this.state.backgroundModel = cfg.backgroundModel;
      if (cfg.claudeDefaultModel !== undefined) this.state.claudeDefaultModel = cfg.claudeDefaultModel;
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
   * Set the OpenRouter API key, owning the whole projection+restart cycle. The key
   * lives in config.yaml (a projection the proxy reads only at startup), so a
   * change is restart-gated exactly like {@link setConfig}: refused while
   * daemon-managed sessions are live unless forced. On proceed it persists the key
   * via the secrets store, updates the in-memory secrets, re-projects config.yaml,
   * restarts the proxy (kill + spawn + probe), recouples the launchers to the
   * now-available openrouter provider, and broadcasts + persists.
   */
  setOpenRouterKey(key: string, force: boolean): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.transition(async () => {
      const needsRestart = this.st !== "off";
      const live = this.adapters.liveDependentSessionCount();
      if (needsRestart && !force && live > 0) {
        return { ok: false, affectedSessions: live };
      }
      this.secrets = await setOpenRouterKey(this.daemonDir, key);
      if (this.state.enabled) {
        await writeProjections(this.daemonDir, this.secrets, this.state);
        if (needsRestart) {
          this.setState("starting", []);
          await this.spawn(true);
          const probed = await this.probe();
          if (probed.ok) this.becomeHealthy(probed.models);
          else this.fail("proxy down");
        }
      }
      this.applyRegistryCoupling();
      this.broadcaster.publish("cliproxy", "cliproxy.changed", this.status());
      await this.persist();
      return { ok: true, affectedSessions: force ? live : 0 };
    });
  }

  /**
   * Seed a managed account's credential into the proxy's `auth/` dir (spec §4 —
   * the sole credential path, no device-auth flow). Reads the managed credential
   * via the injected `read`, converts it to CLIProxyAPI's auth-file schema
   * (Task 2), stamps the deterministic per-account routing `prefix`, and writes
   * it 0600. **Freshness guard:** a token with less than
   * {@link SEED_FRESH_THRESHOLD_MS} of life is refused with `expired` rather than
   * seeded, so the proxy never immediately refreshes it and desyncs the managed
   * account's rotating refresh token (dual-refresher rule). The proxy
   * hot-discovers the new file — no restart. The caller marks the account
   * proxy-owned via the accounts service (Task 3).
   */
  seedProvider(
    req: { provider: "codex" | "claude"; accountId: string },
    read: (provider: "codex" | "claude", accountId: string) => Promise<unknown>
  ): Promise<CliProxyProviderStatus> {
    return this.transition(async () => {
      const cred = await read(req.provider, req.accountId);
      const { file, storage } =
        req.provider === "codex"
          ? codexStorageFromAuthJson(cred, req.accountId)
          : claudeStorageFromCredentials(cred, req.accountId);

      // Freshness guard — refuse a near-expired token to avoid a proxy refresh.
      if (accessTokenFreshMs(storage as { expired: string }) <= SEED_FRESH_THRESHOLD_MS) {
        return { provider: req.provider, state: "expired", lastVerifiedAt: null };
      }

      const authDir = join(cliproxyDir(this.daemonDir), "auth");
      await mkdir(authDir, { recursive: true, mode: 0o700 });
      await writeFile(join(authDir, file), JSON.stringify(storage, null, 2), { mode: 0o600 });

      const email =
        typeof (storage as Record<string, unknown>).email === "string" &&
        (storage as Record<string, unknown>).email
          ? String((storage as Record<string, unknown>).email)
          : undefined;
      const lastVerifiedAt = new Date(this.adapters.now()).toISOString();
      const label = email ?? req.accountId;
      this.seededAccounts.set(req.accountId, {
        id: req.accountId,
        provider: req.provider,
        label,
        email,
        state: "ok",
        lastVerifiedAt
      });
      // Persist the routing-relevant projection (no token material) so a restart
      // rebuilds this account's provider availability without a re-seed (spec §4).
      const persisted = { provider: req.provider, accountId: req.accountId, label, prefix: accountPrefix(req.accountId) };
      const existing = this.state.seededAccounts.findIndex((a) => a.accountId === req.accountId);
      if (existing >= 0) this.state.seededAccounts[existing] = persisted;
      else this.state.seededAccounts.push(persisted);

      // Hot-discovered: re-probe to refresh the catalog, then recouple launchers
      // to the now-available provider and rebroadcast the enriched status.
      const probed = await this.probe();
      if (probed.ok && probed.models) {
        this.state.modelCatalog = { models: probed.models, asOf: lastVerifiedAt };
      }
      this.applyRegistryCoupling();
      this.broadcaster.publish("cliproxy", "cliproxy.changed", this.status());
      await this.persist();
      return { provider: req.provider, state: "ok", lastVerifiedAt };
    });
  }

  /**
   * Resolve the effective model (request wins over the configured default) and
   * verify it against a fresh, time-bounded probe. Not serialized through the
   * transition queue — it is a read-only check that must run concurrently.
   */
  async validateModel(entryId: string, model?: string): Promise<ValidateResult> {
    // claudemix (the Claude Fable main loop) resolves its OWN default when a launch
    // names none — never `defaultModel`, which is claudex's Codex/GPT default. A
    // Codex-seeded setup would otherwise route claudemix to GPT (or a prefixed
    // gpt model) and the UI never sends a model for claudemix.
    const configuredDefault =
      entryId === "claudemix" ? this.state.claudeDefaultModel : this.state.defaultModel;
    const effectiveModel = model ?? configuredDefault;
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

  /**
   * Launch-time pre-flight (spec §8.4): partition the models a claudemix session
   * will reference into those the live catalog offers (`ok`) and those it does not
   * (`missing`). Best-effort by design — a workflow's `agent({model})` strings are
   * dynamic, so this is a catalog snapshot the create path attaches as a warning,
   * not a hard gate on every future call. An unreachable/hung proxy (bounded probe)
   * confirms nothing, so every referenced model reports `missing`.
   */
  async preflightModels(models: string[]): Promise<{ ok: string[]; missing: string[] }> {
    if (models.length === 0) return { ok: [], missing: [] };
    if (!this.secrets) {
      const loaded = await loadOrInitSecrets(this.daemonDir);
      if (loaded.state !== "corrupt") this.secrets = loaded.secrets;
    }
    const probed = await this.probeBounded(VALIDATE_PROBE_TIMEOUT_MS);
    const catalog = new Set(probed.ok ? probed.models ?? [] : []);
    const ok: string[] = [];
    const missing: string[] = [];
    for (const model of models) {
      (catalog.has(model) ? ok : missing).push(model);
    }
    return { ok, missing };
  }

  /** Re-evaluate the persistence-lost respawn window when the session set changes. */
  handleSessionSetChanged(): void {
    if (!this.external) return;
    // No-tmux mode legitimately stays external — a direct respawn is no more
    // durable, so there is nothing to re-parent into.
    if (!this.adapters.tmux) return;
    if (this.adapters.liveDependentSessionCount() > 0) return;
    void this.transition(async () => {
      if (!this.external) return;
      await this.reparentIfDrained();
      await this.persist();
    });
  }

  /**
   * Re-parent a persistence-lost (external, out-of-tmux) proxy back under tmux.
   * Runs only when tmux is available (no-tmux mode legitimately stays external)
   * and no dependent session is still bound to the surviving proxy. Kills the
   * external proxy, respawns under tmux, and clears `external` ONLY after the
   * tmux-hosted spawn probes healthy — a probe-healthy but durability-degraded
   * proxy stays `persistence-lost` until then, never silently relabeled healthy.
   */
  private async reparentIfDrained(): Promise<void> {
    if (!this.adapters.tmux) return;
    if (this.adapters.liveDependentSessionCount() > 0) return;
    // Kill only what we actually own: the tmux service session (a no-op for a
    // truly external, out-of-tmux survivor) and a direct child if one exists.
    await this.adapters.tmux.killServiceSession(SERVICE_SESSION_NAME).catch(() => undefined);
    if (this.directHandle) {
      this.directHandle.kill();
      this.directHandle = null;
    }
    // Re-probe: if the port STILL answers with our key, the survivor is an external
    // proxy we hold no handle to and cannot kill. Spawning now would collide on the
    // port and latch error — stay persistence-lost (warn-only) instead.
    const still = await this.probe();
    if (still.ok) {
      this.external = true;
      this.setState("degraded", ["persistence-lost"]);
      this.applyRegistryCoupling();
      return;
    }
    // Port is free → safe to spawn a fresh tmux-hosted proxy and re-parent.
    this.setState("starting", []);
    await this.spawn(false);
    const probed = await this.probe();
    if (probed.ok) {
      this.external = false;
      this.becomeHealthy(probed.models);
    } else {
      this.fail("proxy down");
    }
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
        // A persistence-lost (external, out-of-tmux) proxy is probe-healthy but
        // durability-degraded: re-parent it under tmux once sessions drain rather
        // than relabeling it healthy in place. Until then it stays degraded.
        if (this.external) await this.reparentIfDrained();
        else this.becomeHealthy(probed.models);
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
   * Reason→consequence coupling (spec §1 + §4). A down proxy disables both
   * entries ("proxy down"). A launchable proxy with no seeded providers yet stays
   * optimistic (both enabled — nothing to gate on). Once credentials exist, each
   * entry is gated on its required provider: `claudex` needs codex OR openrouter,
   * `claudemix` needs claude; a missing/expired required provider leaves the entry
   * visible-but-disabled with an explanatory reason.
   */
  private applyRegistryCoupling(): void {
    const launchable = this.st === "healthy" || this.st === "degraded";
    if (!launchable) {
      for (const id of DEPENDENT_ENTRY_IDS) {
        this.registry.setRuntimeState(id, { enabled: false, disabledReason: "proxy down" });
      }
      return;
    }
    if (!this.hasProviderInfo()) {
      for (const id of DEPENDENT_ENTRY_IDS) this.registry.setRuntimeState(id, { enabled: true });
      return;
    }
    const codexOk = this.providerState("codex") === "ok";
    const claudeOk = this.providerState("claude") === "ok";
    const openrouterOk = this.providerState("openrouter") === "ok";
    if (codexOk || openrouterOk) {
      this.registry.setRuntimeState("claudex", { enabled: true });
    } else {
      this.registry.setRuntimeState("claudex", {
        enabled: false,
        disabledReason: "no codex or openrouter credential"
      });
    }
    if (claudeOk) {
      this.registry.setRuntimeState("claudemix", { enabled: true });
    } else {
      this.registry.setRuntimeState("claudemix", {
        enabled: false,
        disabledReason: "no claude credential"
      });
    }
  }

  /** Rehydrate the in-memory account map from persisted `state.seededAccounts`. */
  private rebuildSeededAccounts(): void {
    this.seededAccounts.clear();
    for (const a of this.state.seededAccounts) {
      this.seededAccounts.set(a.accountId, {
        id: a.accountId,
        provider: a.provider,
        label: a.label,
        state: "ok",
        lastVerifiedAt: null
      });
    }
  }

  /** Whether any provider knowledge exists yet (seeded account or OpenRouter key). */
  private hasProviderInfo(): boolean {
    return this.seededAccounts.size > 0 || Boolean(this.secrets?.openRouterKey);
  }

  /**
   * Aggregate per-provider state: openrouter is `ok` when a key is configured;
   * codex/claude are `missing` with no seeded account, `expired` if any seeded
   * credential is stale (probes are per-credential, so one bad account degrades
   * the whole provider — spec §4), else `ok`.
   */
  private providerState(provider: CliProxyProviderId): "ok" | "missing" | "expired" {
    if (provider === "openrouter") return this.secrets?.openRouterKey ? "ok" : "missing";
    const accts = [...this.seededAccounts.values()].filter((a) => a.provider === provider);
    if (accts.length === 0) return "missing";
    if (accts.some((a) => a.state === "expired")) return "expired";
    return "ok";
  }

  /** The three brokered providers with their aggregate state + last-verified time. */
  private providerStatuses(): CliProxyProviderStatus[] {
    const providers: CliProxyProviderId[] = ["codex", "claude", "openrouter"];
    return providers.map((provider) => {
      const verified = [...this.seededAccounts.values()]
        .filter((a) => a.provider === provider)
        .map((a) => a.lastVerifiedAt)
        .filter((t): t is string => t !== null)
        .sort();
      return {
        provider,
        state: this.providerState(provider),
        lastVerifiedAt: verified.length > 0 ? verified[verified.length - 1] : null
      };
    });
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
