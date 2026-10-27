/**
 * Bring-your-own machines (Devices phase 3 §2.1): pairing, settings, removal, and lending a machine
 * to a project or a chat. The provider side is `providers/byo.ts`; the pairing script is
 * `bootstrap/bootstrap.ts` (`byoPairingScript`); connection state and release live in the
 * lifecycle (`BoxLifecycle.connectionChanged`, `BoxLifecycle.release`).
 *
 * - **Pairing.** "Add your machine" writes a `pairing` record (`purpose: "machine"`) and a one-time
 *   code valid {@link PAIRING_TTL_MS}; only the code's SHA-256 is kept. The owner runs
 *   `curl -fsSL <daemon URL>/api/boxes/pair/<code> | sh`: the first fetch spends the code, mints
 *   the machine's single-use bootstrap token (the hub's usual path: exchanged for the box
 *   credential on the first connect) and answers the script with it. A wrong, spent or expired
 *   code answers 404 like any other, and failures are throttled per client
 *   ({@link PairingThrottle}). The code never reaches a log line.
 * - **Lending.** A project or a chat takes an idle, connected machine: its record takes their
 *   purpose (`project` with setup from `connect` on; `temporary` with the chat's time limit), and
 *   "destroying" it gives it back. A chat reaches the owner's machine only after the owner approved
 *   a "Use your machine" card (`mcp/tools/boxes.ts`).
 * - **Removal.** A connected machine is told to uninstall its service and exit
 *   (`agent.shutdown` with `uninstall`); then its credential is revoked and the record deleted. A
 *   machine in use must be released first.
 */

import { randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";

import {
  BYO_MACHINE_KINDS,
  BYO_PAIRING_TTL_MINUTES,
  type AddByoMachineRequest,
  type BoxSummary,
  type ByoMachineKind,
  type ByoPairingResponse,
  type UpdateByoMachineRequest
} from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import { byoPairingScript, normalizeDaemonUrl } from "../bootstrap/bootstrap.ts";
import type { BoxHub } from "../contracts.ts";
import { hashSecret, secretMatches } from "../hub/auth.ts";
import { BYO_REGION, byoMachineIdle } from "../providers/byo.ts";
import type { BoxSetupLog } from "./box-exec.ts";
import { BoxError, errorLine } from "./errors.ts";
import { newBoxId, type BoxClock, type BoxLifecycle, type StoredBoxProject } from "./lifecycle.ts";
import { PROJECT_DELETED_FIELD } from "./registry.ts";
import type { BoxSettings } from "./settings.ts";
import type { BoxStore } from "./store.ts";
import { initialStoredSetup, SETUP_STEP_LABELS } from "./summary.ts";

export const PAIRING_TTL_MS = BYO_PAIRING_TTL_MINUTES * 60_000;
/** The bootstrap token the spent code mints: the script has this long to download and connect. */
export const PAIRING_BOOTSTRAP_TTL_MS = 30 * 60_000;
/** 18 random bytes, base64url. */
export const PAIRING_CODE_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const MAX_NAME_CHARS = 60;
/** How long a removed machine gets to acknowledge the uninstall before its link is cut. */
const UNINSTALL_ACK_MS = 15_000;

export const PAIRING_WAITING_REASON = "Waiting for the pairing command to run on the machine.";
export const PAIRING_FETCHED_REASON = "The pairing script was downloaded; waiting for orq-agent to connect…";

/** The pair route's answer: the script, or a refusal that says nothing about which codes exist. */
export type PairingScriptOutcome =
  | { ok: true; script: string }
  | { ok: false; status: 404 | 429 | 503; code: string; message: string; retryAfterSeconds?: number };

/**
 * The throttle's key for a client address: an IPv4 address as is (an IPv4-mapped IPv6 one too),
 * an IPv6 address by its /64 (one host usually holds a whole /64, so per-address keys would let
 * it rotate freely); anything else verbatim.
 */
export function pairingThrottleKey(client: string): string {
  const address = client.split("%")[0]!.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  if (!isIPv6(address)) return client;
  let text = address;
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number) as [number, number, number, number];
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? (text.split("::") as [string, string]) : [text, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === null ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * Failed pairing fetches per client ({@link pairingThrottleKey}): {@link PairingThrottle.MAX_FAILURES}
 * within {@link PairingThrottle.WINDOW_MS}, then refused until the window ends. Codes carry 144
 * random bits, so this only keeps a guesser from making noise. At most
 * {@link PairingThrottle.MAX_CLIENTS} clients are remembered: the map is ordered by window start,
 * so expired windows leave from its front and, when full, the oldest window goes (every check O(1)
 * amortized).
 */
export class PairingThrottle {
  static readonly MAX_FAILURES = 10;
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly MAX_CLIENTS = 4096;
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly now: () => number) {}

  /** How many clients are remembered (tests). */
  get size(): number {
    return this.failures.size;
  }

  retryAfterMs(client: string): number {
    this.prune();
    const entry = this.failures.get(pairingThrottleKey(client));
    if (!entry) return 0;
    return entry.count >= PairingThrottle.MAX_FAILURES ? entry.since + PairingThrottle.WINDOW_MS - this.now() : 0;
  }

  recordFailure(client: string): void {
    this.prune();
    const key = pairingThrottleKey(client);
    const entry = this.failures.get(key);
    if (entry) {
      entry.count += 1;
      return;
    }
    // A new window goes last (the map stays ordered by `since`); full: the oldest window goes.
    if (this.failures.size >= PairingThrottle.MAX_CLIENTS) {
      const oldest = this.failures.keys().next();
      if (!oldest.done) this.failures.delete(oldest.value);
    }
    this.failures.set(key, { count: 1, since: this.now() });
  }

  /** Drop the windows that ended (all at the front). */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.failures) {
      if (entry.since + PairingThrottle.WINDOW_MS > now) break;
      this.failures.delete(key);
    }
  }
}

