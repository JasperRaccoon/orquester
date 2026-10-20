/**
 * Test helpers for the hub: an in-memory `BoxRecordStore`, a Fastify app
 * serving the hub routes on an ephemeral loopback port, and a scripted fake
 * box over a real WebSocket.
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";

import websocketPlugin from "@fastify/websocket";
import { boxRoutes, parseControlMessage, type BoxControlMessage, type BoxHello, type BoxSysInfo } from "@orquester/api";
import type { StoredBox } from "@orquester/config";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";

import { localSysInfo } from "../testing.ts";
import type { BoxRecordStore } from "./hub.ts";
import { registerBoxHubRoutes } from "./routes.ts";
import type { BoxHubServer } from "./hub.ts";

export class MemoryRecords implements BoxRecordStore {
  readonly records = new Map<string, StoredBox>();
  private chain: Promise<unknown> = Promise.resolve();

  add(id: string, extra: Partial<StoredBox> = {}): StoredBox {
    const record: StoredBox = {
      id,
      purpose: "temporary",
      kind: "linux",
      provider: "hetzner",
      region: "fsn1",
      size: "cx22",
      name: `orq-${id}`,
      createdAt: new Date().toISOString(),
      state: "provisioning",
      ...extra
    };
    this.records.set(id, record);
    return record;
  }

  get(id: string): StoredBox | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  update(id: string, mutate: (record: StoredBox) => void): Promise<StoredBox> {
    const next = this.chain.then(() => {
      const record = this.records.get(id);
      if (!record) throw new Error(`no record ${id}`);
      const copy = structuredClone(record);
      mutate(copy);
      this.records.set(id, copy);
      return structuredClone(copy);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

export async function startHubServer(hub: BoxHubServer): Promise<{ app: FastifyInstance; url: string; port: number }> {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  registerBoxHubRoutes(app, hub);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, url: `http://127.0.0.1:${port}`, port };
}

/** A fake box: a WebSocket client speaking the protocol by hand. */
export class FakeBox {
  readonly socket: WebSocket;
  private readonly queue: BoxControlMessage[] = [];
  private waiters: ((message: BoxControlMessage) => void)[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = parseControlMessage(data.toString("utf8"));
      if (!message) return;
      if (message.t === "ping") {
        socket.send(JSON.stringify({ t: "pong", id: message.id }));
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queue.push(message);
    });
    this.closed = new Promise((resolve) => {
      socket.once("close", (code: number) => {
        this.closeCode = code;
        resolve(code);
      });
    });
  }

  static async connect(baseUrl: string): Promise<FakeBox> {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}${boxRoutes.connect}`);
    await once(socket, "open");
    return new FakeBox(socket);
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  hello(auth: BoxHello["auth"], overrides: Partial<BoxHello> = {}, sys: Partial<BoxSysInfo> = {}): void {
    const hello: BoxHello = { t: "hello", protocol: 1, agentVersion: "test", auth, sys: localSysInfo(sys), procs: [], ...overrides };
    this.send(hello);
  }

  next(): Promise<BoxControlMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  close(): void {
    this.socket.close();
  }
}
