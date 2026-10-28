import assert from "node:assert/strict";
import { finished } from "node:stream/promises";
import { test } from "node:test";

import {
  BOX_CHANNEL_WINDOW_BYTES,
  BOX_MAX_FRAME_PAYLOAD,
  decodeDataFrame,
  encodeDataFrame,
  parseControlMessage,
  type BoxControlMessage
} from "@orquester/api";

import { localSysInfo } from "../testing.ts";
import { LinkedBoxConnection, type RemoteBoxProcess } from "./connection.ts";
import { BoxMux } from "./mux.ts";

/** `bytes` zero bytes on stream 1 of channel `ch`, in frames of the largest allowed size. */
function feed(mux: BoxMux, ch: number, bytes: number): void {
  for (let left = bytes; left > 0; left -= BOX_MAX_FRAME_PAYLOAD) {
    mux.receiveBinary(encodeDataFrame(ch, 1, new Uint8Array(Math.min(left, BOX_MAX_FRAME_PAYLOAD))));
  }
}

/** A connection on a mux whose outgoing frames are captured; `nextOpen` resolves each `open` the host sends. */
function linked(onControl?: (message: BoxControlMessage) => void): {
  connection: LinkedBoxConnection;
  mux: BoxMux;
  sent: BoxControlMessage[];
  nextOpen: () => Promise<Extract<BoxControlMessage, { t: "open" }>>;
} {
  const sent: BoxControlMessage[] = [];
  const waiters: ((message: Extract<BoxControlMessage, { t: "open" }>) => void)[] = [];
  const mux = new BoxMux({
    sendText: (text) => {
      const message = parseControlMessage(text)!;
      sent.push(message);
      onControl?.(message);
      if (message.t === "open") waiters.shift()?.(message);
    },
    sendBinary: (frame) => {
      decodeDataFrame(frame);
    }
  });
  const connection = new LinkedBoxConnection("b1", { sys: localSysInfo(), paths: { kind: "identity" }, agentVersion: "v", procs: [] });
  connection.attachLink(mux, { sys: localSysInfo(), paths: { kind: "identity" }, agentVersion: "v", procs: [] });
  // Answered after the current turn: the opener installs its handlers right after
  // sending `open`, and box frames arrive in later turns, as from a socket.
  const nextOpen = (): Promise<Extract<BoxControlMessage, { t: "open" }>> => {
    const already = sent.find((m): m is Extract<BoxControlMessage, { t: "open" }> => m.t === "open" && !seen.has(m.ch));
    if (already) {
      seen.add(already.ch);
      return new Promise((resolve) => setImmediate(() => resolve(already)));
    }
    return new Promise((resolve) =>
      waiters.push((message) => {
        seen.add(message.ch);
        setImmediate(() => resolve(message));
      })
    );
  };
  const seen = new Set<number>();
  return { connection, mux, sent, nextOpen };
}

test("a box that sends past its credit window gets the channel closed, not buffered", async () => {
  const { connection, mux, sent, nextOpen } = linked();
  const download = connection.readFile("/big");
  const open = await nextOpen();
  mux.receiveControl({ t: "opened", ch: open.ch });
  const readable = await download;
  readable.pause();
  const completion = finished(readable);
  // A whole window is fine even unread; one byte more is not.
  feed(mux, open.ch, BOX_CHANNEL_WINDOW_BYTES);
  assert.equal(sent.some((m) => m.t === "close"), false);
  mux.receiveBinary(encodeDataFrame(open.ch, 1, new Uint8Array(1)));
  mux.receiveControl({ t: "eof", ch: open.ch, stream: 1 });
  mux.receiveControl({ t: "close", ch: open.ch });
  readable.resume();
  await assert.rejects(completion, { code: "WINDOW_EXCEEDED" });
  const close = sent.find((m) => m.t === "close" && m.ch === open.ch) as Extract<BoxControlMessage, { t: "close" }>;
  assert.equal(close.error?.code, "WINDOW_EXCEEDED");
});

