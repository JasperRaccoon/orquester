// The automation engine against an in-memory X server that speaks the subset it uses: keymap and
// XTEST bookkeeping, properties and selections, a framebuffer for GetImage, and DAMAGE / resize
// events the test pushes. Timers (click spacing, waits, the clipboard timeout) run on mock.timers.

import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, mock, test } from "node:test";

import { MAX_SERVER_MESSAGE_BYTES, X11Error } from "../x11/connection.ts";
import { encodeSelectionNotify } from "../x11/protocol.ts";
import { openDesktopAutomation } from "./engine.ts";
import { DesktopAutomationError, type DesktopAutomation } from "./types.ts";

const ROOT = 0x1e5;
const XTEST = 133;
const XFIXES = 139;
const DAMAGE = 144;
const DAMAGE_EVENT = 94;
const OTHER_CLIENT = 0x0060_0001;
const STRING = 31;

// Keysyms used by the fake keymap.
const XK = { a: 0x61, A: 0x41, one: 0x31, exclam: 0x21, Shift_L: 0xffe1, Control_L: 0xffe3, Return: 0xff0d, Alt_L: 0xffe9, Meta_L: 0xffe7, eacute: 0xe9 };

interface FakeInputRecord {
  type: "KeyPress" | "KeyRelease" | "ButtonPress" | "ButtonRelease" | "MotionNotify";
  detail: number;
  x?: number;
  y?: number;
}

interface Request {
  opcode: number;
  minor: number;
  sequence: number;
  buf: Buffer;
}

interface FakeOptions {
  width?: number;
  height?: number;
  imageByteOrder?: "lsb" | "msb";
  depth?: number;
  bitsPerPixel?: number;
  /** In 4-byte units. */
  maximumRequestLength?: number;
}

/** keycodes 8–31 (2 keysyms each): a/A, 1/!, Shift_L, Control_L, Return, Alt_L/Meta_L; the rest unbound. */
function keymap(): number[][] {
  const map: number[][] = Array.from({ length: 24 }, () => [0, 0]);
  map[0] = [XK.a, XK.A]; // 8
  map[1] = [XK.one, XK.exclam]; // 9
  map[2] = [XK.Shift_L, 0]; // 10
  map[3] = [XK.Control_L, 0]; // 11
  map[4] = [XK.Return, 0]; // 12
  map[5] = [XK.Alt_L, XK.Meta_L]; // 13
  return map;
}
const MIN_KEYCODE = 8;
const SHIFT = 10;
const CONTROL = 11;
const RETURN = 12;
const ALT = 13;

class FakeXServer {
  readonly requests: Request[] = [];
  readonly inputs: FakeInputRecord[] = [];
  readonly keymap = keymap();
  /** Every ChangeKeyboardMapping: first keycode and its keysyms. */
  readonly mappingChanges: Array<{ keycode: number; keysyms: number[] }> = [];
  readonly properties = new Map<number, Map<number, { type: number; format: number; data: Buffer }>>();
  readonly owners = new Map<number, { owner: number; time: number }>();
  readonly sent: Array<{ destination: number; event: Buffer }> = [];
  readonly atoms = new Map<string, number>();
  pointer = { x: 0, y: 0 };
  /** Answer a ConvertSelection (the test plays the other client). */
  onConvert?: (request: { requestor: number; selection: number; target: number; property: number; time: number }) => void;
  /** Return an X error code to fail the request. */
  failWhen?: (request: Request) => number | null;
  width: number;
  height: number;
  private time = 1000;
  private sequence = 0;
  private pendingBytes: Buffer = Buffer.alloc(0);
  private setupSeen = false;
  private watched = new Set<number>();
  private waiters: Array<() => void> = [];

  readonly stream: Duplex;

  constructor(readonly options: FakeOptions = {}) {
    this.width = options.width ?? 64;
    this.height = options.height ?? 48;
    this.stream = new Duplex({
      read() {},
      write: (chunk: Buffer, _encoding, callback) => {
        if (!this.setupSeen) {
          this.setupSeen = true;
          this.out(this.setup());
        } else {
          this.pendingBytes = Buffer.concat([this.pendingBytes, chunk]);
          while (this.pendingBytes.length >= 4) {
            const length = this.pendingBytes.readUInt16LE(2) * 4;
            if (this.pendingBytes.length < length) break;
            const buf = Buffer.from(this.pendingBytes.subarray(0, length));
            this.pendingBytes = this.pendingBytes.subarray(length);
            this.handle({ opcode: buf[0]!, minor: buf[1]!, sequence: ++this.sequence, buf });
          }
        }
        for (const wake of this.waiters.splice(0)) wake();
        callback();
      }
    });
  }

