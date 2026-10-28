/**
 * Test doubles for the temporary-box backend: an in-memory {@link TemporaryBoxes} (records and
 * change events, no provider), a manual clock whose timers fire only when a test says so, a box
 * summary builder, and a hub that plays a project box's forwards on this machine.
 */

import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";

import type { BoxChannelSpec, BoxDestroyedReason, BoxForwardSpec, BoxSummary } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxChannelHandler, BoxConnection, BoxForwardOutcome, BoxHub } from "../contracts.ts";
import type { LocalBoxConnection } from "../testing.ts";
import type { CreateTemporaryBoxInput, TemporaryBoxes } from "./contract.ts";
import type { TemporaryBoxClock } from "./tools.ts";

export function boxSummary(overrides: Partial<BoxSummary> = {}): BoxSummary {
  return {
    id: "box-1",
    purpose: "temporary",
    kind: "linux",
    provider: "hetzner",
    providerLabel: "Hetzner",
    region: "fsn1",
    regionLabel: "Falkenstein",
    size: "cx22",
    sizeLabel: "CX22",
    image: null,
    os: "linux",
    arch: "x64",
    state: "ready",
    stateReason: null,
    destroyedReason: null,
    hourlyUsd: 0.006,
    estimatedCostUsd: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    readyAt: "2026-10-20T00:01:00.000Z",
    deadlineAt: "2026-10-20T02:00:00.000Z",
    destroyedAt: null,
    connected: true,
    lastSeenAt: null,
    project: null,
    threadId: "chat-a",
    purposeNote: "test",
    setup: [],
    ...overrides
  };
}

/** The box service, in memory: `createTemporaryBox` records a `provisioning` box; `update` moves it. */
export class FakeTemporaryBoxes implements TemporaryBoxes {
  readonly boxes = new Map<string, BoxSummary>();
  readonly created: CreateTemporaryBoxInput[] = [];
  readonly destroyed: { boxId: string; reason: BoxDestroyedReason }[] = [];
  private readonly listeners = new Set<(boxId: string) => void>();
  private next = 0;
  /** Set to make the next create fail with this error. */
  createError: Error | null = null;
  /** Runs inside `createTemporaryBox` before it resolves (to race a chat close). */
  onCreate: (() => void) | null = null;

  add(box: BoxSummary): this {
    this.boxes.set(box.id, box);
    return this;
  }

  update(boxId: string, patch: Partial<BoxSummary>): void {
    const box = this.boxes.get(boxId);
    if (!box) throw new Error(`no box ${boxId}`);
    this.boxes.set(boxId, { ...box, ...patch });
    this.emit(boxId);
  }

  async createTemporaryBox(input: CreateTemporaryBoxInput): Promise<BoxSummary> {
    if (this.createError) throw this.createError;
    this.created.push(input);
    const box = boxSummary({
      id: `tmp-${(this.next += 1)}`,
      kind: input.kind,
      provider: input.provider ?? "hetzner",
      region: input.region ?? "fsn1",
      size: input.size ?? "cx22",
      state: "provisioning",
      connected: false,
      os: null,
      arch: null,
      readyAt: null,
      threadId: input.threadId,
      purposeNote: input.purposeNote
    });
    this.boxes.set(box.id, box);
    this.onCreate?.();
    this.emit(box.id);
    return box;
  }

  async destroyBox(boxId: string, reason: BoxDestroyedReason): Promise<void> {
    this.destroyed.push({ boxId, reason });
    if (this.boxes.has(boxId)) this.update(boxId, { state: "destroyed", destroyedReason: reason, connected: false });
  }

  list(): BoxSummary[] {
    return [...this.boxes.values()];
  }

  get(boxId: string): BoxSummary | undefined {
    return this.boxes.get(boxId);
  }

  onChange(listener: (boxId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(boxId: string): void {
    for (const listener of [...this.listeners]) listener(boxId);
  }
}

/** Timers fire only through {@link fire} / {@link advance}; `now` moves only with `advance`. */
export class ManualClock implements TemporaryBoxClock {
  private time = 1_000_000;
  private id = 0;
  private readonly timers = new Map<number, { fn: () => void; at: number; ms: number }>();

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): unknown {
    this.id += 1;
    this.timers.set(this.id, { fn, at: this.time + ms, ms });
    return this.id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Pending timers' delays, in set order. */
  pending(): number[] {
    return [...this.timers.values()].map((timer) => timer.ms);
  }

  /** Move time on and run every timer now due. */
  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.time && this.timers.has(id)) {
        this.timers.delete(id);
        timer.fn();
      }
    }
  }

  /** Run the pending timers set with delay `ms` (without moving time). */
  fire(ms: number): number {
    let fired = 0;
    for (const [id, timer] of [...this.timers]) {
      if (timer.ms === ms && this.timers.has(id)) {
        this.timers.delete(id);
        timer.fn();
        fired += 1;
      }
    }
    return fired;
  }
}

