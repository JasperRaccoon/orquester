/**
 * `box_forward_port` for a box project's chat (`./tools.ts`): its shell, curl and (Linux project
 * boxes) its Browser tab's Chromium run in the project's own box, where the host's loopback is out
 * of reach. So the forward listens on the PROJECT BOX's 127.0.0.1 (`forward.listen`, done by
 * orq-agent), and each connection is piped project box → daemon (a `host-tcp` channel) → the
 * temporary box's port.
 *
 * - **One owner per project box's forward list.** `BoxHub.setForwards` replaces the list whole; every
 *   forward of a project box is in it, so the hub re-establishes them all on every connect.
 * - **Targets are unguessable and bound to their box.** The box names the target of each `host-tcp`
 *   channel it opens: one is served only when the target is a live forward made for the box that
 *   opened it, on the port it was made for. Anything else is closed at once.
 * - **The port**: the temporary box's port number when the project box has it free and it is not a
 *   privileged one (< 1024), else a random free one (orq-agent binds 127.0.0.1:<port>; a port the
 *   box refuses for any reason — taken, forbidden, reserved by Windows — is retried elsewhere).
 *   `open` resolves once the project box listens, or rejects with why it cannot.
 * - **Checked again on every connect**: the box re-listens its list from the welcome and tells no
 *   one when a port is gone meanwhile, so each forward is listened again; one the box now refuses is
 *   dropped (the next `box_forward_port` makes a new one) rather than handed out as a URL that may
 *   reach another process.
 * - Calls for one project box run one at a time; a destroyed project box's forwards are dropped.
 */

import { randomBytes, randomInt } from "node:crypto";
import type { Duplex } from "node:stream";

import type { BoxChannelSpec, BoxForwardSpec } from "@orquester/api";

import { BOX_DISCONNECTED } from "../client/mux.ts";
import type { BoxHub, BoxRegistry } from "../contracts.ts";

/** Ports tried in all (the preferred one first) before giving up. */
const MAX_LISTEN_ATTEMPTS = 8;
/** Errors of `forward.listen` after which no other port is tried: the box did not answer (else another port may do). */
const NO_RETRY = new Set([BOX_DISCONNECTED, "TIMEOUT"]);
/** The lowest port listened on in a project box as is: below it are the privileged ones. */
const MIN_PREFERRED_PORT = 1024;
/** Where a replacement port is drawn from (above the usual dev-server ports, below Linux's ephemeral range). */
const FALLBACK_PORTS = { min: 20_000, max: 32_000 };

export type ProjectBoxForwardErrorCode = "PROJECT_BOX_NOT_CONNECTED" | "PROJECT_BOX_LISTEN_FAILED";

export class ProjectBoxForwardError extends Error {
  constructor(
    readonly code: ProjectBoxForwardErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProjectBoxForwardError";
  }
}

/** A listener in a project box piping to one temporary box port. */
export interface ProjectBoxForward {
  readonly projectBoxId: string;
  /** The port on the project box's 127.0.0.1. */
  readonly boxPort: number;
  /** False once closed or dropped with its project box. */
  active(): boolean;
  /** Once the checks of its project box queued before it are done (a reconnect's): whether it still listens. */
  alive(): Promise<boolean>;
  /** Stop listening. Idempotent. */
  close(): Promise<void>;
}