  atom(name: string): number {
    let atom = this.atoms.get(name);
    if (atom === undefined) {
      atom = 0x100 + this.atoms.size;
      this.atoms.set(name, atom);
    }
    return atom;
  }

  /** Resolves once `predicate` holds, re-checked after every request. */
  async until(predicate: () => boolean): Promise<void> {
    while (!predicate()) await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** The framebuffer: pixel (x, y) is RGB (x * 4, y * 4, (x + y) & 0xff). */
  static color(x: number, y: number): [number, number, number] {
    return [(x * 4) & 0xff, (y * 4) & 0xff, (x + y) & 0xff];
  }

  damage(area: { x: number; y: number; width: number; height: number }): void {
    const event = Buffer.alloc(32);
    event.writeUInt8(DAMAGE_EVENT, 0);
    event.writeUInt32LE(ROOT, 4);
    event.writeUInt32LE(this.damageId, 8);
    event.writeInt16LE(area.x, 16);
    event.writeInt16LE(area.y, 18);
    event.writeUInt16LE(area.width, 20);
    event.writeUInt16LE(area.height, 22);
    event.writeUInt16LE(this.width, 28);
    event.writeUInt16LE(this.height, 30);
    this.out(event);
  }

  resizeRoot(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const event = Buffer.alloc(32);
    event.writeUInt8(22, 0);
    event.writeUInt32LE(ROOT, 4);
    event.writeUInt32LE(ROOT, 8);
    event.writeUInt16LE(width, 20);
    event.writeUInt16LE(height, 22);
    this.out(event);
  }

  /** Another client asks the clipboard owner for `target` into `property` on its window. */
  selectionRequest(target: number, property: number, time = 0): void {
    const clipboard = this.atom("CLIPBOARD");
    const event = Buffer.alloc(32);
    event.writeUInt8(30, 0);
    event.writeUInt32LE(time, 4);
    event.writeUInt32LE(this.owners.get(clipboard)?.owner ?? 0, 8);
    event.writeUInt32LE(OTHER_CLIENT, 12);
    event.writeUInt32LE(clipboard, 16);
    event.writeUInt32LE(target, 20);
    event.writeUInt32LE(property, 24);
    this.out(event);
  }

  /** As another client: write a property on `window` and send it a SelectionNotify. */
  answerConvert(request: { requestor: number; selection: number; target: number; property: number; time: number }, value: { type: number; data: Buffer } | null): void {
    if (value) this.setProperty(request.requestor, request.property, value.type, 8, value.data);
    this.out(encodeSelectionNotify(request.time, request.requestor, request.selection, request.target, value ? request.property : 0));
  }

  /** Keys and buttons the input log leaves pressed. */
  held(): string[] {
    const down = new Set<string>();
    for (const input of this.inputs) {
      if (input.type === "KeyPress") down.add(`key ${input.detail}`);
      if (input.type === "KeyRelease") down.delete(`key ${input.detail}`);
      if (input.type === "ButtonPress") down.add(`button ${input.detail}`);
      if (input.type === "ButtonRelease") down.delete(`button ${input.detail}`);
    }
    return [...down];
  }

  private damageId = 0;

  private out(buf: Buffer): void {
    // Never inside the client's write: it registers the reply's request only after write returns.
    queueMicrotask(() => this.stream.push(buf));
  }

  private reply(sequence: number, byte1: number, fields: Buffer = Buffer.alloc(0), extra: Buffer = Buffer.alloc(0)): void {
    const buf = Buffer.alloc(32 + extra.length);
    buf.writeUInt8(1, 0);
    buf.writeUInt8(byte1, 1);
    buf.writeUInt16LE(sequence & 0xffff, 2);
    buf.writeUInt32LE(extra.length / 4, 4);
    fields.copy(buf, 8);
    extra.copy(buf, 32);
    this.out(buf);
  }

  private error(request: Request, code: number): void {
    const buf = Buffer.alloc(32);
    buf.writeUInt8(code, 1);
    buf.writeUInt16LE(request.sequence & 0xffff, 2);
    buf.writeUInt16LE(request.minor, 8);
    buf.writeUInt8(request.opcode, 10);
    this.out(buf);
  }

  private setup(): Buffer {
    const depth = this.options.depth ?? 24;
    const vendor = Buffer.from("Fake");
    const fixed = Buffer.alloc(32);
    fixed.writeUInt32LE(0x0040_0000, 4);
    fixed.writeUInt32LE(0x001f_ffff, 8);
    fixed.writeUInt16LE(vendor.length, 16);
    fixed.writeUInt16LE(this.options.maximumRequestLength ?? 0xffff, 18);
    fixed.writeUInt8(1, 20);
    fixed.writeUInt8(1, 21);
    fixed.writeUInt8(this.options.imageByteOrder === "msb" ? 1 : 0, 22);
    fixed.writeUInt8(MIN_KEYCODE, 26);
    fixed.writeUInt8(MIN_KEYCODE + this.keymap.length - 1, 27);
    const format = Buffer.from([depth, this.options.bitsPerPixel ?? 32, 32, 0, 0, 0, 0, 0]);
    const screen = Buffer.alloc(40);
    screen.writeUInt32LE(ROOT, 0);
    screen.writeUInt16LE(this.width, 20);
    screen.writeUInt16LE(this.height, 22);
    screen.writeUInt32LE(0x21, 32);
    screen.writeUInt8(depth, 38);
    screen.writeUInt8(1, 39);
    const depthHead = Buffer.from([depth, 0, 1, 0, 0, 0, 0, 0]);
    const visual = Buffer.alloc(24);
    visual.writeUInt32LE(0x21, 0);
    visual.writeUInt8(4, 4);
    visual.writeUInt8(8, 5);
    visual.writeUInt32LE(0xff0000, 8);
    visual.writeUInt32LE(0x00ff00, 12);
    visual.writeUInt32LE(0x0000ff, 16);
    const body = Buffer.concat([fixed, vendor, format, screen, depthHead, visual]);
    const head = Buffer.alloc(8);
    head.writeUInt8(1, 0);
    head.writeUInt16LE(11, 2);
    head.writeUInt16LE(body.length / 4, 6);
    return Buffer.concat([head, body]);
  }

  private setProperty(window: number, property: number, type: number, format: number, data: Buffer, mode = 0): void {
    let props = this.properties.get(window);
    if (!props) this.properties.set(window, (props = new Map()));
    const old = props.get(property);
    props.set(property, { type, format, data: mode === 2 && old ? Buffer.concat([old.data, data]) : data });
    if (this.watched.has(window)) this.propertyNotify(window, property, 0);
  }

  private propertyNotify(window: number, atom: number, state: number): void {
    const event = Buffer.alloc(32);
    event.writeUInt8(28, 0);
    event.writeUInt32LE(window, 4);
    event.writeUInt32LE(atom, 8);
    event.writeUInt32LE(this.time++, 12);
    event.writeUInt8(state, 16);
    this.out(event);
  }

  private handle(request: Request): void {
    this.requests.push(request);
    const code = this.failWhen?.(request) ?? null;
    if (code !== null) {
      this.error(request, code);
      return;
    }
    const { buf, sequence } = request;
    const u32 = (offset: number): number => buf.readUInt32LE(offset);
    switch (request.opcode) {
      case 1: {
        // CreateWindow: remember windows that asked for PropertyChange.
        const mask = u32(28);
        if (mask & 0x800 && u32(32) & 0x0040_0000) this.watched.add(u32(4));
        return;
      }
      case 2:
        return;
      case 14: {
        const fields = Buffer.alloc(24);
        fields.writeUInt32LE(ROOT, 0);
        fields.writeUInt16LE(this.width, 8);
        fields.writeUInt16LE(this.height, 10);
        this.reply(sequence, this.options.depth ?? 24, fields);
        return;
      }
      case 16: {
        const fields = Buffer.alloc(24);
        fields.writeUInt32LE(this.atom(buf.toString("latin1", 8, 8 + buf.readUInt16LE(4))), 0);
        this.reply(sequence, 0, fields);
        return;
      }
      case 18: {
        const format = buf[16]!;
        const data = Buffer.from(buf.subarray(24, 24 + u32(20) * (format / 8)));
        this.setProperty(u32(4), u32(8), u32(12), format, data, request.minor);
        return;
      }
      case 19: {
        if (this.properties.get(u32(4))?.delete(u32(8)) && this.watched.has(u32(4))) this.propertyNotify(u32(4), u32(8), 1);
        return;
      }
      case 20: {
        const value = this.properties.get(u32(4))?.get(u32(8));
        const fields = Buffer.alloc(24);
        if (!value) {
          this.reply(sequence, 0, fields);
          return;
        }
        const start = u32(16) * 4;
        const slice = value.data.subarray(start, start + u32(20) * 4);
        fields.writeUInt32LE(value.type, 0);
        fields.writeUInt32LE(value.data.length - start - slice.length, 4);
        fields.writeUInt32LE(slice.length / (value.format / 8), 8);
        this.reply(sequence, value.format, fields, Buffer.concat([slice, Buffer.alloc((4 - (slice.length % 4)) % 4)]));
        return;
      }
      case 22:
        this.owners.set(u32(8), { owner: u32(4), time: u32(12) });
        return;
      case 23: {
        const fields = Buffer.alloc(24);
        fields.writeUInt32LE(this.owners.get(u32(4))?.owner ?? 0, 0);
        this.reply(sequence, 0, fields);
        return;
      }
      case 24:
        this.onConvert?.({ requestor: u32(4), selection: u32(8), target: u32(12), property: u32(16), time: u32(20) });
        return;
      case 25:
        this.sent.push({ destination: u32(4), event: Buffer.from(buf.subarray(12, 44)) });
        return;
      case 38: {
        const fields = Buffer.alloc(24);
        fields.writeUInt32LE(ROOT, 0);
        fields.writeInt16LE(this.pointer.x, 8);
        fields.writeInt16LE(this.pointer.y, 10);
        this.reply(sequence, 1, fields);
        return;
      }
      case 43:
        this.reply(sequence, 0);
        return;
      case 73: {
        const [x0, y0, width, height] = [buf.readInt16LE(8), buf.readInt16LE(10), buf.readUInt16LE(12), buf.readUInt16LE(14)];
        const data = Buffer.alloc(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const [r, g, b] = FakeXServer.color(x0 + x, y0 + y);
            const pixel = ((r << 16) | (g << 8) | b) >>> 0;
            if (this.options.imageByteOrder === "msb") data.writeUInt32BE(pixel, (y * width + x) * 4);
            else data.writeUInt32LE(pixel, (y * width + x) * 4);
          }
        }
        const fields = Buffer.alloc(24);
        fields.writeUInt32LE(0x21, 0);
        this.reply(sequence, this.options.depth ?? 24, fields, data);
        return;
      }
      case 98: {
        const name = buf.toString("latin1", 8, 8 + buf.readUInt16LE(4));
        const known: Record<string, [number, number]> = { XTEST: [XTEST, 0], XFIXES: [XFIXES, 90], DAMAGE: [DAMAGE, DAMAGE_EVENT] };
        const fields = Buffer.alloc(24);
        if (known[name]) Buffer.from([1, known[name][0], known[name][1], 0]).copy(fields);
        this.reply(sequence, 0, fields);
        return;
      }
      case 100: {
        const count = request.minor;
        const first = buf[4]!;
        const per = buf[5]!;
        for (let i = 0; i < count; i++) {
          const keysyms = Array.from({ length: per }, (_, k) => u32(8 + (i * per + k) * 4));
          this.keymap[first + i - MIN_KEYCODE] = [keysyms[0] ?? 0, keysyms[1] ?? 0];
          this.mappingChanges.push({ keycode: first + i, keysyms });
        }
        const event = Buffer.alloc(32);
        event.writeUInt8(34, 0);
        Buffer.from([1, first, count]).copy(event, 4);
        this.out(event);
        return;
      }
      case 101: {
        const first = buf[4]!;
        const count = buf[5]!;
        const extra = Buffer.alloc(count * 8);
        for (let i = 0; i < count; i++) {
          const [s0, s1] = this.keymap[first + i - MIN_KEYCODE]!;
          extra.writeUInt32LE(s0!, i * 8);
          extra.writeUInt32LE(s1!, i * 8 + 4);
        }
        this.reply(sequence, 2, Buffer.alloc(24), extra);
        return;
      }
      case 119:
        // One keycode per modifier: Shift, Lock, Control, Mod1 (Alt), Mod2–Mod5.
        this.reply(sequence, 1, Buffer.alloc(24), Buffer.from([SHIFT, 0, CONTROL, ALT, 0, 0, 0, 0]));
        return;
      case XTEST:
        if (request.minor === 0) {
          const fields = Buffer.alloc(24);
          fields.writeUInt16LE(2, 0);
          this.reply(sequence, 2, fields);
        } else if (request.minor === 2) {
          const type = (["KeyPress", "KeyRelease", "ButtonPress", "ButtonRelease", "MotionNotify"] as const)[buf[4]! - 2]!;
          const input: FakeInputRecord = { type, detail: buf[5]! };
          if (type === "MotionNotify") {
            input.x = buf.readInt16LE(24);
            input.y = buf.readInt16LE(26);
            this.pointer = { x: input.x, y: input.y };
          }
          this.inputs.push(input);
        }
        return;
      case XFIXES:
      case DAMAGE: {
        if (request.minor === 0) {
          const fields = Buffer.alloc(24);
          fields.writeUInt32LE(u32(4), 0);
          fields.writeUInt32LE(u32(8), 4);
          this.reply(sequence, 0, fields);
        } else if (request.opcode === DAMAGE && request.minor === 1) {
          this.damageId = u32(4);
        }
        return;
      }
      default:
        throw new Error(`fake X server: unexpected request ${request.opcode}.${request.minor}`);
    }
  }
}

