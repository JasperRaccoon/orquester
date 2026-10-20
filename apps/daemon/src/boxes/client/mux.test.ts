import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BOX_CHANNEL_WINDOW_BYTES,
  BOX_MAX_FRAME_PAYLOAD,
  decodeDataFrame,
  encodeDataFrame,
  parseControlMessage,
  type BoxControlMessage
} from "@orquester/api";

import { LinkedBoxConnection } from "./connection.ts";
import { BoxMux } from "./mux.ts";
import { RELAY_FRAME_BINARY, RELAY_FRAME_TEXT, RelayFrameDecoder, encodeRelayFrame, encodeRelayText } from "./relay-codec.ts";
import { localSysInfo } from "../testing.ts";

/** A mux whose outgoing frames are captured. */
function capture(): { mux: BoxMux; sent: BoxControlMessage[]; data: { channel: number; stream: number; bytes: number }[] } {
  const sent: BoxControlMessage[] = [];
  const data: { channel: number; stream: number; bytes: number }[] = [];
  const mux = new BoxMux(
    {
      sendText: (text) => sent.push(parseControlMessage(text)!),
      sendBinary: (frame) => {
        const decoded = decodeDataFrame(frame);
        data.push({ channel: decoded.channel, stream: decoded.stream, bytes: decoded.payload.byteLength });
      }
    },
    {
      onRequest: async (method, params) => {
        if (method === "echo") return params;
        throw Object.assign(new Error("nope"), { code: "UNKNOWN_METHOD" });
      }
    }
  );
  return { mux, sent, data };
}

test("relay frames survive arbitrary chunking", () => {
  const frames = Buffer.concat([
    encodeRelayText('{"t":"ping","id":1}'),
    encodeRelayFrame(RELAY_FRAME_BINARY, encodeDataFrame(2, 1, Buffer.from("payload"))),
    encodeRelayFrame(RELAY_FRAME_TEXT, Buffer.alloc(0))
  ]);
  const decoder = new RelayFrameDecoder();
  const out = [];
  for (let i = 0; i < frames.length; i += 3) out.push(...decoder.push(frames.subarray(i, i + 3)));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { kind: "text", text: '{"t":"ping","id":1}' });
  assert.equal(out[1]!.kind, "binary");
  const decoded = decodeDataFrame((out[1] as { data: Uint8Array }).data);
  assert.equal(Buffer.from(decoded.payload).toString(), "payload");
  assert.deepEqual(out[2], { kind: "text", text: "" });
  assert.throws(() => new RelayFrameDecoder().push(Buffer.from([0, 0, 0, 1, 7, 0])), /kind/);
});

