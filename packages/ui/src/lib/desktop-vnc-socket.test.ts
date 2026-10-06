import test, { afterEach, mock } from "node:test";
import assert from "node:assert/strict";

import {
  DesktopVncChannel,
  type VncRawSocket
} from "./desktop-vnc-socket.ts";

class FakeSocket implements VncRawSocket {
  readyState = 0;
  protocol = "";
  binaryType: BinaryType = "blob";
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;

  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({ type: "open" } as Event);
  }
  message(data: unknown): void {
    this.onmessage?.({ type: "message", data } as MessageEvent);
  }
}

afterEach(() => mock.restoreAll());

function clock(start = 1000) {
  let t = start;
  mock.method(performance, "now", () => t);
  return { advance: (ms: number) => { t += ms; } };
}

test("noVNC attaches the channel and receives RFB bytes", async () => {
  const globals = globalThis as Record<string, unknown>;
  const originals = ["window", "WebSocket"].map((key) => [key, Object.getOwnPropertyDescriptor(globals, key)] as const);
  globals.window = { console };
  globals.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  const socket = new FakeSocket();
  const channel = new DesktopVncChannel(socket);
  try {
    // Resolve beside the installed RFB entry point: its channel consumer owns this ABI.
    const { default: Websock } = await import(new URL("./websock.js", import.meta.resolve("@novnc/novnc")).href);
    const receiver = new Websock();
    receiver.attach(channel);
    assert.equal(receiver.readyState, "connecting");
    socket.message(new Uint8Array([82, 70, 66, 32]).buffer);
    assert.equal(receiver.rQshiftStr(4), "RFB ");
  } finally {
    channel.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globals, key, descriptor);
      else delete globals[key];
    }
  }
});

test("forces arraybuffer and mirrors readyState and protocol", () => {
  const socket = new FakeSocket();
  socket.protocol = "binary";
  const channel = new DesktopVncChannel(socket);
  assert.equal(channel.binaryType, "arraybuffer");
  assert.equal(channel.readyState, 0);
  assert.equal(channel.protocol, "binary");
  socket.open();
  assert.equal(channel.readyState, 1);
  channel.close();
});

test("text frames are consumed as control messages and a pong yields an RTT sample", () => {
  const c = clock();
  const socket = new FakeSocket();
  const samples: number[] = [];
  const channel = new DesktopVncChannel(socket, { onRtt: (ms) => samples.push(ms) });
  const received: MessageEvent[] = [];
  channel.onmessage = (ev) => received.push(ev);
  socket.open();
  const ping = JSON.parse(String(socket.sent[0])) as { type: string; t: number };
  assert.equal(ping.type, "ping");
  c.advance(42);
  socket.message(JSON.stringify({ type: "pong", t: ping.t }));
  socket.message("not json");
  socket.message(JSON.stringify({ type: "hello" }));
  assert.deepEqual(samples, [42]);
  assert.equal(channel.lastRttMs, 42);
  assert.equal(received.length, 0);
  channel.close();
});

test("pings every interval while open and stops after close", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const c = clock();
    const socket = new FakeSocket();
    const channel = new DesktopVncChannel(socket);
    mock.timers.tick(5000);
    assert.equal(socket.sent.length, 0, "no pings before open");
    socket.open();
    assert.equal(socket.sent.length, 1, "an immediate ping on open");
    socket.message(new ArrayBuffer(1)); // keep the link fresh
    c.advance(2000);
    mock.timers.tick(2000);
    assert.equal(socket.sent.length, 2);
    channel.close();
    mock.timers.tick(10_000);
    assert.equal(socket.sent.length, 2);
  } finally {
    mock.timers.reset();
  }
});

test("a silent link is closed so the viewer reconnects", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const c = clock();
    const socket = new FakeSocket();
    new DesktopVncChannel(socket);
    socket.open();
    for (let i = 0; i < 11; i++) {
      c.advance(2000);
      mock.timers.tick(2000);
    }
    assert.equal(socket.closed?.code, 4000);
  } finally {
    mock.timers.reset();
  }
});

test("open, close and error reach noVNC's handlers", () => {
  const socket = new FakeSocket();
  const channel = new DesktopVncChannel(socket);
  const seen: string[] = [];
  channel.onopen = () => seen.push("open");
  channel.onerror = () => seen.push("error");
  channel.onclose = (ev) => seen.push(`close:${ev.code}`);
  socket.open();
  socket.onerror?.({ type: "error" } as Event);
  socket.onclose?.({ type: "close", code: 1011 } as CloseEvent);
  assert.deepEqual(seen, ["open", "error", "close:1011"]);
  channel.send(new Uint8Array([1]));
  assert.ok(socket.sent.some((d) => d instanceof Uint8Array));
});
