import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  DESKTOP_VNC_STALE_CLOSE_CODE,
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

/** noVNC's `Websock.attach` check, verbatim in spirit (core/websock.js). */
const RAW_CHANNEL_PROPS = ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState"];

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test("exposes every property noVNC's Websock.attach requires", () => {
  const channel = new DesktopVncChannel(new FakeSocket());
  const props = [...Object.keys(channel), ...Object.getOwnPropertyNames(Object.getPrototypeOf(channel))];
  for (const prop of RAW_CHANNEL_PROPS) assert.ok(props.includes(prop), `missing ${prop}`);
});

test("forces arraybuffer and mirrors readyState and protocol", () => {
  const socket = new FakeSocket();
  socket.protocol = "binary";
  const channel = new DesktopVncChannel(socket);
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(channel.readyState, 0);
  assert.equal(channel.protocol, "binary");
  socket.open();
  assert.equal(channel.readyState, 1);
  channel.close();
});

test("binary frames reach noVNC unchanged", () => {
  const socket = new FakeSocket();
  const channel = new DesktopVncChannel(socket);
  const received: MessageEvent[] = [];
  channel.onmessage = (ev) => received.push(ev);
  socket.open();
  const bytes = new Uint8Array([82, 70, 66, 32]).buffer;
  socket.message(bytes);
  assert.equal(received.length, 1);
  assert.equal(received[0].data, bytes);
  channel.close();
});

test("text frames are consumed as control messages and a pong yields an RTT sample", () => {
  const c = clock();
  const socket = new FakeSocket();
  const samples: number[] = [];
  const channel = new DesktopVncChannel(socket, { now: c.now, onRtt: (ms) => samples.push(ms) });
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
    const channel = new DesktopVncChannel(socket, { now: c.now, pingIntervalMs: 2000 });
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
    new DesktopVncChannel(socket, { now: c.now, pingIntervalMs: 2000, staleAfterMs: 5000 });
    socket.open();
    for (let i = 0; i < 3; i++) {
      c.advance(2000);
      mock.timers.tick(2000);
    }
    assert.equal(socket.closed?.code, DESKTOP_VNC_STALE_CLOSE_CODE);
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