test("requests: ids, results, errors, timeouts; peer requests are served", async () => {
  const { mux, sent } = capture();
  const answer = mux.request("fs.stat", { path: "/x" }, { timeoutMs: 5_000 });
  const req = sent.at(-1) as Extract<BoxControlMessage, { t: "req" }>;
  assert.deepEqual(req, { t: "req", id: 1, method: "fs.stat", params: { path: "/x" } });
  mux.receiveControl({ t: "res", id: 1, ok: true, result: { kind: "dir" } });
  assert.deepEqual(await answer, { kind: "dir" });

  const failing = mux.request("fs.rm", {}, { timeoutMs: 5_000 });
  mux.receiveControl({ t: "res", id: 2, ok: false, error: { code: "ENOENT", message: "gone" } });
  await assert.rejects(failing, { code: "ENOENT", message: "gone" });

  await assert.rejects(mux.request("slow", {}, { timeoutMs: 5 }), { code: "TIMEOUT" });

  mux.receiveControl({ t: "req", id: 9, method: "echo", params: { a: 1 } });
  mux.receiveControl({ t: "req", id: 10, method: "other", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent.filter((m) => m.t === "res"), [
    { t: "res", id: 9, ok: true, result: { a: 1 } },
    { t: "res", id: 10, ok: false, error: { code: "UNKNOWN_METHOD", message: "nope" } }
  ]);

  const pending = mux.request("x", {}, { timeoutMs: 5_000 });
  mux.shutdown();
  await assert.rejects(pending, { code: "BOX_DISCONNECTED" });
  await assert.rejects(mux.request("y", {}, { timeoutMs: 5_000 }), { code: "BOX_DISCONNECTED" });
});

test("channels: even ids, credit window, frame size, credit return", async () => {
  const { mux, sent, data } = capture();
  const channel = mux.open({ kind: "tcp", port: 80 });
  assert.equal(channel.id, 2);
  assert.equal(mux.open({ kind: "tcp", port: 81 }).id, 4);
  mux.receiveControl({ t: "opened", ch: 2 });
  await channel.opened;

  // Sending more than the window stops at the window until credit arrives.
  const total = BOX_CHANNEL_WINDOW_BYTES + 100_000;
  const sending = channel.send(0, new Uint8Array(total));
  await new Promise((resolve) => setImmediate(resolve));
  const sentBytes = (): number => data.filter((d) => d.channel === 2).reduce((sum, d) => sum + d.bytes, 0);
  assert.equal(sentBytes(), BOX_CHANNEL_WINDOW_BYTES);
  assert.ok(data.every((d) => d.bytes <= BOX_MAX_FRAME_PAYLOAD));
  mux.receiveControl({ t: "credit", ch: 2, bytes: 100_000 });
  await sending;
  assert.equal(sentBytes(), total);

  // Inbound bytes are acknowledged once consumed.
  const got: number[] = [];
  channel.onData = (_stream, chunk) => got.push(chunk.byteLength);
  mux.receiveBinary(encodeDataFrame(2, 1, new Uint8Array(70_000)));
  channel.consumed(70_000);
  assert.deepEqual(got, [70_000]);
  assert.deepEqual(sent.at(-1), { t: "credit", ch: 2, bytes: 70_000 });

  let closedWith: unknown = "open";
  channel.onClose = (error) => (closedWith = error);
  mux.receiveControl({ t: "close", ch: 2, error: { code: "ENOSPC", message: "full" } });
  assert.equal((closedWith as { code: string }).code, "ENOSPC");
  // Data for a closed id is dropped.
  mux.receiveBinary(encodeDataFrame(2, 1, new Uint8Array(1)));
  assert.deepEqual(got, [70_000]);
});

test("box-opened channels: refused without a handler, odd ids only", () => {
  const { mux, sent } = capture();
  mux.receiveControl({ t: "open", ch: 1, spec: { kind: "ssh-agent" } });
  assert.deepEqual(sent.at(-1), { t: "open-failed", ch: 1, error: { code: "UNKNOWN_CHANNEL", message: "No handler for ssh-agent channels" } });
  mux.receiveControl({ t: "open", ch: 2, spec: { kind: "ssh-agent" } });
  assert.equal((sent.at(-1) as { error: { code: string } }).error.code, "BAD_CHANNEL");
});

test("LinkedBoxConnection: requests wait for a link until their timeout", async () => {
  const connection = new LinkedBoxConnection("b1", { sys: localSysInfo(), paths: { kind: "identity" }, agentVersion: "v", procs: [] });
  assert.equal(connection.connected, false);
  await assert.rejects(connection.request("sys.info", {}, { timeoutMs: 10 }), { code: "BOX_DISCONNECTED" });

  const { mux, sent } = capture();
  const waiting = connection.request("fs.realpath", { path: "/a" }, { timeoutMs: 10_000 });
  const statuses: boolean[] = [];
  connection.onStatus((up) => statuses.push(up));
  connection.attachLink(mux, { sys: localSysInfo(), paths: { kind: "identity" }, agentVersion: "v2", procs: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const req = sent.find((m) => m.t === "req") as Extract<BoxControlMessage, { t: "req" }>;
  mux.receiveControl({ t: "res", id: req.id, ok: true, result: "/real/a" });
  assert.equal(await waiting, "/real/a");
  assert.equal(connection.agentVersion, "v2");
  connection.detachLink(mux);
  assert.deepEqual(statuses, [true, false]);
});
