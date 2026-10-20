/**
 * Agent host — one `BoxConnection` per box, over the box's local relay socket
 * (`connectBoxRelay(socketPath, { boxId })`, `boxes/client/`; spec 2026-10-19
 * §8.5). A connection object stays valid across reconnects (the relay
 * reconnects itself after a daemon restart), so it is opened once per box and
 * shared by every thread, probe and checkpoint that runs there.
 *
 * The connector is injected: production passes `connectBoxRelay` (statically
 * imported by `main.ts`), tests pass `localBoxConnection()`.
 */

import type { BoxConnection } from "../../boxes/contracts.ts";
import type { HostThreadBox } from "../host-protocol.ts";
import { BoxLaunchError } from "./errors.ts";

export type BoxConnector = (socketPath: string, options: { boxId: string }) => BoxConnection | Promise<BoxConnection>;

/** How long a launch waits for a box that is reconnecting before it fails with a clear message. */
export const BOX_CONNECT_DEADLINE_MS = 60_000;

/** Resolves once `connection` is connected; rejects at the deadline or on abort. */
export function waitBoxConnected(
  connection: BoxConnection,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  if (connection.connected) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const done = (fn: () => void): void => {
      clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(
      () =>
        done(() =>
          reject(
            new BoxLaunchError(
              "BOX_NOT_CONNECTED",
              "The project's box is not connected right now (it may be restarting or unreachable). Try again once its row in the sidebar shows it ready."
            )
          )
        ),
      options.timeoutMs ?? BOX_CONNECT_DEADLINE_MS
    );
    const onAbort = (): void => done(() => reject(new BoxLaunchError("BOX_NOT_CONNECTED", "Stopped waiting for the box to connect.")));
    unsubscribe = connection.onStatus((connected) => {
      if (connected) done(resolve);
    });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (connection.connected) done(resolve);
  });
}

export class BoxConnectionPool {
  private readonly entries = new Map<string, Promise<BoxConnection>>();

  constructor(private readonly connector: BoxConnector | null) {}

  /** The box's connection, opened on first use, connected (or a {@link BoxLaunchError}). */
  async get(box: Pick<HostThreadBox, "boxId" | "socketPath">, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<BoxConnection> {
    const connection = await this.open(box);
    await waitBoxConnected(connection, options);
    return connection;
  }

  /** The connection, connected or not (a reattach waits for the link itself). */
  open(box: Pick<HostThreadBox, "boxId" | "socketPath">): Promise<BoxConnection> {
    const connector = this.connector;
    if (connector === null) {
      return Promise.reject(
        new BoxLaunchError("BOX_UNAVAILABLE", "This agent host cannot reach boxes yet. It picks that up when it restarts after the next Orquester update.")
      );
    }
    let entry = this.entries.get(box.boxId);
    if (entry === undefined) {
      entry = Promise.resolve()
        .then(() => connector(box.socketPath, { boxId: box.boxId }))
        .catch((error: unknown) => {
          throw new BoxLaunchError(
            "BOX_UNAVAILABLE",
            `Could not reach the project's box: ${error instanceof Error ? error.message : String(error)}`
          );
        });
      this.entries.set(box.boxId, entry);
      entry.catch(() => {
        if (this.entries.get(box.boxId) === entry) this.entries.delete(box.boxId);
      });
    }
    return entry;
  }

  /** Already-opened connections, for the host's teardown. */
  opened(): Promise<BoxConnection[]> {
    return Promise.all([...this.entries.values()].map((entry) => entry.catch(() => null))).then((list) =>
      list.filter((connection): connection is BoxConnection => connection !== null)
    );
  }
}
