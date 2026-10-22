import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { WsSessionChannel } from "./ws-session-channel";

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  receive(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const realWebSocket = globalThis.WebSocket;
before(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
});
after(() => {
  (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
});

function connect() {
  const channel = new WsSessionChannel("ws://daemon/ws");
  const socket = FakeWebSocket.last!;
  socket.open();
  const calls: string[] = [];
  return { channel, socket, calls };
}

test("a replay frame goes to onReplay, live output to onData", () => {
  const { channel, socket, calls } = connect();
  channel.openOutput("s", {
    onData: (chunk) => calls.push(`data:${chunk}`),
    onReplay: (chunk) => calls.push(`replay:${chunk}`),
    onEnd: () => calls.push("end")
  });
  assert.deepEqual(socket.sent, [{ t: "sub", id: "s" }]);
  socket.receive({ t: "out", id: "s", data: "SNAP", replay: true });
  socket.receive({ t: "out", id: "s", data: "live" });
  socket.receive({ t: "end", id: "s" });
  assert.deepEqual(calls, ["replay:SNAP", "data:live", "end"]);
});

test("a replay falls back to onData for a consumer without onReplay", () => {
  const { channel, socket, calls } = connect();
  channel.openOutput("s", { onData: (chunk) => calls.push(`data:${chunk}`), onEnd: () => {} });
  socket.receive({ t: "out", id: "s", data: "SNAP", replay: true });
  assert.deepEqual(calls, ["data:SNAP"]);
});

test("a server reset clears that terminal only", () => {
  const { channel, socket, calls } = connect();
  channel.openOutput("a", { onData: () => {}, onEnd: () => {}, onReset: () => calls.push("reset:a") });
  channel.openOutput("b", { onData: () => {}, onEnd: () => {}, onReset: () => calls.push("reset:b") });
  socket.receive({ t: "reset", id: "b" });
  socket.receive({ t: "reset", id: "unknown" });
  assert.deepEqual(calls, ["reset:b"]);
});
