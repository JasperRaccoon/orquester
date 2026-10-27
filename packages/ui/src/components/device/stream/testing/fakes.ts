/** Stand-ins for the browser APIs a stream session uses, for Node tests. */

import { readFileSync } from "node:fs";
import { mock } from "node:test";

/** Build one envelope (tests and fixtures). */
export function encodeAvccEnvelope(tag: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = tag;
  out.set(payload, 5);
  return out;
}

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url)));
}

/** Records written by the capture script: `u8 kind (0 binary, 1 text) | u32 BE length | payload`. */
export function readWsFixture(name: string): Array<string | ArrayBuffer> {
  const bytes = fixtureBytes(name);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records: Array<string | ArrayBuffer> = [];
  let offset = 0;
  while (offset < bytes.length) {
    const kind = bytes[offset]!;
    const length = view.getUint32(offset + 1, false);
    const payload = bytes.slice(offset + 5, offset + 5 + length);
    records.push(kind === 1 ? new TextDecoder().decode(payload) : payload.buffer);
    offset += 5 + length;
  }
  return records;
}

export interface FakeCanvas {
  width: number;
  height: number;
  readonly draws: Array<{ source: unknown; width: number; height: number }>;
  getContext(kind: string): { drawImage(source: unknown, x: number, y: number, w: number, h: number): void };
}

export function fakeCanvas(): FakeCanvas & HTMLCanvasElement {
  const draws: FakeCanvas["draws"] = [];
  const canvas: FakeCanvas = {
    width: 300,
    height: 150,
    draws,
    getContext: () => ({
      drawImage: (source, _x, _y, width, height) => {
        draws.push({ source, width, height });
      }
    })
  };
  return canvas as FakeCanvas & HTMLCanvasElement;
}

export interface FakeSocket {
  readonly url: string;
  readyState: number;
  binaryType: string;
  readonly sent: Array<string | Uint8Array>;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Test drivers. */
  serverOpen(): void;
  receive(data: string | ArrayBuffer): void;
  serverClose(code: number, reason?: string): void;
  /** JSON payloads sent as text. */
  json(): unknown[];
}

export function fakeWebSocketClass() {
  const instances: FakeSocket[] = [];
  class FakeWebSocket implements FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = "blob";
    readonly sent: Array<string | Uint8Array> = [];
    onopen: FakeSocket["onopen"] = null;
    onmessage: FakeSocket["onmessage"] = null;
    onclose: FakeSocket["onclose"] = null;
    onerror: FakeSocket["onerror"] = null;

    constructor(readonly url: string) {
      instances.push(this);
    }

    send(data: string | Uint8Array): void {
      if (this.readyState !== 1) throw new Error("not open");
      this.sent.push(data);
    }

    close(code = 1000, reason = ""): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }

    serverOpen(): void {
      this.readyState = 1;
      this.onopen?.({});
    }

    receive(data: string | ArrayBuffer): void {
      this.onmessage?.({ data });
    }

    serverClose(code: number, reason = ""): void {
      this.close(code, reason);
    }

    json(): unknown[] {
      return this.sent.filter((data): data is string => typeof data === "string").map((data) => JSON.parse(data));
    }
  }
  return { WebSocket: FakeWebSocket as unknown as typeof WebSocket, instances };
}

export interface FakeChunk {
  readonly type: "key" | "delta";
  readonly timestamp: number;
  readonly data: Uint8Array;
}

export interface FakeDecoderLog {
  readonly supportQueries: string[];
  readonly configs: VideoDecoderConfig[];
  readonly chunks: FakeChunk[];
  readonly instances: Array<{ fail(error: Error): void; state: string; decodeQueueSize: number }>;
}

/**
 * A VideoDecoder that "decodes" each chunk into a frame of `size` at once
 * (unless `output: false`). `supported` decides `isConfigSupported`.
 */