async function open(options?: FakeOptions): Promise<{ server: FakeXServer; engine: DesktopAutomation }> {
  const server = new FakeXServer(options);
  const engine = await openDesktopAutomation({ display: 1, connect: async () => server.stream, readAuthority: async () => Buffer.alloc(0) });
  return { server, engine };
}

/** Every queued microtask, tick and I/O callback has run (the fake server answers in microtasks). */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A round trip: every event the server sent before it has been handled. */
const roundTrip = (engine: DesktopAutomation): Promise<unknown> => engine.pointer();

const press = (detail: number): FakeInputRecord => ({ type: "KeyPress", detail });
const release = (detail: number): FakeInputRecord => ({ type: "KeyRelease", detail });

describe("DesktopAutomation input", () => {
  test("type: unshifted, shifted and unmapped keysyms; the temporary binding is restored on close", async () => {
    const { server, engine } = await open();
    await engine.type("aA!\né");
    // é has no keycode: the highest spare (31) is bound to it.
    assert.deepEqual(server.mappingChanges, [{ keycode: 31, keysyms: [XK.eacute, XK.eacute] }]);
    assert.deepEqual(server.inputs, [
      press(8),
      release(8),
      press(SHIFT),
      press(8),
      release(8),
      release(SHIFT),
      press(SHIFT),
      press(9),
      release(9),
      release(SHIFT),
      press(RETURN),
      release(RETURN),
      press(31),
      release(31)
    ]);
    // Typing it again reuses the binding.
    await engine.type("é");
    assert.equal(server.mappingChanges.length, 1);
    await engine.close();
    assert.deepEqual(server.mappingChanges.at(-1), { keycode: 31, keysyms: [0, 0] });
    assert.deepEqual(server.keymap[31 - MIN_KEYCODE], [0, 0]);
    assert.equal(engine.closed, true);
    await engine.close();
  });

  test("bindings are kept for the 8 most recent keysyms; a ninth reuses the least recent's keycode", async () => {
    const { server, engine } = await open();
    const text = "αβγδεζηθι";
    await engine.type(text);
    const bound = server.mappingChanges.map((change) => change.keycode);
    assert.equal(new Set(bound).size, 8);
    assert.equal(bound[8], bound[0], "ι takes α's keycode");
    assert.deepEqual(server.mappingChanges[8]!.keysyms, [0x0100_03b9, 0x0100_03b9]);
    await engine.close();
    // Every keycode still bound is restored, and only once.
    const restores = server.mappingChanges.slice(9);
    assert.deepEqual(restores.map((change) => change.keysyms), Array(8).fill([0, 0]));
    assert.equal(new Set(restores.map((change) => change.keycode)).size, 8);
  });

  test("key: modifiers in order, released in reverse; names are case-insensitive; unknown names and control characters are refused", async () => {
    const { server, engine } = await open();
    await engine.key("Ctrl+ALT+return", 2);
    const combo = [press(CONTROL), press(ALT), press(RETURN), release(RETURN), release(ALT), release(CONTROL)];
    assert.deepEqual(server.inputs, [...combo, ...combo]);
    server.inputs.length = 0;
    // A shifted character gets Shift around it…
    await engine.key("ctrl+!", 1);
    assert.deepEqual(server.inputs, [press(CONTROL), press(SHIFT), press(9), release(9), release(SHIFT), release(CONTROL)]);
    server.inputs.length = 0;
    // …unless the combo holds Shift already.
    await engine.key("shift+A", 1);
    assert.deepEqual(server.inputs, [press(SHIFT), press(8), release(8), release(SHIFT)]);
    server.inputs.length = 0;
    await assert.rejects(engine.key("ctrl+nosuchkey", 1), (error: unknown) => error instanceof DesktopAutomationError && error.code === "INVALID_ARGUMENT");
    await assert.rejects(engine.type("a\u0007b"), (error: unknown) => error instanceof DesktopAutomationError && error.code === "INVALID_ARGUMENT");
    assert.deepEqual(server.inputs, [], "a refused call presses nothing");
    await engine.close();
  });

  test("a call that fails halfway releases what it pressed", async () => {
    const { server, engine } = await open();
    // The server refuses the first button press (BadValue): the double click stops at its first barrier.
    server.failWhen = (request) => (request.opcode === XTEST && request.minor === 2 && request.buf[4] === 4 ? 2 : null);
    await assert.rejects(engine.click(1, 1, 1, 2, ["ctrl"]), (error: unknown) => error instanceof X11Error && error.code === 2);
    assert.deepEqual(server.inputs, [{ type: "MotionNotify", detail: 0, x: 1, y: 1 }, press(CONTROL), { type: "ButtonRelease", detail: 1 }, release(CONTROL)]);
    assert.deepEqual(server.held(), []);
    await engine.close();
  });

  test("click holds modifiers around count clicks 60 ms apart; mouse_down stays held until mouse_up or close", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { server, engine } = await open();
    const clicked = engine.click(10, 20, 1, 2, ["shift"]);
    // The first click, then the sync barrier before the pause.
    await server.until(() => server.inputs.length === 4 && server.requests.at(-1)?.opcode === 43);
    await drain();
    assert.deepEqual(server.inputs, [{ type: "MotionNotify", detail: 0, x: 10, y: 20 }, press(SHIFT), { type: "ButtonPress", detail: 1 }, { type: "ButtonRelease", detail: 1 }]);
    t.mock.timers.tick(60);
    await clicked;
    assert.deepEqual(server.inputs.slice(4), [{ type: "ButtonPress", detail: 1 }, { type: "ButtonRelease", detail: 1 }, release(SHIFT)]);
    await assert.rejects(engine.click(64, 0, 1, 1, []), (error: unknown) => error instanceof DesktopAutomationError && error.code === "INVALID_ARGUMENT");

    await engine.button(3, true);
    assert.deepEqual(server.held(), ["button 3"]);
    await engine.button(3, false);
    assert.deepEqual(server.held(), []);
    await engine.button(2, true);
    await engine.close();
    assert.deepEqual(server.held(), [], "close releases the held button");
  });
});

