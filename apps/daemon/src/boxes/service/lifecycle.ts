/**
 * The box lifecycle (spec §8.2, §9.1): create → connect → setup → ready, and destroy.
 *
 * - The record is written (state `provisioning`, its `orq-<id>` instance name) before any provider
 *   call, so a crash mid-create leaves something the reconciler can match.
 * - Setup runs in the background, one step at a time; every step's state is persisted (and so
 *   broadcast) as it changes, and its progress goes to the box's setup log. A temporary box runs
 *   create, connect and ready only.
 * - Failing to create, connect or make the host paths tears the box down (`provisioning-failed`);
 *   any later step fails on its own and the box still becomes ready, its `stateReason` naming the
 *   step. A pipeline resumed after a restart skips the steps already finished.
 * - Destroy aborts setup, asks the provider to destroy the instance and waits until the provider
 *   reports it gone; anything less leaves `destroy-failed` (the box may still bill) and throws.
 */

import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  hostToBoxPath,
  type BoxDestroyedReason,
  type BoxKind,
  type BoxProviderId,
  type BoxPurpose,
  type BoxSetupStep,
  type BoxSetupStepId,
  type BoxSetupStepState
} from "@orquester/api";
import { agentAccountsDir, agentChatThreadsDir, sessionProfilePreparedRootDir, type StoredBox } from "@orquester/config";

import type {
  BoxAgentId,
  BoxConfigSync,
  BoxConnection,
  BoxHub,
  BoxProviderAdapter,
  BoxProviderRegistry,
  BoxToolingProvisioner,
  BuildBootstrap,
  ProviderCredentials,
  ProviderInstanceRef,
  TailscaleKeys
} from "../contracts.ts";
import { cloneArgs, isFullSha, isMissingRemoteRef, mayBeAbbreviatedSha } from "../../workflows/git-remote/index.ts";
import { runBoxCommand, type BoxCommandResult, type BoxCommandSpec, type BoxSetupLog } from "./box-exec.ts";
import { BoxError, errorLine, isAbortError } from "./errors.ts";
import { boxGitConfigCommands, boxKnownHostsPath, cloneUrlHost } from "./git-setup.ts";
import type { BoxStore } from "./store.ts";
import { initialStoredSetup, SETUP_STEP_LABELS } from "./summary.ts";
import { bubblewrapScript, planToolchain, TOOLCHAIN_PROBE_FILES, TOOLCHAIN_READ_FILES } from "./toolchain.ts";

export type StoredBoxProject = NonNullable<StoredBox["project"]>;

export interface ManagedAgentHome {
  agent: BoxAgentId;
  accountId: string;
  /** Host path of the account home. */
  home: string;
}

/** What setup needs from git hosting on the host. Never a token: the box asks the host per request. */
export interface BoxGitAccess {
  /** The `user.name`/`user.email` of a connected git hosting account, or null when it is gone. */
  identity(accountId: string): Promise<{ name: string; email: string } | null>;
  /** known_hosts lines the box should trust for `host` (the daemon's pinned keys and its own entries for the host). */
  knownHosts(host: string, port: number | null): Promise<string>;
}

/** The route a new box is told to dial (spec §6). */
export interface ConnectRoute {
  mode: "public-url" | "tailscale";
  /** The origin `orq-agent` downloads itself from and connects to. */
  daemonUrl: string;
  /** Set in `tailscale` mode: mints the box's auth key. */
  tailscale: TailscaleKeys | null;
}

export interface BoxConnectivity {
  /** Throws `BOX_CONNECTION_NOT_CONFIGURED` when boxes have no route to this daemon. */
  route(): ConnectRoute;
  /** The credentials the provider's adapter takes, or null when it is not connected. */
  credentials(provider: BoxProviderId): Promise<ProviderCredentials | null>;
  /** For removing a destroyed box's tailnet node; null without Tailscale credentials. */
  tailscaleKeys(): TailscaleKeys | null;
}

export interface BoxClock {
  now(): number;
  /** Resolves after `ms` (a provider poll's backoff); rejects when `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

export const systemClock: BoxClock = {
  now: () => Date.now(),
  wait: (ms, signal) => delay(ms, undefined, { signal })
};

export interface BoxLifecycleDeps {
  baseDir: string;
  store: BoxStore;
  providers: BoxProviderRegistry;
  hub: BoxHub;
  buildBootstrap: BuildBootstrap;
  connectivity: BoxConnectivity;
  configSync?: BoxConfigSync;
  tooling?: BoxToolingProvisioner;
  git: BoxGitAccess;
  managedAgentHomes: () => ManagedAgentHome[];
  setupLog: BoxSetupLog;
  clock: BoxClock;
  fetch?: typeof fetch;
  logger: Pick<Console, "warn" | "error" | "log">;
  /** A provider call failed: the reconciler takes a look at that provider soon. */
  onProviderError(provider: string): void;
  /**
   * The `orq-agent` builds boxes download (`BoxAgentBuilds.current`): null means there are none
   * (no Go toolchain to build them), and nothing billable is created. Absent: not checked.
   */
  agentBuilds?: { current(): Promise<{ version: string } | null> };
}

