/**
 * A client of one VM's vphoned API (`Research/vphoned_http_api.md` in vphone-cli), reached on this
 * machine's loopback through the box link (`BoxConnection.forwardToHost` of the VM's
 * `--api-listen 127.0.0.1:<port>`).
 *
 * - Every request carries the launch's token as `Authorization: Bearer` (the host proxy admits a
 *   connection by its first request head and strips the header before vphoned sees it).
 * - Never an `Origin` header: vphoned refuses any request that has one (403), WebSocket upgrades too.
 * - `POST` bodies are `application/json` (else 415). vphoned closes each HTTP connection after one
 *   reply, so no agent keep-alive.
 * - Methods marked **force** in vphoned's catalog (uninstall, reboot, kill, …) are never sent:
 *   {@link VphoneGuestClient.call} refuses any params carrying `force`.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { WebSocket } from "ws";

/** Where a VM's API answers on this machine, and its token (never logged, never in argv). */
interface VphoneGuestEndpoint {
  /** The loopback port that forwards to the VM's API. */
  port: number;
  token: string;
}

export class VphoneRpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "VphoneRpcError";
  }
}

export interface VphoneCallOptions {
  signal?: AbortSignal;
  /** Default 30 s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Answers larger than this are not vphoned's (a full-resolution screenshot is a few MiB). */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

let nextId = 1;

export class VphoneGuestClient {
  constructor(private readonly endpoint: VphoneGuestEndpoint) {}

  /** `GET /v1/health`: resolves its JSON once vphoned answers 200. */
  async health(options: VphoneCallOptions = {}): Promise<Record<string, unknown>> {
    const response = await this.http("GET", "/v1/health", null, options);
    if (response.status !== 200) throw new VphoneRpcError(`http_${response.status}`, `vphoned health answered ${response.status}`);
    return asRecord(parseJson(response.body)) ?? {};
  }

  /** `POST /v1/rpc`: the method's `result`, or a {@link VphoneRpcError} with vphoned's code. */
  async call(method: string, params: Record<string, unknown> = {}, options: VphoneCallOptions = {}): Promise<Record<string, unknown>> {
    assertSafeParams(params);
    const id = `orq-${nextId++}`;
    const response = await this.http("POST", "/v1/rpc", Buffer.from(JSON.stringify({ id, method, params }), "utf8"), options);
    const body = asRecord(parseJson(response.body));
    const error = asRecord(body?.error);
    if (error) throw new VphoneRpcError(typeof error.code === "string" ? error.code : "error", typeof error.message === "string" ? error.message : `${method} failed`);
    if (response.status !== 200 || !body) throw new VphoneRpcError(`http_${response.status}`, `${method} answered ${response.status}`);
    return asRecord(body.result) ?? {};
  }

  /** `PUT /v1/files/content?path=…`: stream `body` into a guest file (written to a temporary file, renamed when complete). */
  async putFile(guestPath: string, body: Readable, options: VphoneCallOptions & { mode?: string } = {}): Promise<void> {
    const query = new URLSearchParams({ path: guestPath, ...(options.mode ? { mode: options.mode } : {}) });
    const response = await this.http("PUT", `/v1/files/content?${query.toString()}`, body, { ...options, timeoutMs: options.timeoutMs ?? 30 * 60_000 }, "application/octet-stream");
    if (response.status < 200 || response.status >= 300) {
      const error = asRecord(asRecord(parseJson(response.body))?.error);
      throw new VphoneRpcError(typeof error?.code === "string" ? error.code : `http_${response.status}`, typeof error?.message === "string" ? error.message : `Upload answered ${response.status}`);
    }
  }

  /** A WebSocket on the API (`/v1/events`, `/v1/host/screen`), with the bearer and no Origin. */
  openSocket(path: "/v1/events" | "/v1/host/screen"): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${this.endpoint.port}${path}`, {
      headers: { authorization: `Bearer ${this.endpoint.token}` },
      perMessageDeflate: false,
      maxPayload: MAX_RESPONSE_BYTES
    });
  }

  private http(method: string, path: string, body: Buffer | Readable | null, options: VphoneCallOptions, contentType = "application/json"): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const headers: Record<string, string> = { authorization: `Bearer ${this.endpoint.token}`, connection: "close" };
      if (body) headers["content-type"] = contentType;
      if (Buffer.isBuffer(body)) headers["content-length"] = String(body.length);
      const req = httpRequest({ host: "127.0.0.1", port: this.endpoint.port, method, path, headers, agent: false });
      let settled = false;
      const finish = (error: Error | null, value?: { status: number; body: Buffer }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) {
          req.destroy();
          reject(error);
        } else resolve(value!);
      };
      const onAbort = () => finish(abortError());
      const timer = setTimeout(() => finish(new VphoneRpcError("timeout", `vphoned did not answer ${method} ${path.split("?")[0]} in time`)), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (error) => finish(new VphoneRpcError("unreachable", `vphoned is not reachable (${error.message})`)));
      req.on("response", (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            finish(new VphoneRpcError("too_large", "vphoned's answer is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(null, { status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on("error", (error) => finish(new VphoneRpcError("unreachable", error.message)));
      });
      if (body === null) req.end();
      else if (Buffer.isBuffer(body)) req.end(body);
      else pipeline(body, req).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
  }
}

/** Refuse anything that would confirm a **force** method. */
export function assertSafeParams(params: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(params, "force")) throw new VphoneRpcError("refused", "Orquester never sends vphoned's force methods.");
}

function abortError(): Error {
  const error = new Error("The request was cancelled.");
  error.name = "AbortError";
  return error;
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
