import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { describe, test } from "node:test";

import { X11Connection, X11ConnectionClosedError, X11Error, X11SetupError } from "./connection.ts";
import { Opcode, type XEvent } from "./protocol.ts";

/** An in-memory X server end: records the client's requests and lets the test answer. */
class FakeServer {
  readonly requests: Buffer[] = [];
  private waiters: Array<() => void> = [];
  private setupSeen = false;
  readonly stream = new Duplex({
    read() {},
    write: (chunk: Buffer, _encoding, callback) => {
      if (!this.setupSeen) this.setupSeen = true;
      else this.requests.push(Buffer.from(chunk));
      for (const wake of this.waiters.splice(0)) wake();
      callback();
    }
  });

  push(buf: Buffer): void {
    this.stream.push(buf);
  }

  /** Resolves once the client has sent `count` requests (after the setup). */
  async untilRequests(count: number): Promise<void> {
    while (this.requests.length < count) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}

function setupSuccess(root = 0x1e5): Buffer {
  const body = Buffer.alloc(32 + 40);
  body.writeUInt8(1, 20); // one screen, no formats, empty vendor
  body.writeUInt32LE(root, 32);
  body.writeUInt16LE(1024, 32 + 20);
  body.writeUInt16LE(768, 32 + 22);
  const head = Buffer.alloc(8);
  head.writeUInt8(1, 0);
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(body.length / 4, 6);
  return Buffer.concat([head, body]);
}

function reply(sequence: number, fields: Buffer = Buffer.alloc(24), byte1 = 0, extra: Buffer = Buffer.alloc(0)): Buffer {
  const buf = Buffer.alloc(32 + extra.length);
  buf.writeUInt8(1, 0);
  buf.writeUInt8(byte1, 1);
  buf.writeUInt16LE(sequence & 0xffff, 2);
  buf.writeUInt32LE(extra.length / 4, 4);
  fields.copy(buf, 8);
  extra.copy(buf, 32);
  return buf;
}

function xerror(sequence: number, code: number, badValue: number, major: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt8(code, 1);
  buf.writeUInt16LE(sequence & 0xffff, 2);
  buf.writeUInt32LE(badValue, 4);
  buf.writeUInt8(major, 10);
  return buf;
}

function atomReply(sequence: number, atom: number): Buffer {
  const fields = Buffer.alloc(24);
  fields.writeUInt32LE(atom, 0);
  return reply(sequence, fields);
}

async function connected(): Promise<{ server: FakeServer; conn: X11Connection }> {
  const server = new FakeServer();
  const pending = X11Connection.handshake(server.stream, null);
  // The setup reply may arrive in pieces.
  const setup = setupSuccess();
  server.push(setup.subarray(0, 5));
  server.push(setup.subarray(5));
  const conn = await pending;
  return { server, conn };
}

describe("X11Connection", () => {
  test("handshake exposes the root and rejects a refusal with the reason", async () => {
    const { conn } = await connected();
    assert.equal(conn.root, 0x1e5);
    assert.equal(conn.setup.screens[0]!.width, 1024);

    const server = new FakeServer();
    const pending = X11Connection.handshake(server.stream, null);
    const reason = Buffer.from("No protocol specified\n\0\0");
    const head = Buffer.alloc(8);
    head.writeUInt8(0, 0);
    head.writeUInt8(22, 1);
    head.writeUInt16LE(reason.length / 4, 6);
    server.push(Buffer.concat([head, reason]));
    await assert.rejects(pending, (error: unknown) => error instanceof X11SetupError && error.reason === "No protocol specified\n");
  });

  test("handshake fails when the stream closes first", async () => {
    const server = new FakeServer();
    const pending = X11Connection.handshake(server.stream, null);
    server.stream.destroy();
    await assert.rejects(pending, X11ConnectionClosedError);
  });

  test("replies resolve the request with the matching sequence number", async () => {
    const { server, conn } = await connected();
    const a = conn.internAtom("A");
    const b = conn.internAtom("B");
    await server.untilRequests(2);
    assert.equal(server.requests[0]![0], Opcode.InternAtom);
    // Both replies in one chunk.
    server.push(Buffer.concat([atomReply(1, 0x101), atomReply(2, 0x102)]));
    assert.equal(await a, 0x101);
    assert.equal(await b, 0x102);
  });

  test("an error rejects only its own request", async () => {
    const { server, conn } = await connected();
    const bad = conn.getGeometry(0x999);
    const good = conn.internAtom("OK");
    await server.untilRequests(2);
    server.push(xerror(1, 9, 0x999, Opcode.GetGeometry));
    server.push(atomReply(2, 0x200));
    await assert.rejects(bad, (error: unknown) => error instanceof X11Error && error.code === 9 && error.badValue === 0x999);
    assert.equal(await good, 0x200);
  });

  test("void requests are checked through a GetInputFocus sync", async () => {
    const { server, conn } = await connected();
    const ok = conn.selectInput(0x400001, 0x400000);
    const failed = conn.selectInput(0x400002, 0x400000);
    await server.untilRequests(4);
    assert.deepEqual(
      server.requests.map((r) => r[0]),
      [Opcode.ChangeWindowAttributes, Opcode.GetInputFocus, Opcode.ChangeWindowAttributes, Opcode.GetInputFocus]
    );
    server.push(reply(2));
    await ok;
    server.push(xerror(3, 3, 0x400002, Opcode.ChangeWindowAttributes));
    server.push(reply(4));
    await assert.rejects(failed, (error: unknown) => error instanceof X11Error && error.code === 3);
  });

  test("sequence numbers widen across the 16-bit wrap", async () => {
    const { server, conn } = await connected();
    Reflect.set(conn, "sequence", 0x1fffe);
    const a = conn.internAtom("A"); // 0x1ffff
    const b = conn.internAtom("B"); // 0x20000 → wire 0x0000
    await server.untilRequests(2);
    server.push(atomReply(0xffff, 1));
    server.push(atomReply(0x0000, 2));
    assert.equal(await a, 1);
    assert.equal(await b, 2);
  });

  test("GetProperty reads a long value in chunks", async () => {
    const { server, conn } = await connected();
    const value = Buffer.alloc(16_384 * 4 + 12);
    for (let i = 0; i < value.length; i++) value[i] = i & 0xff;
    const property = conn.getProperty(0x1e5, 0x150, 0);
    await server.untilRequests(1);
    const chunk = (sequence: number, offset: number, length: number, after: number): Buffer => {
      const fields = Buffer.alloc(24);
      fields.writeUInt32LE(0x150, 0);
      fields.writeUInt32LE(after, 4);
      fields.writeUInt32LE(length, 8);
      return reply(sequence, fields, 8, value.subarray(offset, offset + length));
    };
    server.push(chunk(1, 0, 16_384 * 4, 12));
    await server.untilRequests(2);
    assert.equal(server.requests[1]!.readUInt32LE(16), 16_384, "the second read starts at the next long");
    server.push(chunk(2, 16_384 * 4, 12, 0));
    const result = await property;
    assert.ok(result);
    assert.deepEqual(result.value, value);
    assert.equal(result.format, 8);
  });

  test("GetProperty returns null for a missing property", async () => {
    const { server, conn } = await connected();
    const property = conn.getProperty(0x1e5, 0x150);
    await server.untilRequests(1);
    server.push(reply(1));
    assert.equal(await property, null);
  });

  test("events split across chunks are dispatched whole", async () => {
    const { server, conn } = await connected();
    const event = Buffer.alloc(32);
    event.writeUInt8(28, 0);
    event.writeUInt32LE(0x1e5, 4);
    event.writeUInt32LE(0x160, 8);
    const received = once(conn, "event") as Promise<[XEvent]>;
    server.push(event.subarray(0, 10));
    server.push(event.subarray(10));
    const [decoded] = await received;
    assert.equal(decoded.type, "PropertyNotify");
  });

  test("an unexpected close rejects pending requests and reports the error", async () => {
    const { server, conn } = await connected();
    const pending = conn.internAtom("A");
    const closed = once(conn, "close") as Promise<[Error | null]>;
    server.stream.destroy(new Error("reset"));
    await assert.rejects(pending, X11ConnectionClosedError);
    const [error] = await closed;
    assert.ok(error instanceof X11ConnectionClosedError);
    assert.match(error.message, /reset/);
    await assert.rejects(conn.internAtom("B"), X11ConnectionClosedError);
  });

  test("close() reports a null error", async () => {
    const { conn } = await connected();
    const closed = once(conn, "close") as Promise<[Error | null]>;
    conn.close();
    assert.deepEqual(await closed, [null]);
    assert.equal(conn.isClosed, true);
  });
});