test("credit returned to the box reopens the window", async () => {
  let credited = 0;
  let creditReturned!: () => void;
  const consumedWindow = new Promise<void>((resolve) => (creditReturned = resolve));
  const { connection, mux, sent, nextOpen } = linked((message) => {
    if (message.t === "credit" && (credited += message.bytes) >= BOX_CHANNEL_WINDOW_BYTES) creditReturned();
  });
  const download = connection.readFile("/big");
  const open = await nextOpen();
  mux.receiveControl({ t: "opened", ch: open.ch });
  const readable = await download;
  let got = 0;
  readable.on("data", (chunk: Buffer) => (got += chunk.byteLength));
  feed(mux, open.ch, BOX_CHANNEL_WINDOW_BYTES);
  await consumedWindow;
  feed(mux, open.ch, BOX_CHANNEL_WINDOW_BYTES / 2);
  mux.receiveControl({ t: "eof", ch: open.ch, stream: 1 });
  mux.receiveControl({ t: "close", ch: open.ch });
  await new Promise((resolve) => readable.once("end", resolve));
  assert.equal(got, BOX_CHANNEL_WINDOW_BYTES * 1.5);
  assert.equal(sent.some((m) => m.t === "close" && m.ch === open.ch), false);
});

test("raw (relayed) channels are held to the window too, and both ends learn of the close", () => {
  const { mux, sent } = linked();
  const frames: BoxControlMessage[] = [];
  let bytes = 0;
  const id = mux.openRaw({ kind: "tcp", port: 1 }, { control: (m) => frames.push(m), data: (_s, p) => (bytes += p.byteLength), lost: () => undefined });
  mux.receiveControl({ t: "opened", ch: id });
  feed(mux, id, BOX_CHANNEL_WINDOW_BYTES);
  // The relay's client acknowledged half of it.
  mux.sendRaw(id, { t: "credit", ch: id, bytes: BOX_CHANNEL_WINDOW_BYTES / 2 });
  feed(mux, id, BOX_CHANNEL_WINDOW_BYTES / 2);
  assert.equal(bytes, BOX_CHANNEL_WINDOW_BYTES * 1.5);
  mux.receiveBinary(encodeDataFrame(id, 1, new Uint8Array(1)));
  assert.equal(bytes, BOX_CHANNEL_WINDOW_BYTES * 1.5);
  assert.equal((frames.at(-1) as Extract<BoxControlMessage, { t: "close" }>).error?.code, "WINDOW_EXCEEDED");
  assert.equal((sent.at(-1) as Extract<BoxControlMessage, { t: "close" }>).error?.code, "WINDOW_EXCEEDED");
  // Nothing more reaches the sink.
  mux.receiveBinary(encodeDataFrame(id, 1, new Uint8Array(1)));
  assert.equal(bytes, BOX_CHANNEL_WINDOW_BYTES * 1.5);
});

test("output a box sends after its eof is dropped, never pushed after the end", async () => {
  const { connection, mux, nextOpen } = linked();
  const proc = connection.exec({ command: "x" });
  const errors: Error[] = [];
  proc.stdout.on("error", (error) => errors.push(error));
  proc.on("error", (error) => errors.push(error));
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const open = await nextOpen();
  mux.receiveControl({ t: "opened", ch: open.ch, info: { pid: 1 } });
  mux.receiveBinary(encodeDataFrame(open.ch, 1, Buffer.from("tail")));
  mux.receiveControl({ t: "eof", ch: open.ch, stream: 1 });
  // A late frame on the finished stream, in the same turn (before `end` was read).
  mux.receiveBinary(encodeDataFrame(open.ch, 1, Buffer.from("late")));
  mux.receiveControl({ t: "exit", ch: open.ch, code: 0, signal: null });
  await finished(proc.stdout);
  assert.equal(out, "tail");
  assert.deepEqual(errors, []);
});

test("an `opened` and a failing `close` that arrive together reject with the box's error", async () => {
  const { connection, mux, nextOpen } = linked();
  const download = connection.readFile("/denied");
  const open = await nextOpen();
  mux.receiveControl({ t: "opened", ch: open.ch, info: { size: 10 } });
  mux.receiveControl({ t: "close", ch: open.ch, error: { code: "EIO", message: "read failed" } });
  await assert.rejects(download, { code: "EIO", message: "read failed" });

  const tcp = connection.openTcp(5432);
  const tcpOpen = await nextOpen();
  mux.receiveControl({ t: "opened", ch: tcpOpen.ch });
  mux.receiveControl({ t: "close", ch: tcpOpen.ch, error: { code: "ECONNRESET", message: "reset" } });
  await assert.rejects(tcp, { code: "ECONNRESET" });
});

