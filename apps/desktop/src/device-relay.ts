import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/**
 * Live devices for the desktop app's unix-socket connection. The panel streams with `WebSocket`,
 * `fetch` and `<img>`, which the renderer cannot point at a unix socket, so this main-process relay
 * gives it a loopback origin for exactly those routes and carries them to the daemon's socket.
 *
 * The socket behind it is full local control and loopback is open to every process on the machine,
 * so the relay passes only device media (never a pattern wider than these), and only with this
 * launch's token, in `Authorization: Bearer` or, for what a page cannot set headers on, `?token=`.
 * Neither reaches the daemon, and the renderer learns the token over IPC, never from argv.
 */

export interface DeviceRelay {
  /** `http://127.0.0.1:<port>`. */
  origin: string;
  token: string;
  close(): Promise<void>;
}

/** Any method: the hub proxy behind it owns the path and method allowlists. */
const HUB_PATH = /^\/api\/devices\/hosts\/[^/]+\/hub\/./;
const IMAGE_PATH = /^\/api\/devices\/leases\/[^/]+\/(?:screenshots\/[^/]+|thumbnail)$/;
const SOCKET_PATH = /^\/ws-device\/[^/]+\/./;

/** The page's origin is `file://` (or the dev server), so its requests are cross-origin. */
const CORS_HEADERS = { "access-control-allow-origin": "*" } as const;
const PREFLIGHT_HEADERS = {
  ...CORS_HEADERS,
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600"
} as const;

function sameToken(given: string | undefined, token: string): boolean {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The request's token and its daemon path. `URL` resolves dot segments, encoded ones too, so a path cannot climb out of what the patterns allow. Null: no URL at all. */
function parseTarget(req: IncomingMessage): { pathname: string; forwardPath: string; token: string | undefined } | null {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://relay.invalid");
  } catch {
    return null;
  }
  const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  const token = header ?? url.searchParams.get("token") ?? undefined;
  url.searchParams.delete("token");
  return { pathname: url.pathname, forwardPath: `${url.pathname}${url.search}`, token };
}

/** The daemon's router ends a path at `;`, so it would route another path than the one checked here. */
function allowedPath(pathname: string, pattern: RegExp): boolean {
  return !pathname.includes(";") && pattern.test(pathname);
}

function daemonHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const { authorization: _authorization, cookie: _cookie, host: _host, ...rest } = headers;
  return { ...rest, host: "localhost" };
}

function withoutCors(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith("access-control-")));
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { ...CORS_HEADERS, "content-length": "0" });
  res.end();
}

function refuseUpgrade(socket: Duplex, status: 400 | 401 | 404 | 502 | 503): void {
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function relayRequest(req: IncomingMessage, res: ServerResponse, socketPath: string, path: string): void {
  const upstream = http.request({ socketPath, path, method: req.method, headers: daemonHeaders(req.headers) }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, { ...withoutCors(answer.headers), ...CORS_HEADERS });
    answer.pipe(res);
    answer.on("error", () => res.destroy());
  });
  upstream.on("error", () => {
    if (res.headersSent) res.destroy();
    else refuse(res, 502);
  });
  // A stream the page stopped reading has no end of its own.
  res.on("close", () => upstream.destroy());
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

function relayUpgrade(req: IncomingMessage, client: Duplex, head: Buffer, socketPath: string, path: string): void {
  const upstream = http.request({ socketPath, path, method: "GET", headers: daemonHeaders(req.headers) });
  upstream.on("error", () => refuseUpgrade(client, 502));
  upstream.on("response", (answer) => {
    answer.resume();
    refuseUpgrade(client, 502);
  });
  upstream.on("upgrade", (answer, daemon, daemonHead) => {
    const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`];
    for (let i = 0; i < answer.rawHeaders.length; i += 2) lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
    client.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (daemonHead.length > 0) client.write(daemonHead);
    if (head.length > 0) daemon.write(head);
    daemon.on("error", () => client.destroy());
    daemon.on("close", () => client.destroy());
    client.on("close", () => daemon.destroy());
    daemon.pipe(client);
    client.pipe(daemon);
  });
  upstream.end();
}

/** Listen on a free loopback port. `socketPath` is read per request (the daemon may start later). */
export async function startDeviceRelay(socketPath: () => string | undefined): Promise<DeviceRelay> {
  const token = randomBytes(32).toString("base64url");
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, PREFLIGHT_HEADERS);
      res.end();
      return;
    }
    const target = parseTarget(req);
    if (!target) return refuse(res, 400);
    if (!sameToken(target.token, token)) return refuse(res, 401);
    const reads = req.method === "GET" || req.method === "HEAD";
    if (!allowedPath(target.pathname, HUB_PATH) && !(reads && allowedPath(target.pathname, IMAGE_PATH))) return refuse(res, 404);
    const path = socketPath();
    if (!path) return refuse(res, 503);
    relayRequest(req, res, path, target.forwardPath);
  });
  server.on("upgrade", (req, client, head) => {
    // Node leaves an upgraded socket's errors to us: any client can reset it, refused or not.
    client.on("error", () => client.destroy());
    const target = parseTarget(req);
    if (!target) return refuseUpgrade(client, 400);
    if (!sameToken(target.token, token)) return refuseUpgrade(client, 401);
    if (!allowedPath(target.pathname, SOCKET_PATH)) return refuseUpgrade(client, 404);
    const path = socketPath();
    if (!path) return refuseUpgrade(client, 503);
    relayUpgrade(req, client, head, path, target.forwardPath);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    token,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}