export function fakeVideoDecoderClass(
  options: { supported?: (codec: string) => boolean; output?: boolean; size?: { width: number; height: number } } = {}
) {
  const log: FakeDecoderLog = { supportQueries: [], configs: [], chunks: [], instances: [] };
  const size = options.size ?? { width: 720, height: 1280 };
  class FakeVideoDecoder {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0;

    constructor(private readonly init: VideoDecoderInit) {
      log.instances.push(this);
    }

    static async isConfigSupported(config: VideoDecoderConfig) {
      log.supportQueries.push(config.codec);
      return { supported: options.supported?.(config.codec) ?? true, config };
    }

    configure(config: VideoDecoderConfig): void {
      if (this.state === "closed") throw new Error("closed");
      log.configs.push(config);
      this.state = "configured";
    }

    decode(chunk: FakeChunk): void {
      log.chunks.push(chunk);
      if (options.output === false) return;
      this.init.output({ displayWidth: size.width, displayHeight: size.height, close() {} } as unknown as VideoFrame);
    }

    close(): void {
      this.state = "closed";
    }

    fail(error: Error): void {
      this.init.error(error as DOMException);
    }
  }
  class FakeEncodedVideoChunk implements FakeChunk {
    readonly type: "key" | "delta";
    readonly timestamp: number;
    readonly data: Uint8Array;
    constructor(init: { type: "key" | "delta"; timestamp: number; data: Uint8Array }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.data = init.data;
    }
  }
  return {
    VideoDecoder: FakeVideoDecoder as unknown as typeof VideoDecoder,
    EncodedVideoChunk: FakeEncodedVideoChunk as unknown as typeof EncodedVideoChunk,
    log
  };
}

/** `createImageBitmap` stand-in: the bitmap's size comes from `sizeOf(bytes)`; `gate` holds a decode until released. */
export function fakeImageBitmaps(sizeOf: (bytes: Uint8Array) => { width: number; height: number } = () => ({ width: 402, height: 874 })) {
  const decoded: Uint8Array[] = [];
  let gate: Promise<void> | null = null;
  const createImageBitmap = async (blob: Blob): Promise<ImageBitmap> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (gate) await gate;
    decoded.push(bytes);
    const { width, height } = sizeOf(bytes);
    return { width, height, close() {} } as ImageBitmap;
  };
  return {
    // Stream callers use only Blob inputs; the browser overload remains the installed boundary.
    createImageBitmap: createImageBitmap as typeof globalThis.createImageBitmap,
    decoded,
    /** Hold decodes until the returned release is called. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    }
  };
}

/** A fetch whose response body is fed by the test. */
export function fakeStreamingFetch() {
  const requests: Array<{ url: string; init: RequestInit | undefined; push(bytes: Uint8Array): void; end(): void }> = [];
  let status = 200;
  let contentType = "application/octet-stream";
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      }
    });
    const request = {
      url: String(input),
      init,
      push: (bytes: Uint8Array) => controller.enqueue(bytes),
      end: () => controller.close()
    };
    init?.signal?.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // Already closed.
      }
    });
    requests.push(request);
    return new Response(status === 200 ? body : null, { status, headers: { "content-type": contentType } });
  };
  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    respondWith(nextStatus: number, nextContentType = contentType) {
      status = nextStatus;
      contentType = nextContentType;
    }
  };
}

const savedApis = new Map<string, PropertyDescriptor | undefined>();

/** Control the actual browser boundary; restore after each isolated test. */
export function browserApis(overrides: Partial<Pick<typeof globalThis, "fetch" | "WebSocket" | "createImageBitmap" | "VideoDecoder" | "EncodedVideoChunk" | "requestAnimationFrame" | "cancelAnimationFrame">>): void {
  for (const [name, value] of Object.entries(overrides)) {
    if (!savedApis.has(name)) savedApis.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  mock.method(performance, "now", () => Date.now());
  mock.method(Math, "random", () => 1);
}

export function restoreBrowserApis(): void {
  for (const [name, descriptor] of savedApis) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  savedApis.clear();
  mock.restoreAll();
}

/** Let pending promise callbacks run (real setImmediate; tests mock only timers they tick). */
export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}
