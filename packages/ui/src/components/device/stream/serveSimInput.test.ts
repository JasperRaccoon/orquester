import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { ServeSimInputSocket } from "./serveSimInput.ts";
import { fakeWebSocketClass, browserApis, restoreBrowserApis } from "./testing/fakes.ts";

const URL = "ws://hub.test/vendor/serve-sim/helper/ws?device=UDID&token=t";
const decode = (bytes: string | Uint8Array) => {
  const b = bytes as Uint8Array;
  return [b[0], JSON.parse(new TextDecoder().decode(b.subarray(1)))];
};
const admitted = () => Uint8Array.of(0x83).buffer;
const screen = (config: unknown) => new Uint8Array([0x82, ...new TextEncoder().encode(JSON.stringify(config))]).buffer;

const sockets: ServeSimInputSocket[] = [];
beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  restoreBrowserApis();
  mock.timers.reset();
});

function setup() {
  const ws = fakeWebSocketClass();
  const ready: Array<[boolean, string | undefined]> = [];
  const configs: unknown[] = [];
  const errors: string[] = [];
  browserApis({ WebSocket: ws.WebSocket });
  const input = new ServeSimInputSocket({
    url: URL,
    onReady: (value, reason) => ready.push([value, reason]),
    onScreenConfig: (config) => configs.push(config),
    onError: (error) => errors.push(error.code)
  });
  sockets.push(input);
  return { input, ws, ready, configs, errors, socket: () => ws.instances.at(-1)! };
}

describe("ServeSimInputSocket", () => {
  it("sends nothing until serve-sim admits input, then tagged JSON", () => {
    const t = setup();
    assert.equal(t.socket().url, URL);
    t.socket().serverOpen();
    assert.equal(t.input.sendTouch("begin", 0.5, 0.5), false);
    t.socket().receive(admitted());
    assert.deepEqual(t.ready, [[true, undefined]]);
    t.input.sendTouch("begin", 0.25, 0.75);
    t.input.sendTouch("end", 2, -1);
    t.input.sendButton("app_switcher");
    t.input.sendKey("down", 0x04, "a");
    t.input.sendKey("up", 0x04);
    t.input.sendOrientation("landscape_left");
    assert.deepEqual(t.socket().sent.map(decode), [
      [0x03, { type: "begin", x: 0.25, y: 0.75 }],
      [0x03, { type: "end", x: 1, y: 0 }],
      [0x04, { button: "app_switcher" }],
      [0x06, { type: "down", usage: 4, key: "a" }],
      [0x06, { type: "up", usage: 4 }],
      [0x07, { orientation: "landscape_left" }]
    ]);
  });

  it("exposes the screen config and maps touches into the raw portrait framebuffer when rotated", () => {
    const t = setup();
    t.socket().serverOpen();
    t.socket().receive(admitted());
    t.socket().receive(screen({ width: 1206, height: 2622, orientation: "landscape_left", extra: 1 }));
    assert.deepEqual(t.input.screenConfig, { width: 1206, height: 2622, orientation: "landscape_left" });
    assert.deepEqual(t.configs, [{ width: 1206, height: 2622, orientation: "landscape_left" }]);
    t.input.sendTouch("begin", 0.2, 0.1);
    assert.deepEqual(decode(t.socket().sent.at(-1)!), [0x03, { type: "begin", x: 0.1, y: 0.8 }]);
    for (const [config, point] of [
      [{ width: 100, height: 200, orientation: "landscape_right" }, { x: 0.9, y: 0.2 }],
      [{ width: 100, height: 200, orientation: "portrait_upside_down" }, { x: 0.8, y: 0.9 }],
      [{ width: 200, height: 100, orientation: "landscape_left" }, { x: 0.2, y: 0.1 }]
    ] as const) {
      t.socket().receive(screen(config));
      t.input.sendTouch("begin", 0.2, 0.1);
      assert.deepEqual(decode(t.socket().sent.at(-1)!), [0x03, { type: "begin", ...point }]);
    }
    const valid = t.input.screenConfig;
    for (const invalid of [{ width: 0, height: 10, orientation: "portrait" }, { width: 10, height: 10, orientation: "sideways" }, null]) {
      t.socket().receive(screen(invalid));
      assert.deepEqual(t.input.screenConfig, valid, "an unreadable config cannot corrupt touch mapping");
    }
  });

  it("stops sending while another client holds the simulator's input", () => {
    const t = setup();
    t.socket().serverOpen();
    t.socket().receive(admitted());
    t.socket().receive(screen({ width: 1, height: 2, orientation: "portrait", inputUnavailable: true }));
    assert.equal(t.input.ready, false);
    assert.equal(t.ready.at(-1)?.[0], false);
    assert.equal(t.input.sendButton("home"), false);
  });

  it("types ASCII text as shifted HID keystrokes", () => {
    const t = setup();
    t.socket().serverOpen();
    t.socket().receive(admitted());
    assert.equal(t.input.sendText("A!"), true);
    assert.deepEqual(t.socket().sent.map(decode), [
      [0x06, { type: "down", usage: 0xe1 }],
      [0x06, { type: "down", usage: 0x04 }],
      [0x06, { type: "up", usage: 0x04 }],
      [0x06, { type: "up", usage: 0xe1 }],
      [0x06, { type: "down", usage: 0xe1 }],
      [0x06, { type: "down", usage: 0x1e }],
      [0x06, { type: "up", usage: 0x1e }],
      [0x06, { type: "up", usage: 0xe1 }]
    ]);
    assert.equal(t.input.sendText("é"), false);
  });

  it("reconnects with backoff, waits to be admitted again, and stops on an auth close", () => {
    const t = setup();
    t.socket().serverOpen();
    t.socket().receive(admitted());
    t.socket().serverClose(1006);
    assert.equal(t.ready.at(-1)?.[0], false);
    mock.timers.tick(500);
    assert.equal(t.ws.instances.length, 2);
    t.socket().serverOpen();
    assert.equal(t.input.ready, false);
    t.socket().receive(admitted());
    assert.equal(t.input.ready, true);
    t.socket().serverClose(4401);
    assert.deepEqual(t.errors, ["unauthorized"]);
    mock.timers.tick(60_000);
    assert.equal(t.ws.instances.length, 2);
  });

  it("close() closes the socket and cancels a pending reconnect", () => {
    const t = setup();
    t.socket().serverClose(1006);
    t.input.close();
    mock.timers.tick(60_000);
    assert.equal(t.ws.instances.length, 1);
  });
});