export interface CreateBoxSpec {
  purpose: BoxPurpose;
  kind: BoxKind;
  provider: BoxProviderId;
  size: string;
  sizeLabel: string;
  region: string;
  regionLabel: string;
  image: string | null;
  /** Recorded at creation; the provider's own figure replaces it when create reports one. */
  hourlyUsd: number | null;
  /** Temporary boxes and macOS: the time limit. */
  lifetimeMinutes: number | null;
  project: StoredBoxProject | null;
  threadId: string | null;
  purposeNote: string | null;
}

/** Providers whose boxes are containers: `orq-agent` runs in the foreground, tailscaled in userspace mode. */
export const CONTAINER_PROVIDERS: ReadonlySet<string> = new Set(["vastai", "runpod", "jarvislabs", "fly", "morph"]);

/** How long `orq-agent` may take to connect after create, per kind (images, GPU drivers, Windows first boot). */
export const CONNECT_DEADLINE_MS: Readonly<Record<BoxKind, number>> = {
  linux: 10 * 60_000,
  "linux-gpu": 20 * 60_000,
  windows: 20 * 60_000,
  "windows-gpu": 25 * 60_000,
  macos: 15 * 60_000
};

/** How long a destroy waits for the provider to report the instance gone. */
export const DESTROY_CONFIRM_MS = 5 * 60_000;
const DESTROY_POLL_MS = [2_000, 4_000, 8_000, 15_000];
const CLONE_TIMEOUT_MS = 30 * 60_000;
const TOOLCHAIN_COMMAND_TIMEOUT_MS = 30 * 60_000;
const FILE_READ_MAX = 64 * 1024;

/** Fields kept on a record while a destroy is in flight, so a destroy interrupted by a restart resumes with its reason. */
export const PENDING_DESTROY_REASON = "pendingDestroyReason";
const PENDING_DESTROY_MESSAGE = "pendingDestroyMessage";

export function destroyedReasonText(reason: BoxDestroyedReason, providerLabel: string): string {
  switch (reason) {
    case "deleted":
      return "Destroyed with its project.";
    case "agent":
      return "Destroyed by the agent.";
    case "time-limit":
      return "Its time limit was reached.";
    case "chat-closed":
      return "Its chat was closed.";
    case "provider-gone":
      return `Gone at ${providerLabel} (destroyed outside Orquester).`;
    case "provider-error":
      return `${providerLabel} reported the box failed.`;
    case "provisioning-failed":
      return "Setup failed; the box was torn down.";
    case "orphan":
      return "Cleaned up: Orquester had no live record of it.";
  }
}

/** An OpenSSH `ssh-ed25519` public key whose private half is discarded at once (providers that insist on one). */
export function throwawaySshPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const part = (data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
  };
  const blob = Buffer.concat([part(Buffer.from("ssh-ed25519")), part(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")} orquester-box`;
}

/** A Windows administrator password meeting the usual complexity rules (all four classes, 24 chars). */
export function generateWindowsPassword(): string {
  const classes = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!#%+-=?@^_"];
  const all = classes.join("");
  const chars = classes.map((set) => set[randomInt(set.length)]!);
  while (chars.length < 24) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}

export function newBoxId(): string {
  return randomBytes(6).toString("hex");
}

class SetupStepError extends Error {}

type StepOutcome = { state: "done" | "skipped"; message?: string | null };

interface ProvisioningRun {
  abort: AbortController;
  /** The setup pipeline alone (a teardown after it is not part of it). */
  pipeline: Promise<string | null>;
  /** Pipeline, then teardown when it failed. */
  done: Promise<void>;
}

async function readText(stream: Readable, max: number): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.length > max) {
      stream.destroy();
      return text.slice(0, max);
    }
  }
  return text;
}

export class BoxLifecycle {
  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly destroys = new Map<string, Promise<StoredBox>>();
  private readonly inflight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(private readonly deps: BoxLifecycleDeps) {}

  /** Setup or a destroy of the box is running in this process. */
  busy(boxId: string): boolean {
    return this.runs.has(boxId) || this.destroys.has(boxId);
  }