export interface ProjectBoxForwardsDeps {
  hub: Pick<BoxHub, "get" | "setForwards" | "handleChannel" | "onConnectionChange">;
  registry: Pick<BoxRegistry, "get" | "onChange">;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

interface Entry {
  readonly projectBoxId: string;
  readonly boxPort: number;
  readonly target: string;
  /** A fresh stream to the temporary box's port. */
  readonly upstream: () => Promise<Duplex>;
}

const notConnected = (): ProjectBoxForwardError =>
  new ProjectBoxForwardError("PROJECT_BOX_NOT_CONNECTED", "The project's box is not connected right now (reconnecting…).");

export class ProjectBoxForwards {
  /** Project box → its port → forward. */
  private readonly byBox = new Map<string, Map<number, Entry>>();
  private readonly targets = new Map<string, Entry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly deps: ProjectBoxForwardsDeps) {
    deps.hub.handleChannel("host-tcp", (context, spec, stream) => this.serve(context.boxId, spec, stream));
    this.unsubscribe = [
      deps.registry.onChange((boxId) => {
        const record = deps.registry.get(boxId);
        if (!record || record.state === "destroyed") this.forget(boxId);
      }),
      deps.hub.onConnectionChange((boxId, connected) => {
        if (connected && this.byBox.has(boxId)) void this.serial(boxId, () => this.recheck(boxId));
      })
    ];
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  /**
   * Listen on the project box (`preferredPort` when it is free there) and pipe each connection to
   * `upstream()`. Rejects with a {@link ProjectBoxForwardError} when the box is not connected or no
   * port could be listened on.
   */
  open(projectBoxId: string, preferredPort: number, upstream: () => Promise<Duplex>): Promise<ProjectBoxForward> {
    return this.serial(projectBoxId, async () => {
      const connection = this.deps.hub.get(projectBoxId);
      if (!connection?.connected) throw notConnected();
      const taken = new Set<number>();
      try {
        for (const listening of await connection.request("sys.ports", {}, { timeoutMs: 10_000 })) taken.add(listening.port);
      } catch {
        // Unknown: the listen itself tells.
      }
      for (const port of this.byBox.get(projectBoxId)?.keys() ?? []) taken.add(port);
      let failure = "no free port was found";
      for (let attempt = 0; attempt < MAX_LISTEN_ATTEMPTS; attempt += 1) {
        const boxPort = attempt === 0 && preferredPort >= MIN_PREFERRED_PORT && !taken.has(preferredPort) ? preferredPort : freePort(taken);
        taken.add(boxPort);
        const entry: Entry = { projectBoxId, boxPort, target: `fwd-${randomBytes(18).toString("base64url")}`, upstream };
        this.add(entry);
        const outcome = (await this.publish(projectBoxId)).find((candidate) => candidate.boxPort === boxPort);
        if (outcome && outcome.error === null) return this.handle(entry);
        this.drop(entry);
        await this.publish(projectBoxId);
        if (!outcome || outcome.error?.code === BOX_DISCONNECTED) throw notConnected();
        failure = outcome.error?.message ?? failure;
        if (NO_RETRY.has(outcome.error?.code ?? "")) break;
      }
      throw new ProjectBoxForwardError("PROJECT_BOX_LISTEN_FAILED", failure);
    });
  }

  /** A `host-tcp` channel the box `boxId` opened: served only for a live forward of that box, on its own port. */
  private serve(boxId: string, spec: BoxChannelSpec, stream: Duplex): void {
    const entry = spec.kind === "host-tcp" ? this.targets.get(spec.target) : undefined;
    if (!entry || spec.kind !== "host-tcp" || entry.projectBoxId !== boxId || entry.boxPort !== spec.boxPort) {
      // The target is not logged: it is the forward's only credential.
      this.deps.logger?.warn("a box opened a host-tcp channel for no forward of its own; closed", { boxId, boxPort: spec.kind === "host-tcp" ? spec.boxPort : null });
      stream.destroy();
      return;
    }
    let upstream: Duplex | null = null;
    stream.on("error", () => upstream?.destroy());
    entry.upstream().then(
      (opened) => {
        if (stream.destroyed) {
          opened.destroy();
          return;
        }
        upstream = opened;
        // Half-open, as the host forwards: the client's end travels on, the answer still comes back.
        stream.pipe(opened).pipe(stream);
        opened.on("error", () => stream.destroy());
        stream.once("close", () => opened.destroy());
        opened.once("close", () => stream.end());
      },
      () => stream.destroy()
    );
  }

  private handle(entry: Entry): ProjectBoxForward {
    return {
      projectBoxId: entry.projectBoxId,
      boxPort: entry.boxPort,
      active: () => this.targets.get(entry.target) === entry,
      alive: () => this.serial(entry.projectBoxId, async () => this.targets.get(entry.target) === entry),
      close: () =>
        this.serial(entry.projectBoxId, async () => {
          if (this.targets.get(entry.target) !== entry) return;
          this.drop(entry);
          await this.publish(entry.projectBoxId);
        })
    };
  }

  /** The project box's whole list to the hub; the outcomes of the listens it sent. */
  private publish(projectBoxId: string, options: { relisten?: boolean } = {}): ReturnType<BoxHub["setForwards"]> {
    const specs: BoxForwardSpec[] = [...(this.byBox.get(projectBoxId)?.values() ?? [])].map((entry) => ({ boxPort: entry.boxPort, target: entry.target }));
    return this.deps.hub.setForwards(projectBoxId, specs, options);
  }

  /** The project box (re)connected: every forward listened again; one it refuses now is dropped. */
  private async recheck(projectBoxId: string): Promise<void> {
    const entries = [...(this.byBox.get(projectBoxId)?.values() ?? [])];
    if (entries.length === 0) return;
    const outcomes = await this.publish(projectBoxId, { relisten: true });
    let dropped = false;
    for (const entry of entries) {
      const error = outcomes.find((outcome) => outcome.boxPort === entry.boxPort)?.error;
      // No outcome, or the link dropped again: the next connect checks it.
      if (!error || error.code === BOX_DISCONNECTED) continue;
      this.deps.logger?.warn("a forward in a project box could not listen again after a reconnect; dropped", { boxId: projectBoxId, boxPort: entry.boxPort, error: error.message });
      this.drop(entry);
      dropped = true;
    }
    if (dropped) await this.publish(projectBoxId);
  }

  private add(entry: Entry): void {
    let entries = this.byBox.get(entry.projectBoxId);
    if (!entries) {
      entries = new Map();
      this.byBox.set(entry.projectBoxId, entries);
    }
    entries.set(entry.boxPort, entry);
    this.targets.set(entry.target, entry);
  }

  private drop(entry: Entry): void {
    this.targets.delete(entry.target);
    const entries = this.byBox.get(entry.projectBoxId);
    if (entries?.get(entry.boxPort) === entry) entries.delete(entry.boxPort);
    if (entries?.size === 0) this.byBox.delete(entry.projectBoxId);
  }

  /** A destroyed project box: its forwards are gone with it (the hub dropped its list on revoke). */
  private forget(projectBoxId: string): void {
    for (const entry of this.byBox.get(projectBoxId)?.values() ?? []) this.targets.delete(entry.target);
    this.byBox.delete(projectBoxId);
  }

  private serial<T>(projectBoxId: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(projectBoxId) ?? Promise.resolve()).then(run);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(projectBoxId, tail);
    void tail.then(() => {
      if (this.queues.get(projectBoxId) === tail) this.queues.delete(projectBoxId);
    });
    return result;
  }
}

/** A random port in {@link FALLBACK_PORTS} not in `taken`. */
function freePort(taken: ReadonlySet<number>): number {
  for (;;) {
    const port = randomInt(FALLBACK_PORTS.min, FALLBACK_PORTS.max);
    if (!taken.has(port)) return port;
  }
}