describe("DesktopAutomation damage and waits", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 }));
  afterEach(() => mock.timers.reset());

  test("idle resolves once the region has been still for idleMs, pushed back by damage inside it", async () => {
    const { server, engine } = await open();
    let settled = false;
    const waited = engine.wait({ for: "idle", idleMs: 500, region: { x: 0, y: 0, width: 32, height: 32 }, timeoutMs: 10_000 }).finally(() => (settled = true));
    mock.timers.tick(200);
    server.damage({ x: 20, y: 20, width: 4, height: 4 });
    await roundTrip(engine);
    // Damage outside the region does not count.
    mock.timers.tick(100);
    server.damage({ x: 40, y: 40, width: 4, height: 4 });
    await roundTrip(engine);
    mock.timers.tick(200);
    await roundTrip(engine);
    assert.equal(settled, false, "still 300 ms after the change inside the region");
    mock.timers.tick(200);
    assert.deepEqual(await waited, { changed: true, timedOut: false, seq: 2, waitedMs: 700 });
    // Already still: at once.
    assert.deepEqual(await engine.wait({ for: "idle", idleMs: 100, timeoutMs: 1_000 }), { changed: false, timedOut: false, seq: 2, waitedMs: 0 });
    await engine.close();
  });

  test("idle times out when the screen keeps changing", async () => {
    const { server, engine } = await open();
    const waited = engine.wait({ for: "idle", idleMs: 300, timeoutMs: 1_000 });
    for (let t = 0; t < 1_000; t += 200) {
      mock.timers.tick(200);
      server.damage({ x: 0, y: 0, width: 1, height: 1 });
      await roundTrip(engine);
    }
    // The deadline passes before the fifth change.
    assert.deepEqual(await waited, { changed: true, timedOut: true, seq: 4, waitedMs: 1_000 });
    await engine.close();
  });

  test("change resolves on damage in the region after `since`, at once for a change already seen, and times out", async () => {
    const { server, engine } = await open();
    assert.equal(engine.seq(), 0);
    const waited = engine.wait({ for: "change", idleMs: 0, region: { x: 32, y: 0, width: 32, height: 16 }, timeoutMs: 5_000 });
    server.damage({ x: 0, y: 0, width: 16, height: 16 });
    await roundTrip(engine);
    mock.timers.tick(50);
    server.damage({ x: 40, y: 8, width: 2, height: 2 });
    assert.deepEqual(await waited, { changed: true, timedOut: false, seq: 2, waitedMs: 50 });
    // The block changed at seq 2: a wait since 1 needs no new damage.
    assert.deepEqual(await engine.wait({ for: "change", idleMs: 0, since: 1, region: { x: 40, y: 0, width: 8, height: 8 }, timeoutMs: 5_000 }), {
      changed: true,
      timedOut: false,
      seq: 2,
      waitedMs: 0
    });
    const quiet = engine.wait({ for: "change", idleMs: 0, timeoutMs: 5_000 });
    mock.timers.tick(5_000);
    assert.deepEqual(await quiet, { changed: false, timedOut: true, seq: 2, waitedMs: 5_000 });
    // Each batch of notifications is subtracted.
    await server.until(() => server.requests.some((request) => request.opcode === DAMAGE && request.minor === 3));
    await engine.close();
  });

  test("a resize bumps the sequence, notifies listeners and ends change waits; an abort rejects", async () => {
    const { server, engine } = await open();
    const sizes: unknown[] = [];
    engine.onResize((size) => sizes.push(size));
    const waited = engine.wait({ for: "change", idleMs: 0, region: { x: 0, y: 0, width: 8, height: 8 }, timeoutMs: 5_000 });
    server.resizeRoot(80, 40);
    assert.deepEqual(await waited, { changed: true, timedOut: false, seq: 1, waitedMs: 0 });
    assert.deepEqual(sizes, [{ width: 80, height: 40 }]);
    assert.deepEqual(engine.size(), { width: 80, height: 40 });

    const controller = new AbortController();
    const aborted = engine.wait({ for: "idle", idleMs: 1_000, timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, { name: "AbortError" });
    const closing = engine.wait({ for: "change", idleMs: 0, timeoutMs: 5_000 });
    await engine.close();
    await assert.rejects(closing, (error: unknown) => error instanceof DesktopAutomationError && error.code === "DESKTOP_NOT_RUNNING");
  });
});