  /**
   * Write the record and start setup in the background. Throws (nothing created) when there is no
   * route to this daemon or the record cannot be written.
   */
  async create(spec: CreateBoxSpec): Promise<StoredBox> {
    const route = this.deps.connectivity.route();
    // A box that cannot download orq-agent never connects: refuse before anything is billed.
    if (this.deps.agentBuilds && !(await this.deps.agentBuilds.current().catch(() => null))) {
      throw new BoxError(
        503,
        "BOXES_UNAVAILABLE",
        "orq-agent builds are unavailable on this daemon: install Go 1.24 or later on the host (or deploy prebuilt builds) and restart the daemon."
      );
    }
    let id = newBoxId();
    while (this.deps.store.get(id)) id = newBoxId();
    const now = new Date(this.deps.clock.now());
    const deadlineAt =
      spec.lifetimeMinutes !== null ? new Date(now.getTime() + spec.lifetimeMinutes * 60_000).toISOString() : null;
    const record: StoredBox = {
      id,
      purpose: spec.purpose,
      kind: spec.kind,
      provider: spec.provider,
      region: spec.region,
      regionLabel: spec.regionLabel,
      size: spec.size,
      sizeLabel: spec.sizeLabel,
      image: spec.image,
      name: `orq-${id}`,
      os: null,
      arch: null,
      libc: null,
      hourlyUsd: spec.hourlyUsd,
      createdAt: now.toISOString(),
      readyAt: null,
      deadlineAt,
      destroyedAt: null,
      lastSeenAt: null,
      state: "provisioning",
      stateReason: "Setting up…",
      destroyedReason: null,
      project: spec.project,
      threadId: spec.threadId,
      purposeNote: spec.purposeNote,
      connectRoute: route.mode,
      setup: initialStoredSetup(spec.purpose),
      ...(spec.lifetimeMinutes !== null ? { lifetimeMinutes: spec.lifetimeMinutes } : {})
    };
    const stored = await this.deps.store.insert(record);
    void this.deps.setupLog.append(id, `Box ${record.name}: ${spec.kind} at ${spec.provider}, ${spec.sizeLabel} in ${spec.regionLabel}.`);
    this.startProvisioning(id);
    return stored;
  }

  /** Continue a `provisioning` record's setup (a restart interrupted it), attaching the instance the reconciler found. */
  async resume(boxId: string, ref?: ProviderInstanceRef): Promise<void> {
    if (this.busy(boxId) || this.stopped) return;
    if (ref) await this.deps.store.update(boxId, (record) => void (record.providerRef = ref));
    void this.deps.setupLog.append(boxId, "Resuming setup after a restart.");
    this.startProvisioning(boxId);
  }

  /** Resolves once the box's setup (and a teardown after a failure) has finished. */
  async whenProvisioned(boxId: string): Promise<void> {
    await this.runs.get(boxId)?.done;
  }

  /** Every setup and destroy started so far has finished (tests). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /** Abort running setups (their records stay `provisioning`; the next start resumes them). */
  stop(): void {
    this.stopped = true;
    for (const run of this.runs.values()) run.abort.abort();
  }

  /**
   * Destroy the box and wait for the provider to confirm it is gone. Concurrent calls share one
   * destroy. Throws `BOX_PROVIDER_ERROR` (state `destroy-failed`) when that cannot be confirmed.
   */
  destroy(boxId: string, reason: BoxDestroyedReason, message?: string | null): Promise<StoredBox> {
    const existing = this.destroys.get(boxId);
    if (existing) return existing;
    const run = this.runDestroy(boxId, reason, message ?? null).finally(() => this.destroys.delete(boxId));
    this.destroys.set(boxId, run);
    this.track(run);
    return run;
  }

  /** The hub saw the box connect or drop. */
  async connectionChanged(boxId: string, connected: boolean): Promise<void> {
    const record = this.deps.store.get(boxId);
    if (!record || record.state === "destroyed") return;
    const at = new Date(this.deps.clock.now()).toISOString();
    await this.deps.store.update(boxId, (next) => {
      next.lastSeenAt = at;
      if (connected && next.state === "unreachable") {
        next.state = "ready";
        next.stateReason = null;
      }
    });
  }

  /** `ready` → `unreachable` (the reconciler saw it disconnected for long while the provider says it runs). */
  async markUnreachable(boxId: string): Promise<void> {
    await this.deps.store.update(boxId, (record) => {
      if (record.state !== "ready") return;
      record.state = "unreachable";
      record.stateReason = "Reconnecting…";
    });
  }