test("a file read never yields more than the length asked for", async () => {
  const { connection, mux, sent, nextOpen } = linked();
  const download = connection.readFile("/f", { offset: 0, length: 4 });
  const open = await nextOpen();
  mux.receiveControl({ t: "opened", ch: open.ch });
  const readable = await download;
  let got = "";
  readable.on("data", (chunk: Buffer) => (got += chunk.toString()));
  const completion = finished(readable);
  mux.receiveBinary(encodeDataFrame(open.ch, 1, Buffer.from("abcd")));
  mux.receiveBinary(encodeDataFrame(open.ch, 1, Buffer.from("efgh")));
  mux.receiveControl({ t: "eof", ch: open.ch, stream: 1 });
  mux.receiveControl({ t: "close", ch: open.ch });
  readable.resume();
  await assert.rejects(completion, { code: "TOO_LONG" });
  assert.ok(!got.includes("e"));
  assert.equal((sent.find((m) => m.t === "close" && m.ch === open.ch) as Extract<BoxControlMessage, { t: "close" }>).error?.code, "TOO_LONG");
});

test("a detached process's channel lost before it opened is a detach, not an error", async () => {
  const { connection, mux, nextOpen } = linked();
  const proc = connection.attach("p1", 10) as RemoteBoxProcess;
  const outcome = new Promise<string>((resolve) => {
    proc.once("detached", () => resolve("detached"));
    proc.once("error", (error) => resolve(`error ${(error as Error & { code: string }).code}`));
  });
  await nextOpen();
  // The link drops before `opened`.
  connection.detachLink(mux);
  mux.shutdown();
  assert.equal(await outcome, "detached");

  // Same for a box that is still away when the open would have to go out.
  const away = new LinkedBoxConnection("b2", { sys: localSysInfo(), paths: { kind: "identity" }, agentVersion: "v", procs: [] });
  const viewer = away.attach("p2", 0);
  const later = new Promise<string>((resolve) => {
    viewer.on("detached", () => resolve("detached"));
    viewer.once("error", (error) => resolve(`error ${(error as Error & { code: string }).code}`));
  });
  away.rejectWaiters(Object.assign(new Error("gone"), { code: "BOX_DISCONNECTED" }));
  assert.equal(await later, "detached");
});

test("an unwatch asked while the link is down is not undone by the next link's replay", async () => {
  const info = { sys: localSysInfo(), paths: { kind: "identity" as const }, agentVersion: "v", procs: [] };
  /** A mux that answers every request at once, recording what was sent on it. */
  const answering = () => {
    const sent: BoxControlMessage[] = [];
    const mux: BoxMux = new BoxMux({
      sendText: (text) => {
        const message = parseControlMessage(text)!;
        sent.push(message);
        if (message.t === "req") setImmediate(() => mux.receiveControl({ t: "res", id: message.id, ok: true, result: null }));
      },
      sendBinary: () => {}
    });
    return { mux, sent };
  };
  const connection = new LinkedBoxConnection("b1", info, { replay: true });
  const first = answering();
  connection.attachLink(first.mux, info);
  await connection.request("fs.watch", { watchId: "w1", path: "/d", recursive: false });
  await connection.request("fs.watch", { watchId: "w2", path: "/e", recursive: false });
  connection.detachLink(first.mux);

  const unwatched = connection.request("fs.unwatch", { watchId: "w1" });
  const second = answering();
  connection.attachLink(second.mux, info);
  await unwatched;
  const requests = second.sent.filter((m): m is Extract<BoxControlMessage, { t: "req" }> => m.t === "req");
  assert.deepEqual(
    requests.map((m) => [m.method, (m.params as { watchId: string }).watchId]).sort(),
    [["fs.unwatch", "w1"], ["fs.watch", "w2"]]
  );
});
