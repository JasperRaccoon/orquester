import assert from "node:assert/strict";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { after, before, test } from "node:test";

import { WebSocket } from "ws";

import { VphoneBridge } from "./bridge.ts";
import { DeviceThumbnails } from "../../thumbnails.ts";
import { VphoneGuestClient } from "./guest-client.ts";
import { avccDemux, FIXTURE_AVCC, FIXTURE_DELTA_AU, FIXTURE_JPEG, FIXTURE_KEY_AU, startFakeVphoned, type FakeVphoned } from "./testing.ts";

const GUEST_TOKEN = "guest-token-0123456789abcdef";
const BRIDGE_TOKEN = "bridge-token-0123456789abcdef";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
// serve-sim input protocol bytes, independent of the bridge implementation.
const SERVE_SIM_TAG = { touch: 0x03, button: 0x04, key: 0x06, orientation: 0x07, screenConfig: 0x82, inputAdmitted: 0x83 };

let vphoned: FakeVphoned;
let bridge: VphoneBridge;
let origin: string;

before(async () => {
  vphoned = await startFakeVphoned({
    token: GUEST_TOKEN,
    rpc: {
      "screen.screenshot": { mime_type: "image/jpeg", width: 1290, height: 2796, data: FIXTURE_JPEG.toString("base64") },
      "input.touch": (params: Record<string, unknown>) => ({ phase: params.phase }),
      "input.button": {},
      "input.hid": {},
      "input.type": {}
    }
  });
  const client = new VphoneGuestClient({ port: vphoned.port, token: GUEST_TOKEN });
  bridge = new VphoneBridge({
    token: BRIDGE_TOKEN,
    device: (id) => (id === "orq-lease1" ? { client, screen: { width: 402, height: 874 } } : null),
    logger: quiet
  });
  origin = await bridge.start();
});

after(async () => {
  await bridge.close();
  await vphoned.close();
});

/** GET a bridge stream and read until `enough(bytes)`; then hang up. */
function readStream(path: string, enough: (bytes: Buffer) => boolean, headers: Record<string, string> = { authorization: `Bearer ${BRIDGE_TOKEN}` }): Promise<{ status: number; type: string | undefined; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { headers }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      const done = () => {
        response.destroy();
        resolve({ status: response.statusCode ?? 0, type: response.headers["content-type"], bytes: Buffer.concat(chunks) });
      };
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (enough(Buffer.concat(chunks))) done();
      });
      response.on("end", done);
    });
    req.on("error", reject);
    req.end();
  });
}

test("stream.avcc: vphone frames arrive as serve-sim envelopes the panel decodes", async () => {
  const before = vphoned.screenRequests.length;
  const { status, type, bytes } = await readStream("/vendor/serve-sim/helper/orq-lease1/stream.avcc", (data) => avccDemux(data).chunks.length >= 3);
  assert.equal(status, 200);
  assert.equal(type, "application/octet-stream");
  const { chunks } = avccDemux(bytes);
  assert.equal(chunks[0]!.type, "description");
  assert.deepEqual(Buffer.from(chunks[0]!.payload), FIXTURE_AVCC);
  assert.equal(chunks[1]!.type, "keyframe");
  assert.deepEqual(Buffer.from(chunks[1]!.payload), FIXTURE_KEY_AU);
  assert.equal(chunks[2]!.type, "delta");
  assert.deepEqual(Buffer.from(chunks[2]!.payload), FIXTURE_DELTA_AU);
  const first = vphoned.screenRequests[before]!;
  assert.deepEqual({ codec: first.codec, box: first.box, key: first.key }, { codec: "h264", box: [1600, 1600], key: true });
  assert.ok(typeof first.bitrate === "number" && (first.bitrate as number) > 0);
  assert.equal(vphoned.screenRequests[before + 1]?.key, false);
  assert.deepEqual(vphoned.originRefusals, [], "never an Origin header to vphoned");
  assert.ok(vphoned.heads.every((head) => head.origin === undefined));
});