  /** The provider no longer has the instance: the box is `destroyed` without a destroy call. */
  async markGone(boxId: string, reason: BoxDestroyedReason, message: string | null): Promise<void> {
    if (this.busy(boxId)) return;
    const record = this.deps.store.get(boxId);
    if (!record || record.state === "destroyed") return;
    const label = this.deps.providers.get(record.provider as BoxProviderId)?.label ?? record.provider;
    await this.deps.hub.revoke(boxId).catch((error) => this.deps.logger.warn(`Could not revoke box ${boxId}`, errorLine(error)));
    await this.finishDestroyed(boxId, reason, message ?? destroyedReasonText(reason, label));
    void this.deps.setupLog.append(boxId, `Destroyed: ${message ?? destroyedReasonText(reason, label)}`);
  }

  // ---- provisioning ----------------------------------------------------------------------------

  private startProvisioning(boxId: string): void {
    const abort = new AbortController();
    const pipeline = this.provision(boxId, abort.signal);
    const done = pipeline
      .then(async (fatal) => {
        if (fatal === null || abort.signal.aborted) return;
        await this.destroy(boxId, "provisioning-failed", fatal).catch(() => undefined);
      })
      .finally(() => {
        if (this.runs.get(boxId)?.abort === abort) this.runs.delete(boxId);
      });
    this.runs.set(boxId, { abort, pipeline, done });
    this.track(done);
  }

  /** Runs setup; resolves the fatal failure's message (the box must be torn down), or null. */
  private async provision(boxId: string, signal: AbortSignal): Promise<string | null> {
    try {
      const initial = this.deps.store.get(boxId);
      if (!initial) return null;
      const adapter = this.deps.providers.get(initial.provider as BoxProviderId);
      if (!adapter) return `This build has no adapter for the provider "${initial.provider}".`;
      const temporary = initial.purpose === "temporary";

      if (!(await this.runStep(boxId, "create", signal, () => this.createInstance(boxId, adapter, signal)))) {
        return this.stepMessage(boxId, "create");
      }
      // Set by the connect step (a holder: assignments inside the callback are invisible to narrowing).
      const linked: { connection?: BoxConnection } = {};
      const connected = await this.runStep(boxId, "connect", signal, async (log) => {
        const record = this.require(boxId);
        const timeoutMs = CONNECT_DEADLINE_MS[record.kind as BoxKind] ?? CONNECT_DEADLINE_MS.linux;
        log(`Waiting up to ${Math.round(timeoutMs / 60_000)} min for orq-agent to connect.`);
        let connection: BoxConnection;
        try {
          connection = await this.deps.hub.waitConnected(boxId, { signal, timeoutMs });
        } catch (error) {
          if (signal.aborted) throw error;
          throw new SetupStepError(`orq-agent did not connect within ${Math.round(timeoutMs / 60_000)} min (${errorLine(error)}).`);
        }
        const sys = connection.sys;
        await this.deps.store.update(boxId, (next) => {
          next.os = sys.os;
          next.arch = sys.arch;
          next.libc = sys.libc;
          next.lastSeenAt = new Date(this.deps.clock.now()).toISOString();
        });
        linked.connection = connection;
        return { state: "done", message: `${sys.osRelease}, ${sys.arch}, orq-agent ${connection.agentVersion}` };
      });
      const link = linked.connection;
      if (!connected || !link) return this.stepMessage(boxId, "connect");

      if (!temporary) {
        if (!(await this.runStep(boxId, "paths", signal, () => this.ensurePaths(boxId, link, signal)))) {
          return this.stepMessage(boxId, "paths");
        }
        await this.runStep(boxId, "config", signal, () => this.syncConfig(boxId, signal));
        await this.runStep(boxId, "tooling", signal, async () => {
          if (!this.deps.tooling) return { state: "skipped", message: "Plugin tooling is not available in this build." };
          await this.deps.tooling.provision(boxId, signal);
          return { state: "done" };
        });
        await this.runStep(boxId, "clone", signal, (log) => this.cloneRepository(boxId, link, signal, log));
        await this.runStep(boxId, "toolchain", signal, (log) => this.installToolchain(boxId, link, signal, log));
      }

      await this.runStep(boxId, "ready", signal, async () => {
        const failed = (this.require(boxId).setup ?? []).filter((step) => step.state === "failed").map((step) => step.label);
        const at = new Date(this.deps.clock.now()).toISOString();
        await this.deps.store.update(boxId, (record) => {
          if (record.state !== "provisioning") return;
          record.state = "ready";
          record.readyAt = at;
          record.stateReason = failed.length > 0 ? `Ready; setup step failed: ${failed.join(", ")}.` : null;
        });
        return { state: "done" };
      });
      return null;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return null;
      this.deps.logger.error(`Box ${boxId} setup failed`, errorLine(error));
      return errorLine(error);
    }
  }