describe("DesktopAutomation capture", () => {
  for (const imageByteOrder of ["lsb", "msb"] as const) {
    test(`converts ${imageByteOrder === "lsb" ? "LSBFirst" : "MSBFirst"} pixels to RGB for a region, with the sequence and the cursor`, async () => {
      const { server, engine } = await open({ imageByteOrder });
      server.pointer = { x: 5, y: 6 };
      const capture = await engine.capture({ x: 10, y: 4, width: 3, height: 2 });
      assert.deepEqual({ ...capture, rgb: undefined }, { width: 3, height: 2, origin: { x: 10, y: 4 }, rgb: undefined, seq: 0, display: { width: 64, height: 48 }, cursor: { x: 5, y: 6 } });
      const expected = [];
      for (let y = 4; y < 6; y++) for (let x = 10; x < 13; x++) expected.push(...FakeXServer.color(x, y));
      assert.deepEqual([...capture.rgb], expected);
      await engine.close();
    });
  }

  test("a large screen is read in bands whose replies fit the message cap", async () => {
    const { server, engine } = await open({ width: 1024, height: 1100 });
    const capture = await engine.capture();
    const bands = server.requests.filter((request) => request.opcode === 73).map((request) => request.buf.readUInt16LE(14));
    assert.deepEqual(bands, [1023, 77]);
    for (const rows of bands) assert.ok(32 + rows * 1024 * 4 <= MAX_SERVER_MESSAGE_BYTES);
    const at = (x: number, y: number): number[] => [...capture.rgb.subarray((y * 1024 + x) * 3, (y * 1024 + x) * 3 + 3)];
    assert.deepEqual(at(1023, 1099), FakeXServer.color(1023, 1099));
    assert.deepEqual(at(7, 1023), FakeXServer.color(7, 1023));
    await engine.close();
  });

  test("a 16-bit display is refused as an unsupported visual", async () => {
    const { engine } = await open({ depth: 16, bitsPerPixel: 16 });
    await assert.rejects(engine.capture(), (error: unknown) => error instanceof DesktopAutomationError && error.code === "DESKTOP_UNSUPPORTED_VISUAL");
    await engine.close();
  });
});

