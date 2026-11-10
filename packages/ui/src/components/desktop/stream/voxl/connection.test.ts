import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { openVoxlConnection, type VoxlConnectionEvent } from "./connection.ts";

/** The page's WebSocket, driven by the test. */
class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  binaryType = "blob";
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  fire(type: "open" | "message", event: unknown = {}): void {
    if (type === "open") this.readyState = FakeSocket.OPEN;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A connection on a fake socket and a mocked clock: `advance(ms)` moves both the clock and the timers. */
function harness(t: TestContext) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });
  let clock = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const events: VoxlConnectionEvent[] = [];
  const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
  const handle = openVoxlConnection("wss://example.invalid/ws-desktop-voxl/d", canvas, (event) => events.push(event));
  t.after(() => handle.close());
  const socket = FakeSocket.last!;
  return {
    socket,
    closed: () => events.filter((event) => event.t === "closed"),
    advance: (ms: number) => {
      clock += ms;
      t.mock.timers.tick(ms);
    }
  };
}

test("before voxl's hello the connection waits out the daemon's start of voxl; after it, 10 s of silence closes it", (t) => {
  const h = harness(t);
  h.socket.fire("open");
  // The relay holds the socket while the daemon checks for and starts voxl (up to 30 s + 10 s).
  h.advance(40_000);
  assert.deepEqual(h.closed(), []);
  h.socket.fire("message", { data: '{"t":"hello","w":800,"h":600}' });
  h.advance(9_000);
  assert.deepEqual(h.closed(), []);
  h.advance(2_000);
  assert.deepEqual(h.closed(), [{ t: "closed", reason: "The stream went silent" }]);
});