export interface ByoMachinesDeps {
  store: BoxStore;
  hub: BoxHub;
  settings: Pick<BoxSettings, "route">;
  lifecycle: Pick<BoxLifecycle, "provisionLeased">;
  setupLog: BoxSetupLog;
  clock: BoxClock;
  logger: Pick<Console, "warn">;
  enabled(): boolean;
  summarize(record: StoredBox): BoxSummary | null;
}

function invalid(message: string): BoxError {
  return new BoxError(400, "BOX_INVALID_REQUEST", message);
}

function machineName(value: unknown): string {
  if (typeof value !== "string") throw invalid("Give the machine a name.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > MAX_NAME_CHARS) throw invalid(`The name must be 1–${MAX_NAME_CHARS} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw invalid("The name must be one line of text.");
  return name;
}

/** Who uses a lent machine, for a refusal. */
function inUseBy(record: StoredBox): string {
  if (record.purpose === "project" && record.project) return `the project ${record.project.workspace}/${record.project.name}`;
  return "an agent chat";
}

export class ByoMachines {
  private readonly throttle: PairingThrottle;

  constructor(private readonly deps: ByoMachinesDeps) {
    this.throttle = new PairingThrottle(() => deps.clock.now());
  }

  /** "Add your machine": the `pairing` record and its one-time command. */
  async add(body: AddByoMachineRequest | undefined): Promise<ByoPairingResponse> {
    const request = (body && typeof body === "object" ? body : {}) as Partial<AddByoMachineRequest>;
    if (!(BYO_MACHINE_KINDS as readonly unknown[]).includes(request.kind)) throw invalid('`kind` must be "linux" or "macos".');
    const kind = request.kind as ByoMachineKind;
    const name = machineName(request.name);
    // No route to this daemon: the machine could never connect.
    const route = this.deps.settings.route("byo");
    const installationId = await this.deps.store.ensureInstallationId();
    let id = newBoxId();
    while (this.deps.store.get(id)) id = newBoxId();
    const record: StoredBox = {
      id,
      purpose: "machine",
      kind,
      provider: "byo",
      region: BYO_REGION.id,
      regionLabel: BYO_REGION.label,
      size: "machine",
      sizeLabel: name,
      image: null,
      name: `orq-${installationId}-${id}`,
      machineName: name,
      os: null,
      arch: null,
      libc: null,
      hourlyUsd: 0,
      createdAt: this.iso(),
      readyAt: null,
      deadlineAt: null,
      destroyedAt: null,
      lastSeenAt: null,
      state: "pairing",
      stateReason: PAIRING_WAITING_REASON,
      destroyedReason: null,
      project: null,
      threadId: null,
      purposeNote: null,
      connectRoute: route.mode,
      setup: [],
      deviceHost: false
    };
    await this.deps.store.insert(record);
    void this.deps.setupLog.append(id, `Machine "${name}" (${kind}) added; waiting for its pairing command.`);
    return this.issuePairing(id, route.daemonUrl);
  }

  /** A new command for a machine still `pairing`; the previous code stops working. */
  async newPairing(boxId: string): Promise<ByoPairingResponse> {
    const record = this.require(boxId);
    if (record.state !== "pairing") throw new BoxError(409, "BOX_INVALID_REQUEST", "This machine is paired already.");
    return this.issuePairing(boxId, this.deps.settings.route("byo").daemonUrl);
  }

  /** Rename, or switch "Use for device simulators". */
  async update(boxId: string, body: UpdateByoMachineRequest | undefined): Promise<BoxSummary> {
    this.require(boxId);
    const request = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const name = request.name === undefined ? undefined : machineName(request.name);
    if (request.deviceHost !== undefined && typeof request.deviceHost !== "boolean") throw invalid("`deviceHost` must be true or false.");
    const deviceHost = request.deviceHost as boolean | undefined;
    const updated = await this.deps.store.update(boxId, (record) => {
      if (name !== undefined) {
        record.machineName = name;
        record.sizeLabel = name;
      }
      if (deviceHost !== undefined) record.deviceHost = deviceHost;
    });
    return this.summary(updated ?? this.require(boxId));
  }

  /**
   * "Remove machine": a connected machine uninstalls its service and exits first; then its
   * credential is revoked and its record deleted. `uninstalled` is false when it was not connected
   * (its owner removes the service by hand: `orq-agent uninstall-service`).
   */
  async remove(boxId: string): Promise<{ uninstalled: boolean }> {
    const record = this.require(boxId);
    if (record.purpose === "project" || record.purpose === "temporary") {
      throw new BoxError(409, "BOX_IN_USE", `This machine is used by ${inUseBy(record)}: ${record.purpose === "project" ? "delete the project" : "release it"} first.`);
    }
    let uninstalled = false;
    const connection = this.deps.hub.get(boxId);
    if (connection?.connected) {
      try {
        await connection.request("agent.shutdown", { reason: "removed", uninstall: true }, { timeoutMs: UNINSTALL_ACK_MS });
        uninstalled = true;
      } catch (error) {
        this.deps.logger.warn(`Machine ${boxId}: the uninstall request failed`, errorLine(error));
      }
    }
    await this.deps.hub.revoke(boxId);
    await this.deps.store.remove([boxId]);
    return { uninstalled };
  }

  /**
   * The pair route: spend the code and answer the machine's script with a fresh bootstrap token.
   * `client` keys the throttle (the request's address).
   */
  async pairingScript(code: string, client: string): Promise<PairingScriptOutcome> {
    const notFound: PairingScriptOutcome = {
      ok: false,
      status: 404,
      code: "PAIRING_NOT_FOUND",
      message: "This pairing command is not valid any more: create a new one in Orquester (Settings → Plugins → Ephemeral AI VMs)."
    };
    if (!this.deps.enabled()) return notFound;
    const wait = this.throttle.retryAfterMs(client);
    if (wait > 0) {
      const retryAfterSeconds = Math.ceil(wait / 1000);
      return { ok: false, status: 429, code: "PAIRING_THROTTLED", message: `Too many failed pairing attempts; try again in ${Math.ceil(retryAfterSeconds / 60)} min.`, retryAfterSeconds };
    }
    const fail = (): PairingScriptOutcome => {
      this.throttle.recordFailure(client);
      return notFound;
    };
    if (!PAIRING_CODE_PATTERN.test(code)) return fail();
    const record = this.deps.store
      .list()
      .find((candidate) => candidate.provider === "byo" && candidate.state === "pairing" && secretMatches(code, candidate.pairingCodeHash));
    if (!record) return fail();
    const expires = record.pairingExpiresAt ? Date.parse(record.pairingExpiresAt) : Number.NaN;
    const hash = record.pairingCodeHash;
    const expired = !Number.isFinite(expires) || expires <= this.deps.clock.now();
    // Single use: the code is gone in the same write that checks it is still this one.
    try {
      await this.deps.store.update(record.id, (next) => {
        if (next.pairingCodeHash !== hash) throw new Error("spent concurrently");
        delete next.pairingCodeHash;
        delete next.pairingExpiresAt;
        if (!expired) next.stateReason = PAIRING_FETCHED_REASON;
      });
    } catch {
      return fail();
    }
    if (expired) return fail();
    try {
      const route = this.deps.settings.route("byo");
      const bootstrapToken = await this.deps.hub.issueBootstrapToken(record.id, PAIRING_BOOTSTRAP_TTL_MS);
      const script = byoPairingScript({
        boxId: record.id,
        daemonUrl: route.daemonUrl,
        bootstrapToken,
        kind: record.kind === "macos" ? "macos" : "linux",
        name: record.machineName ?? record.name
      });
      void this.deps.setupLog.append(record.id, "The pairing script was downloaded.");
      return { ok: true, script };
    } catch (error) {
      this.deps.logger.warn(`Machine ${record.id}: could not build its pairing script`, errorLine(error));
      return { ok: false, status: 503, code: "PAIRING_UNAVAILABLE", message: "Orquester could not prepare the pairing script; create a new pairing command and try again." };
    }
  }

  /** Lend an idle, connected machine to a chat until its time limit (an approved `create_box`). */
  async leaseTemporary(boxId: string, lease: { threadId: string | null; purposeNote: string; lifetimeMinutes: number | null }): Promise<StoredBox> {
    const name = this.require(boxId).machineName ?? boxId;
    const at = this.iso();
    const deadlineAt = lease.lifetimeMinutes !== null ? new Date(this.deps.clock.now() + lease.lifetimeMinutes * 60_000).toISOString() : null;
    const step = (id: "create" | "connect" | "ready", message: string | null) => ({ id, label: SETUP_STEP_LABELS[id], state: "done", startedAt: at, finishedAt: at, message });
    const leased = await this.deps.store.update(boxId, (record) => {
      this.assertFree(record);
      record.purpose = "temporary";
      record.threadId = lease.threadId;
      record.purposeNote = lease.purposeNote;
      record.deadlineAt = deadlineAt;
      if (lease.lifetimeMinutes !== null) record.lifetimeMinutes = lease.lifetimeMinutes;
      record.stateReason = null;
      record.setup = [step("create", `Your machine "${name}".`), step("connect", null), step("ready", null)];
    });
    void this.deps.setupLog.append(boxId, `Lent to an agent chat: ${lease.purposeNote}`);
    return leased ?? this.require(boxId);
  }

  /** Place a new project on an idle, connected machine and start its setup (from `connect` on). */
  async leaseProject(boxId: string, project: StoredBoxProject): Promise<StoredBox> {
    const name = this.require(boxId).machineName ?? boxId;
    const at = this.iso();
    const leased = await this.deps.store.update(boxId, (record) => {
      this.assertFree(record);
      record.purpose = "project";
      record.project = project;
      record.state = "provisioning";
      record.stateReason = "Setting up…";
      delete record[PROJECT_DELETED_FIELD];
      record.setup = initialStoredSetup("project").map((step) =>
        step.id === "create" ? { ...step, state: "done", startedAt: at, finishedAt: at, message: `Your machine "${name}".` } : step
      );
    });
    void this.deps.setupLog.append(boxId, `Project ${project.workspace}/${project.name} placed on this machine.`);
    this.deps.lifecycle.provisionLeased(boxId);
    return leased ?? this.require(boxId);
  }

  private assertFree(record: StoredBox): void {
    if (record.provider !== "byo") throw new BoxError(400, "BOX_INVALID_REQUEST", "That is not one of your machines.");
    if (record.purpose !== "machine") throw new BoxError(409, "BOX_IN_USE", `${record.machineName ?? "This machine"} is used by ${inUseBy(record)}.`);
    if (record.deviceHost === true) {
      throw new BoxError(409, "BOX_IN_USE", `${record.machineName ?? "This machine"} is used for device simulators; turn that off in its settings to lend it to a chat or project.`);
    }
    if (!byoMachineIdle(record, this.deps.hub.get(record.id)?.connected === true)) {
      throw new BoxError(409, "BOX_NOT_READY", `${record.machineName ?? "This machine"} is not connected right now.`);
    }
  }

  private async issuePairing(boxId: string, daemonUrl: string): Promise<ByoPairingResponse> {
    const code = randomBytes(18).toString("base64url");
    const expiresAt = new Date(this.deps.clock.now() + PAIRING_TTL_MS).toISOString();
    const updated = await this.deps.store.update(boxId, (record) => {
      record.pairingCodeHash = hashSecret(code);
      record.pairingExpiresAt = expiresAt;
      record.stateReason = PAIRING_WAITING_REASON;
    });
    const origin = normalizeDaemonUrl(daemonUrl);
    return { box: this.summary(updated ?? this.require(boxId)), command: `curl -fsSL ${origin}/api/boxes/pair/${code} | sh`, expiresAt };
  }

  private require(boxId: string): StoredBox {
    const record = this.deps.store.get(boxId);
    if (!record || record.provider !== "byo") throw new BoxError(404, "BOX_NOT_FOUND", "No such machine.");
    return record;
  }

  private summary(record: StoredBox): BoxSummary {
    const summary = this.deps.summarize(record);
    if (!summary) throw new BoxError(500, "BOXES_UNAVAILABLE", "The machine's record cannot be shown.");
    return summary;
  }

  private iso(): string {
    return new Date(this.deps.clock.now()).toISOString();
  }
}