describe("DesktopAutomation clipboard", () => {
  test("setClipboard owns CLIPBOARD and answers TARGETS, UTF8_STRING, STRING and TEXT; refuses other targets", async () => {
    // A small request limit makes the text go out in several ChangeProperty pieces.
    const { server, engine } = await open({ maximumRequestLength: 64 });
    const text = `héllo € ${"x".repeat(600)}`;
    await engine.setClipboard(text);
    const clipboard = server.atom("CLIPBOARD");
    const owner = server.owners.get(clipboard)!;
    assert.ok(owner.owner !== 0 && owner.time >= 1000, "owned with a server timestamp, not CurrentTime");

    const answer = async (target: number, property: number): Promise<{ notified: number; value?: { type: number; format: number; data: Buffer } }> => {
      const before = server.sent.length;
      server.selectionRequest(target, property, 77);
      await server.until(() => server.sent.length > before);
      const { destination, event } = server.sent.at(-1)!;
      assert.equal(destination, OTHER_CLIENT);
      assert.equal(event[0], 31);
      assert.equal(event.readUInt32LE(4), 77, "the request's time is echoed");
      assert.equal(event.readUInt32LE(16), target);
      return { notified: event.readUInt32LE(20), value: server.properties.get(OTHER_CLIENT)?.get(property) };
    };
    const utf8 = await answer(server.atom("UTF8_STRING"), 0x500);
    assert.equal(utf8.notified, 0x500);
    assert.equal(utf8.value!.type, server.atom("UTF8_STRING"));
    assert.equal(utf8.value!.data.toString("utf8"), text);
    assert.ok(server.requests.filter((request) => request.opcode === 18 && request.buf.readUInt32LE(4) === OTHER_CLIENT).length > 1, "sent in pieces");

    const targets = await answer(server.atom("TARGETS"), 0x501);
    const atoms = [];
    for (let i = 0; i < targets.value!.data.length; i += 4) atoms.push(targets.value!.data.readUInt32LE(i));
    assert.deepEqual(atoms, [server.atom("TARGETS"), server.atom("UTF8_STRING"), STRING, server.atom("TEXT")]);

    const latin1 = await answer(STRING, 0x502);
    assert.equal(latin1.value!.type, STRING);
    assert.equal(latin1.value!.data.toString("latin1"), `héllo ? ${"x".repeat(600)}`);

    // An obsolete client naming no property gets the target as the property.
    const text8 = await answer(server.atom("TEXT"), 0);
    assert.equal(text8.notified, server.atom("TEXT"));

    const refused = await answer(server.atom("image/png"), 0x503);
    assert.equal(refused.notified, 0);
    assert.equal(refused.value, undefined);

    // Reading back what we own needs no conversion.
    assert.equal(await engine.getClipboard(), text);
    await engine.close();
    assert.equal(server.owners.get(clipboard)!.owner, 0, "close gives the selection up");
  });

  test("getClipboard converts from the owner, falls back to STRING, refuses INCR, times out after 2 s", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { server, engine } = await open();
    const clipboard = server.atom("CLIPBOARD");
    assert.equal(await engine.getClipboard(), "", "no owner");

    server.owners.set(clipboard, { owner: 0x700001, time: 1 });
    server.onConvert = (request) => {
      assert.equal(request.selection, clipboard);
      assert.notEqual(request.time, 0, "a server timestamp, not CurrentTime");
      server.answerConvert(request, request.target === server.atom("UTF8_STRING") ? { type: server.atom("UTF8_STRING"), data: Buffer.from("naïve ✓") } : null);
    };
    assert.equal(await engine.getClipboard(), "naïve ✓");
    const helper = server.requests.find((request) => request.opcode === 24)!.buf.readUInt32LE(4);
    assert.equal(server.properties.get(helper)?.has(server.atom("_ORQUESTER_SELECTION")), false, "the transfer property is deleted after reading");

    // UTF8_STRING refused: STRING is Latin-1.
    server.onConvert = (request) => server.answerConvert(request, request.target === STRING ? { type: STRING, data: Buffer.from([0x63, 0x61, 0x66, 0xe9]) } : null);
    assert.equal(await engine.getClipboard(), "café");

    server.onConvert = (request) => server.answerConvert(request, { type: server.atom("INCR"), data: Buffer.alloc(4) });
    await assert.rejects(engine.getClipboard(), (error: unknown) => error instanceof DesktopAutomationError && error.code === "CLIPBOARD_UNAVAILABLE" && /INCR/.test(error.message));

    server.onConvert = () => {};
    const silent = engine.getClipboard();
    await server.until(() => server.requests.filter((request) => request.opcode === 24).length === 5);
    t.mock.timers.tick(2_000);
    await assert.rejects(silent, (error: unknown) => error instanceof DesktopAutomationError && error.code === "CLIPBOARD_UNAVAILABLE" && /2 s/.test(error.message));
    await engine.close();
  });
});