  private async createInstance(boxId: string, adapter: BoxProviderAdapter, signal: AbortSignal): Promise<StepOutcome> {
    const record = this.require(boxId);
    if (record.providerRef) return { state: "done", message: "Created before a restart." };
    const kind = record.kind as BoxKind;
    const route = this.deps.connectivity.route();
    const credentials = await this.deps.connectivity.credentials(adapter.id);
    if (!credentials) throw new SetupStepError(`${adapter.label} is not connected.`);
    const tokenTtlMs = (CONNECT_DEADLINE_MS[kind] ?? CONNECT_DEADLINE_MS.linux) + 15 * 60_000;
    const bootstrapToken = await this.deps.hub.issueBootstrapToken(boxId, tokenTtlMs);
    const tailscaleAuthKey = route.tailscale
      ? await route.tailscale.mintAuthKey({ boxId, ttlSeconds: Math.ceil(tokenTtlMs / 1000), signal })
      : null;
    const bootstrap = this.deps.buildBootstrap({
      boxId,
      daemonUrl: route.daemonUrl,
      bootstrapToken,
      tailscaleAuthKey,
      container: CONTAINER_PROVIDERS.has(adapter.id)
    });
    let windowsPassword: string | null = null;
    if (kind === "windows" || kind === "windows-gpu") {
      windowsPassword = generateWindowsPassword();
      await this.deps.store.setWindowsPassword(boxId, windowsPassword);
    }
    const lifetimeMinutes = typeof record.lifetimeMinutes === "number" ? record.lifetimeMinutes : null;
    try {
      const result = await adapter.create(
        credentials,
        {
          boxId,
          name: record.name,
          kind,
          size: record.size,
          region: record.region,
          image: record.image ?? null,
          tags: { "orquester-box": boxId },
          bootstrap,
          sshPublicKey: throwawaySshPublicKey(),
          windowsPassword,
          lifetimeMinutes
        },
        { signal, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) }
      );
      await this.deps.store.update(boxId, (next) => {
        next.providerRef = result.ref;
        if (result.hourlyUsd !== null) next.hourlyUsd = result.hourlyUsd;
        if (result.deadlineAt) next.deadlineAt = result.deadlineAt;
      });
      if (result.windowsPassword) await this.deps.store.setWindowsPassword(boxId, result.windowsPassword);
    } catch (error) {
      if (!signal.aborted) this.deps.onProviderError(adapter.id);
      throw error;
    }
    return { state: "done" };
  }

  private async ensurePaths(boxId: string, connection: BoxConnection, signal: AbortSignal): Promise<StepOutcome> {
    const project = this.require(boxId).project;
    if (!project) throw new SetupStepError("The box has no project.");
    const { baseDir } = this.deps;
    const hostPaths = [project.path, agentAccountsDir(baseDir), agentChatThreadsDir(baseDir), sessionProfilePreparedRootDir(baseDir)];
    const paths = hostPaths.map((path) => hostToBoxPath(connection.paths, path));
    await connection.request("agent.ensurePaths", { paths }, { signal, timeoutMs: 60_000 });
    return { state: "done" };
  }

  private async syncConfig(boxId: string, signal: AbortSignal): Promise<StepOutcome> {
    const sync = this.deps.configSync;
    if (!sync) return { state: "skipped", message: "Config sync is not available in this build." };
    const homes = this.deps.managedAgentHomes();
    if (homes.length === 0) return { state: "skipped", message: "No managed agent accounts to sync." };
    const failures: string[] = [];
    for (const home of homes) {
      signal.throwIfAborted();
      try {
        await sync.ensureSynced(boxId, { agent: home.agent, configRoots: [home.home], threadId: null }, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(`${home.agent} ${home.accountId}: ${errorLine(error)}`);
      }
    }
    if (failures.length > 0) throw new SetupStepError(`Could not sync ${failures.length} of ${homes.length} account homes (${failures[0]}).`);
    return { state: "done", message: `${homes.length} account home${homes.length === 1 ? "" : "s"} synced.` };
  }

  private async git(
    connection: BoxConnection,
    args: string[],
    cwd: string | undefined,
    signal: AbortSignal,
    log: (line: string) => void
  ): Promise<BoxCommandResult> {
    const spec: BoxCommandSpec = { command: "git", args, env: { GIT_TERMINAL_PROMPT: "0" } };
    if (cwd) spec.cwd = cwd;
    return runBoxCommand(connection, spec, { signal, onLine: log });
  }

  private async cloneRepository(
    boxId: string,
    connection: BoxConnection,
    signal: AbortSignal,
    log: (line: string) => void
  ): Promise<StepOutcome> {
    const project = this.require(boxId).project;
    if (!project) throw new SetupStepError("The box has no project.");
    const { sys } = connection;
    const url = typeof project.remoteUrl === "string" ? project.remoteUrl : null;

    // The host keys the box trusts for the remote, then git's credential helper, SSH and identity.
    const knownHostsPath = boxKnownHostsPath(sys.os, sys.home);
    const remote = url && !/^https?:\/\//i.test(url) ? cloneUrlHost(url) : null;
    const knownHosts = remote ? await this.deps.git.knownHosts(remote.host, remote.port) : "";
    await connection.writeFile(knownHostsPath, knownHosts, { mode: 0o644, mkdirs: true });
    const accountId = typeof project.gitAccountId === "string" ? project.gitAccountId : null;
    const identity = accountId ? await this.deps.git.identity(accountId) : null;
    const commands = boxGitConfigCommands({ os: sys.os, agentPath: sys.agentPath, knownHostsPath, identity });
    for (const [index, args] of commands.entries()) {
      const result = await this.git(connection, args, undefined, signal, log);
      // `--unset-all` exits 5 when there was no helper to unset.
      if (result.code !== 0 && !(index === 0 && result.code === 5)) {
        throw new SetupStepError(`git ${args.slice(0, 3).join(" ")} failed (exit ${result.code ?? result.signal}): ${result.tail.trim().split("\n").pop() ?? ""}`);
      }
    }
    const identityNote = identity ? `git identity ${identity.name} <${identity.email}>` : "no git identity (the workspace has no git account)";

    if (project.source === "empty" || project.source === "template" || !url) {
      const what = project.source === "template" ? "the template command runs in the first terminal" : "empty project, nothing to clone";
      return { state: "done", message: `Git configured (${identityNote}); ${what}.` };
    }

    const boxDir = hostToBoxPath(connection.paths, project.path);
    const gitDir = connection.paths.kind === "identity" ? `${boxDir}/.git` : `${boxDir}\\.git`;
    if (await connection.request("fs.stat", { path: gitDir }, { signal })) {
      return { state: "done", message: "Already cloned." };
    }
    const cloneSignal = AbortSignal.any([signal, AbortSignal.timeout(CLONE_TIMEOUT_MS)]);
    const parent = hostToBoxPath(connection.paths, dirname(project.path));
    const dest = basename(project.path);
    const ref = typeof project.ref === "string" && project.ref.length > 0 ? project.ref : undefined;
    log(`git clone ${url}${ref ? ` (${ref})` : ""}`);
    let commit = ref !== undefined && isFullSha(ref) ? ref : undefined;
    let result = await this.git(connection, cloneArgs(url, dest, commit === undefined ? ref : undefined), parent, cloneSignal, log);
    if (result.code !== 0 && ref !== undefined && commit === undefined && mayBeAbbreviatedSha(ref) && isMissingRemoteRef(result.tail)) {
      commit = ref;
      result = await this.git(connection, cloneArgs(url, dest), parent, cloneSignal, log);
    }
    if (result.code !== 0) {
      throw new SetupStepError(`git clone failed (exit ${result.code ?? result.signal}): ${result.tail.trim().split("\n").pop() ?? ""}`);
    }
    if (commit !== undefined) {
      let checkout = await this.git(connection, ["checkout", "--detach", commit], boxDir, cloneSignal, log);
      if (checkout.code !== 0 && isFullSha(commit)) {
        // Not among the cloned refs (a fork's PR head): fetch it by id, as the host clone does.
        const fetched = await this.git(connection, ["fetch", "origin", commit], boxDir, cloneSignal, log);
        if (fetched.code === 0) checkout = await this.git(connection, ["checkout", "--detach", "FETCH_HEAD"], boxDir, cloneSignal, log);
      }
      if (checkout.code !== 0) throw new SetupStepError(`Cloned, but could not check out ${commit}.`);
    }
    return { state: "done", message: `Cloned${ref ? ` at ${ref}` : ""}; ${identityNote}.` };
  }

  private async installToolchain(
    boxId: string,
    connection: BoxConnection,
    signal: AbortSignal,
    log: (line: string) => void
  ): Promise<StepOutcome> {
    const project = this.require(boxId).project;
    if (!project) throw new SetupStepError("The box has no project.");
    const { sys } = connection;
    if (sys.os === "win32") return { state: "skipped", message: "Automatic toolchain setup is not available on Windows boxes." };
    const boxDir = hostToBoxPath(connection.paths, project.path);
    if (sys.os === "linux" && !(sys.isRoot || sys.canElevate)) {
      log("No root access in the box: skipped installing bubblewrap (Codex's sandbox).");
    } else if (sys.os === "linux") {
      // Codex's sandbox needs bubblewrap; best effort, never the step's failure.
      log("Checking bubblewrap (Codex's sandbox).");
      const bwrap = await runBoxCommand(
        connection,
        { command: bubblewrapScript(), shell: true },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(TOOLCHAIN_COMMAND_TIMEOUT_MS)]), onLine: log }
      );
      if (bwrap.code !== 0) log(`Could not install bubblewrap (exit ${bwrap.code ?? bwrap.signal}); Codex runs without its sandbox here.`);
    }
    const present = new Set<string>();
    const contents: Record<string, string> = {};
    for (const file of TOOLCHAIN_PROBE_FILES) {
      const info = await connection.request("fs.stat", { path: `${boxDir}/${file}` }, { signal });
      if (!info || info.kind !== "file") continue;
      present.add(file);
      if (TOOLCHAIN_READ_FILES.includes(file)) {
        contents[file] = await readText(await connection.readFile(`${boxDir}/${file}`, { length: FILE_READ_MAX, signal }), FILE_READ_MAX);
      }
    }
    const plan = planToolchain({ os: sys.os, docker: sys.docker, projectDir: boxDir, present, contents });
    for (const note of plan.notes) log(note);
    if (plan.mode === "none") return { state: "done", message: "Nothing to install." };
    for (const command of plan.commands) {
      log(`$ ${command.label}`);
      const result = await runBoxCommand(
        connection,
        { command: command.script, shell: true, cwd: boxDir },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(TOOLCHAIN_COMMAND_TIMEOUT_MS)]), onLine: log }
      );
      if (result.code !== 0) throw new SetupStepError(`${command.label} failed (exit ${result.code ?? result.signal}).`);
    }
    return {
      state: "done",
      message: plan.mode === "devcontainer" ? "The devcontainer is up." : plan.commands.map((command) => command.label).join("; ")
    };
  }

  /**
   * Run one setup step: skipped when a resumed setup finished it already; otherwise `running`, then
   * `done`/`skipped` or `failed` (its message). Resolves whether setup may go on past it.
   */
  private async runStep(
    boxId: string,
    id: BoxSetupStepId,
    signal: AbortSignal,
    run: (log: (line: string) => void) => Promise<StepOutcome>
  ): Promise<boolean> {
    signal.throwIfAborted();
    const current = (this.require(boxId).setup ?? []).find((step) => step.id === id);
    if (current && (current.state === "done" || current.state === "skipped")) return true;
    if (current?.state === "failed" && id !== "create" && id !== "connect" && id !== "paths") return true;
    const label = SETUP_STEP_LABELS[id];
    const log = (line: string) => void this.deps.setupLog.append(boxId, `[${id}] ${line}`);
    await this.patchStep(boxId, id, { state: "running", startedAt: this.iso(), finishedAt: null, message: null });
    log(`${label}…`);
    try {
      const outcome = await run(log);
      signal.throwIfAborted();
      await this.patchStep(boxId, id, { state: outcome.state, finishedAt: this.iso(), message: outcome.message ?? null });
      log(outcome.state === "skipped" ? `Skipped: ${outcome.message ?? ""}` : `Done${outcome.message ? `: ${outcome.message}` : "."}`);
      return true;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      const message = errorLine(error);
      log(`Failed: ${message}`);
      await this.patchStep(boxId, id, { state: "failed", finishedAt: this.iso(), message });
      return false;
    }
  }

  private stepMessage(boxId: string, id: BoxSetupStepId): string {
    const step = (this.deps.store.get(boxId)?.setup ?? []).find((candidate) => candidate.id === id);
    return `${SETUP_STEP_LABELS[id]} failed${step?.message ? `: ${step.message}` : "."}`;
  }

  private async patchStep(boxId: string, id: BoxSetupStepId, patch: Partial<BoxSetupStep> & { state: BoxSetupStepState }): Promise<void> {
    await this.deps.store.update(boxId, (record) => {
      const steps = record.setup ?? initialStoredSetup(record.purpose === "temporary" ? "temporary" : "project");
      const index = steps.findIndex((step) => step.id === id);
      const base = index >= 0 ? steps[index]! : { id, label: SETUP_STEP_LABELS[id], state: "pending", startedAt: null, finishedAt: null, message: null };
      const next = { ...base, ...patch };
      record.setup = index >= 0 ? steps.map((step, i) => (i === index ? next : step)) : [...steps, next];
    });
  }

  // ---- destroy ---------------------------------------------------------------------------------

  private async runDestroy(boxId: string, reason: BoxDestroyedReason, message: string | null): Promise<StoredBox> {
    const before = this.deps.store.get(boxId);
    if (!before) throw new BoxError(404, "BOX_NOT_FOUND", `No box ${boxId}.`);
    if (before.state === "destroyed") return before;
    // Stop setup first; its create may still land a provider ref.
    const run = this.runs.get(boxId);
    if (run) {
      run.abort.abort();
      await run.pipeline.catch(() => undefined);
    }
    await this.deps.store.update(boxId, (record) => {
      record.state = "destroying";
      record.stateReason = "Destroying…";
      record[PENDING_DESTROY_REASON] = reason;
      if (message) record[PENDING_DESTROY_MESSAGE] = message;
    });
    const record = this.require(boxId);
    const adapter = this.deps.providers.get(record.provider as BoxProviderId);
    const label = adapter?.label ?? record.provider;
    void this.deps.setupLog.append(boxId, `Destroying (${reason})${message ? `: ${message}` : ""}.`);
    try {
      if (record.kind === "macos") await this.shutdownAgent(boxId);
      if (record.providerRef) {
        if (!adapter) throw new Error(`This build has no adapter for the provider "${record.provider}".`);
        const credentials = await this.deps.connectivity.credentials(adapter.id);
        if (!credentials) throw new Error(`${adapter.label} is not connected any more; reconnect it to destroy this box.`);
        await this.destroyAndConfirm(adapter, credentials, record.providerRef);
      }
    } catch (error) {
      const line = errorLine(error);
      this.deps.logger.error(`Box ${boxId} destroy failed`, line);
      void this.deps.setupLog.append(boxId, `Destroy failed: ${line}`);
      await this.deps.store
        .update(boxId, (next) => {
          next.state = "destroy-failed";
          next.stateReason = `Destroy failed: ${line} It may still be billing — retry.`;
        })
        .catch((writeError) => this.deps.logger.error(`Box ${boxId}: could not record the failed destroy`, errorLine(writeError)));
      this.deps.onProviderError(record.provider);
      throw new BoxError(502, "BOX_PROVIDER_ERROR", `Could not destroy the box at ${label}: ${line}`);
    }
    await this.deps.hub.revoke(boxId).catch((error) => this.deps.logger.warn(`Could not revoke box ${boxId}`, errorLine(error)));
    if (record.connectRoute === "tailscale") {
      await this.deps.connectivity
        .tailscaleKeys()
        ?.removeNode({ boxId, signal: AbortSignal.timeout(30_000) })
        .catch((error) => this.deps.logger.warn(`Could not remove the tailnet node of box ${boxId}`, errorLine(error)));
    }
    const text = message ?? destroyedReasonText(reason, label);
    const destroyed = await this.finishDestroyed(boxId, reason, text);
    void this.deps.setupLog.append(boxId, `Destroyed: ${text}`);
    return destroyed;
  }

  private async finishDestroyed(boxId: string, reason: BoxDestroyedReason, text: string): Promise<StoredBox> {
    await this.deps.store.setWindowsPassword(boxId, null).catch(() => undefined);
    const at = new Date(this.deps.clock.now()).toISOString();
    const destroyed = await this.deps.store.update(boxId, (record) => {
      record.state = "destroyed";
      record.destroyedAt = at;
      record.destroyedReason = reason;
      record.stateReason = text;
      delete record[PENDING_DESTROY_REASON];
      delete record[PENDING_DESTROY_MESSAGE];
    });
    return destroyed ?? this.require(boxId);
  }

  /** Destroy, then poll the provider (with backoff, bounded) until it reports the instance gone. */
  private async destroyAndConfirm(adapter: BoxProviderAdapter, credentials: ProviderCredentials, ref: ProviderInstanceRef): Promise<void> {
    const signal = AbortSignal.timeout(DESTROY_CONFIRM_MS);
    const options = { signal, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) };
    await adapter.destroy(credentials, ref, options);
    for (let attempt = 0; ; attempt++) {
      const status = await adapter.status(credentials, ref, options);
      if (status.state === "gone") return;
      if (signal.aborted) break;
      try {
        await this.deps.clock.wait(DESTROY_POLL_MS[Math.min(attempt, DESTROY_POLL_MS.length - 1)]!, signal);
      } catch {
        break;
      }
    }
    throw new Error(`${adapter.label} did not confirm the instance is gone within ${DESTROY_CONFIRM_MS / 60_000} min.`);
  }

  /** macOS runners: ask `orq-agent` to exit so the job ends successfully before it is cancelled. */
  private async shutdownAgent(boxId: string): Promise<void> {
    const connection = this.deps.hub.get(boxId);
    if (!connection?.connected) return;
    await connection.request("agent.shutdown", { reason: "destroyed" }, { timeoutMs: 10_000 }).catch(() => undefined);
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private require(boxId: string): StoredBox {
    const record = this.deps.store.get(boxId);
    if (!record) throw new BoxError(404, "BOX_NOT_FOUND", `No box ${boxId}.`);
    return record;
  }

  private iso(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch(() => undefined).finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }
}