test("stream.mjpeg: screenshots as multipart parts", async () => {
  const part = Buffer.concat([
    Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${FIXTURE_JPEG.length}\r\n\r\n`),
    FIXTURE_JPEG,
    Buffer.from("\r\n")
  ]);
  const { status, type, bytes } = await readStream("/vendor/serve-sim/helper/orq-lease1/stream.mjpeg", (data) => data.length >= part.length);
  assert.equal(status, 200);
  assert.equal(type, "multipart/x-mixed-replace; boundary=frame");
  assert.deepEqual(bytes.subarray(0, part.length), part);
});

test("POST /vendor/serve-sim/api/screenshot?device=: one JPEG of that device (the fleet thumbnail)", async () => {
  const post = (path: string, headers: Record<string, string> = { authorization: `Bearer ${BRIDGE_TOKEN}` }, method = "POST") =>
    fetch(`${origin}${path}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
  const shot = await post("/vendor/serve-sim/api/screenshot?device=orq-lease1");
  assert.equal(shot.status, 200);
  assert.equal(shot.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await shot.arrayBuffer()), FIXTURE_JPEG);
  assert.equal((await post("/vendor/serve-sim/api/screenshot")).status, 400, "serve-sim's first-booted fallback is never taken");
  assert.equal((await post("/vendor/serve-sim/api/screenshot?device=orq-other")).status, 404);
  assert.equal((await post("/vendor/serve-sim/api/screenshot?device=orq-lease1", {})).status, 401);
  assert.equal((await post("/vendor/serve-sim/api/screenshot?device=orq-lease1", { authorization: `Bearer ${BRIDGE_TOKEN}` }, "GET")).status, 405);

  // The daemon's lease thumbnail route captures a research iPhone the same way (its hub is this bridge).
  const thumbnails = new DeviceThumbnails({ now: () => 0 });
  const thumb = await thumbnails.get("lease1", { origin, token: BRIDGE_TOKEN, streamKind: "serve-sim", deviceParam: "orq-lease1" }, 320);
  assert.deepEqual(thumb, FIXTURE_JPEG);
});

test("every bridge request needs the bridge token; unknown devices and paths are 404", async () => {
  assert.equal((await readStream("/vendor/serve-sim/helper/orq-lease1/stream.avcc", () => true, {})).status, 401);
  assert.equal((await readStream("/vendor/serve-sim/helper/orq-lease1/stream.avcc", () => true, { authorization: `Bearer ${GUEST_TOKEN}` })).status, 401);
  assert.equal((await readStream("/vendor/serve-sim/helper/orq-other/stream.avcc", () => true)).status, 404);
  assert.equal((await readStream("/api/devices", () => true)).status, 404);
  const websocketStatus = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${origin.replace("http", "ws")}/vendor/serve-sim/helper/ws?device=orq-lease1`);
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode!);
      ws.terminate();
    });
    ws.on("open", () => { ws.close(); reject(new Error("An unauthenticated socket was admitted")); });
    ws.on("error", reject);
  });
  assert.equal(websocketStatus, 401);
});

test("the input socket admits, sends the screen config, and relays touches, buttons, keys and text in order", async () => {
  const before = vphoned.calls.length;
  const ws = new WebSocket(`${origin.replace("http", "ws")}/vendor/serve-sim/helper/ws?device=orq-lease1`, {
    headers: { authorization: `Bearer ${BRIDGE_TOKEN}`, origin },
    perMessageDeflate: false
  });
  const received: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on("message", (data: Buffer) => {
      received.push(data);
      if (received.length === 2) resolve();
    });
    ws.on("error", reject);
  });
  assert.deepEqual([...received[0]!], [SERVE_SIM_TAG.inputAdmitted]);
  assert.equal(received[1]![0], SERVE_SIM_TAG.screenConfig);
  assert.deepEqual(JSON.parse(received[1]!.subarray(1).toString()), { width: 402, height: 874, orientation: "portrait" });

  const send = (tag: number, payload: unknown) => ws.send(Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
  send(SERVE_SIM_TAG.touch, { type: "begin", x: 0.5, y: 0.25 });
  for (let i = 1; i <= 5; i++) send(SERVE_SIM_TAG.touch, { type: "move", x: 0.5, y: 0.25 + i * 0.05 });
  send(SERVE_SIM_TAG.touch, { type: "end", x: 0.5, y: 0.5 });
  send(SERVE_SIM_TAG.touch, { type: "end", x: 1.4, y: -1 });
  send(SERVE_SIM_TAG.touch, { type: "tap", x: 0, y: 0 });
  send(SERVE_SIM_TAG.button, { button: "siri" });
  send(SERVE_SIM_TAG.key, { type: "down", usage: 70000 });
  send(SERVE_SIM_TAG.orientation, { orientation: "landscape_left" });
  send(SERVE_SIM_TAG.button, { button: "home" });
  send(SERVE_SIM_TAG.button, { button: "app_switcher" });
  send(SERVE_SIM_TAG.button, { button: "lock" });
  send(SERVE_SIM_TAG.key, { type: "down", usage: 4 });
  send(SERVE_SIM_TAG.key, { type: "up", usage: 4 });
  ws.send(JSON.stringify({ type: "text", text: "hello" }));

  await vphoned.waitForCall("input.type", before);
  ws.close();
  const calls = vphoned.calls.slice(before);
  assert.ok(calls.every((call) => call.via === "ws"));
  const touches = calls.filter((call) => call.method === "input.touch");
  assert.deepEqual(touches[0]!.params, { phase: "down", x: 0.5, y: 0.25, normalized: true });
  assert.deepEqual(touches.at(-1)!.params, { phase: "up", x: 1, y: 0, normalized: true });
  assert.ok(touches.some((call) => call.params.phase === "move"));
  assert.ok(touches.some((call) => call.params.phase === "up" && call.params.x === 0.5 && call.params.y === 0.5));
  assert.deepEqual(
    calls.filter((call) => call.method !== "input.touch").map((call) => [call.method, call.params]),
    [
      ["input.button", { name: "home" }],
      ["input.button", { name: "home" }],
      ["input.button", { name: "home" }],
      ["input.button", { name: "power" }],
      ["input.hid", { page: 7, usage: 4, down: true }],
      ["input.hid", { page: 7, usage: 4, down: false }],
      ["input.type", { text: "hello" }]
    ]
  );
  // Strictly in order: every touch before the button.
  assert.ok(calls.findIndex((call) => call.method === "input.button") > calls.map((call) => call.method).lastIndexOf("input.touch"));
  assert.deepEqual(vphoned.originRefusals, []);
});