/**
 * The hub as a box project's forwards see it, with the project box played on this machine:
 * `setForwards` listens for real on 127.0.0.1 as orq-agent does in the box (a port already listened
 * on is retargeted; a taken one answers `EADDRINUSE`), and each accepted connection goes to the
 * registered `host-tcp` handler as the box's channel would. While `connection` is disconnected the
 * list is only kept (no outcomes). {@link drop} and {@link welcome} play a reconnect.
 */
export class FakeForwardingHub implements Pick<BoxHub, "get" | "setForwards" | "handleChannel" | "onConnectionChange"> {
  /** Every list set, in order. */
  readonly lists: BoxForwardSpec[][] = [];
  /** Ports the box refuses to listen on, with the error code it answers (e.g. Windows' `INTERNAL` for a reserved port). */
  readonly refusing = new Map<number, string>();
  private handler: BoxChannelHandler | null = null;
  private readonly listening = new Map<number, { server: Server; target: string }>();
  private readonly changes = new Set<(boxId: string, connected: boolean) => void>();

  constructor(
    readonly projectBoxId: string,
    readonly connection: LocalBoxConnection
  ) {}

  get(boxId: string): BoxConnection | undefined {
    return boxId === this.projectBoxId ? this.connection : undefined;
  }

  handleChannel(kind: "host-tcp" | "ssh-agent" | "mcp-bridge", handler: BoxChannelHandler): void {
    if (kind === "host-tcp") this.handler = handler;
  }

  onConnectionChange(listener: (boxId: string, connected: boolean) => void): () => void {
    this.changes.add(listener);
    return () => this.changes.delete(listener);
  }

  async setForwards(_boxId: string, next: BoxForwardSpec[], options: { relisten?: boolean } = {}): Promise<BoxForwardOutcome[]> {
    this.lists.push(next.map((spec) => ({ ...spec })));
    if (!this.connection.connected) return [];
    for (const [port, listener] of [...this.listening]) {
      if (next.some((spec) => spec.boxPort === port)) continue;
      // Unlistened at once; connections already accepted go on (as a closed Go listener's do).
      this.listening.delete(port);
      listener.server.close();
    }
    const outcomes: BoxForwardOutcome[] = [];
    for (const spec of next) {
      const existing = this.listening.get(spec.boxPort);
      if (existing?.target === spec.target && options.relisten !== true) continue;
      if (existing) {
        existing.target = spec.target;
        outcomes.push({ boxPort: spec.boxPort, error: null });
        continue;
      }
      outcomes.push({ boxPort: spec.boxPort, error: await this.listen(spec) });
    }
    return outcomes;
  }

  /** The link drops: the box's listeners close with it (orq-agent's belong to their link). */
  drop(): void {
    this.connection.setConnected(false);
    this.close();
    for (const listener of [...this.changes]) listener(this.projectBoxId, false);
  }

  /** The box is back: it listens on the welcome's list (the last one set), telling no one what failed, then the hub says it is connected. */
  async welcome(): Promise<void> {
    this.connection.setConnected(true);
    for (const spec of this.lists.at(-1) ?? []) await this.listen(spec);
    for (const listener of [...this.changes]) listener(this.projectBoxId, true);
  }

  /** A `host-tcp` channel opened by box `boxId` (any box, any target): the socket the box side reads and writes. */
  async openAs(boxId: string, spec: { target: string; boxPort: number }): Promise<Socket> {
    const server = createServer((socket) => {
      server.close();
      this.channel(boxId, { kind: "host-tcp", ...spec }, socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return createConnection((server.address() as AddressInfo).port, "127.0.0.1");
  }

  /** Ports listened on now. */
  ports(): number[] {
    return [...this.listening.keys()];
  }

  /** Stop every listener. */
  close(): void {
    for (const listener of this.listening.values()) listener.server.close();
    this.listening.clear();
  }

  private async listen(spec: BoxForwardSpec): Promise<(Error & { code?: string }) | null> {
    const refused = this.refusing.get(spec.boxPort);
    if (refused !== undefined) return Object.assign(new Error(`listen 127.0.0.1:${spec.boxPort}: refused`), { code: refused });
    const listener: { server: Server; target: string } = {
      server: createServer((socket) => this.channel(this.projectBoxId, { kind: "host-tcp", target: listener.target, boxPort: spec.boxPort }, socket)),
      target: spec.target
    };
    const error = await new Promise<(Error & { code?: string }) | null>((resolve) => {
      listener.server.once("error", resolve);
      listener.server.listen(spec.boxPort, "127.0.0.1", () => resolve(null));
    });
    if (error === null) this.listening.set(spec.boxPort, listener);
    return error;
  }

  private channel(boxId: string, spec: BoxChannelSpec, socket: Socket): void {
    if (!this.handler) {
      socket.destroy();
      return;
    }
    this.handler({ boxId, record: { id: boxId } as StoredBox }, spec, socket);
  }
}
