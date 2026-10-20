/**
 * `connectBoxRelay`: a `BoxConnection` for local processes (the agent host)
 * over the daemon's per-box relay socket (`relay-codec.ts`). It reconnects to
 * the socket on its own (daemon restarts), and mirrors the box's link state:
 * `connected` is true only while both the relay and the box link are up.
 * Requests made meanwhile wait for the link until their timeout.
 *
 * Static imports only: this module runs inside the agent host.
 */

import { createConnection, type Socket } from "node:net";

import { parseControlMessage, type BoxControlMessage } from "@orquester/api";

import type { BoxConnection } from "../contracts.ts";
import { LinkedBoxConnection, type LinkInfo } from "./connection.ts";
import { BoxError, BoxMux } from "./mux.ts";
import {
  RELAY_FRAME_BINARY,
  RELAY_PROTOCOL_VERSION,
  RelayFrameDecoder,
  encodeRelayFrame,
  encodeRelayText,
  parseRelayJson,
  type RelayBoxState,
  type RelayCancel,
  type RelayHello
} from "./relay-codec.ts";

export { BoxError, BOX_DISCONNECTED } from "./mux.ts";
export { LinkedBoxConnection, RemoteBoxProcess } from "./connection.ts";

export interface BoxRelayConnection extends BoxConnection {
  /** Stop reconnecting and drop the socket. */
  close(): void;
}

export interface ConnectBoxRelayOptions {
  boxId: string;
  /** How long the first connect may take (the socket may not exist yet). Default 30 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

const RETRY_MIN_MS = 100;
const RETRY_MAX_MS = 5_000;

function infoOf(state: RelayBoxState): LinkInfo {
  return { sys: state.sys, paths: state.paths, agentVersion: state.agentVersion, procs: state.procs };
}

function isBoxState(value: Record<string, unknown>, boxId: string): value is Record<string, unknown> & RelayBoxState {
  return value.boxId === boxId && typeof value.connected === "boolean" && typeof value.sys === "object" && value.sys !== null && typeof value.paths === "object";
}

class RelayClient {
  connection: LinkedBoxConnection | null = null;
  private readonly socketPath: string;
  private readonly boxId: string;
  private socket: Socket | null = null;
  private mux: BoxMux | null = null;
  private closed = false;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private everConnected = false;
  private firstResult: { resolve: (c: LinkedBoxConnection) => void; reject: (e: Error) => void } | null = null;

  constructor(socketPath: string, boxId: string) {
    this.socketPath = socketPath;
    this.boxId = boxId;
  }

  start(timeoutMs: number, signal?: AbortSignal): Promise<LinkedBoxConnection> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.firstResult = null;
        this.close();
        reject(new BoxError("BOX_RELAY_UNAVAILABLE", `No relay for box ${this.boxId} at ${this.socketPath}`));
      }, timeoutMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        this.firstResult = null;
        this.close();
        reject(new BoxError("ABORTED", "Aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.firstResult = {
        resolve: (connection) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(connection);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      };
      this.dial();
    });
  }

  private dial(): void {
    if (this.closed) return;
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    const decoder = new RelayFrameDecoder();
    let welcomed = false;
    let mux: BoxMux | null = null;
    socket.on("connect", () => {
      const hello: RelayHello = { t: "relay-hello", protocol: RELAY_PROTOCOL_VERSION, boxId: this.boxId };
      socket.write(encodeRelayText(JSON.stringify(hello)));
    });
    socket.on("data", (chunk: Buffer) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.kind === "binary") {
          mux?.receiveBinary(frame.data);
          continue;
        }
        const raw = parseRelayJson(frame.text);
        if (!raw) continue;
        if (!welcomed) {
          if (raw.t === "relay-reject") {
            const error = new BoxError("BOX_RELAY_REJECTED", typeof raw.message === "string" ? raw.message : "Relay refused");
            this.firstResult?.reject(error);
            this.firstResult = null;
            this.close();
            return;
          }
          if (raw.t !== "relay-welcome" || !isBoxState(raw, this.boxId)) {
            socket.destroy();
            return;
          }
          welcomed = true;
          mux = new BoxMux(
            {
              sendText: (text) => socket.write(encodeRelayText(text)),
              sendBinary: (data) => socket.write(encodeRelayFrame(RELAY_FRAME_BINARY, data))
            },
            {
              onEvent: (name, data) => this.connection?.emitEvent(name, data),
              onAbandon: (id) => {
                const cancel: RelayCancel = { t: "relay-cancel", id };
                socket.write(encodeRelayText(JSON.stringify(cancel)));
              }
            }
          );
          this.mux = mux;
          this.retryMs = RETRY_MIN_MS;
          this.onState(mux, raw, true);
          continue;
        }
        if (raw.t === "relay-status") {
          if (isBoxState(raw, this.boxId) && mux) this.onState(mux, raw, false);
          continue;
        }
        const message = parseControlMessage(frame.text);
        if (message && mux) mux.receiveControl(message as BoxControlMessage);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      if (mux) {
        this.connection?.detachLink(mux);
        mux.shutdown();
      }
      if (this.mux === mux) this.mux = null;
      this.scheduleRetry();
    });
  }

  private onState(mux: BoxMux, state: RelayBoxState, fromWelcome: boolean): void {
    const info = infoOf(state);
    if (!this.connection) {
      this.connection = new LinkedBoxConnection(this.boxId, info);
    }
    const connection = this.connection;
    if (state.connected) {
      // A new relay socket means a new daemon (or hub) that knows nothing of
      // our watches/forwards: replay them. Box reconnects are replayed by the hub.
      connection.attachLink(mux, info, { replay: fromWelcome && this.everConnected });
    } else {
      connection.updateInfo(info);
      connection.detachLink(mux);
    }
    if (fromWelcome) {
      this.everConnected = true;
      this.firstResult?.resolve(connection);
      this.firstResult = null;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.dial();
    }, delay);
  }

  /** Stop for good: no more reconnects; waiting requests fail. */
  close(): void {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.connection?.rejectWaiters(new BoxError("BOX_RELAY_CLOSED", "The relay connection was closed"));
  }
}

/** A `BoxConnection` over the daemon's relay socket for `boxId`. */
export async function connectBoxRelay(socketPath: string, options: ConnectBoxRelayOptions): Promise<BoxRelayConnection> {
  const client = new RelayClient(socketPath, options.boxId);
  const connection = await client.start(options.timeoutMs ?? 30_000, options.signal);
  return Object.assign(connection, { close: () => client.close() }) as BoxRelayConnection;
}
