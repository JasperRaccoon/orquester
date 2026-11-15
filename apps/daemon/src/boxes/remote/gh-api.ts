/**
 * The GitHub CLI in a box, brokered by the host: what `git-auth.ts` is for git, for `gh`.
 *
 * A box never receives a git hosting token (owner decision, see `git-auth.ts`), so `gh` in a box
 * cannot hold a login. Instead `orq-agent` writes a `gh` config with no token in it whose
 * `http_unix_socket` sends every request of `gh`, as plain HTTP, to a socket it listens on
 * (`BoxAgentConfig.gh`, sent in the welcome: {@link boxGhLogin}), and each connection to that
 * socket arrives here as a `gh-api` channel. The host forwards the request to GitHub over TLS with
 * the workspace account's token in place of whatever `Authorization` the box sent, and streams the
 * answer back. The box can use the account through GitHub's API while it is connected, as it can
 * push with the account's key through the SSH agent, and has nothing to keep once it is gone.
 *
 * What a box can reach through this:
 * - GitHub's API hosts ({@link TOKEN_HOSTS}), with the token;
 * - the storage hosts the API redirects downloads to (release assets, run logs and artifacts:
 *   {@link DOWNLOAD_HOST_SUFFIXES}), WITHOUT the token;
 * - nothing else. The upstream host is always one of those names on port 443 and the request
 *   target is passed on as a path, so the channel is no way into the host's own network.
 *
 * Scope, as for the SSH agent: a project box uses ONLY its own workspace's account, and only a
 * GitHub account with a token; a temporary box gets nothing. The account is read again for every
 * request, so a token removed or replaced in Settings applies at once. Nothing here logs a
 * request, its headers or the token.
 */

import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import type { BoxGhConfig } from "@orquester/api";
import type { Account } from "@orquester/config";

import type { BoxHub, BoxRequestContext } from "../contracts.ts";
import { accountForBox } from "./git-auth.ts";

/** The account fields `gh` needs (host-only: it holds the token). */
export type BoxGhAccount = Pick<Account, "provider" | "login" | "token">;

export interface BoxGhApiDeps {
  /** The Git hosting account bound to the workspace named `workspace` (`workspaces.json` `gitAccountId`), or null. */
  workspaceAccount(workspace: string): Promise<BoxGhAccount | null>;
  /** Where requests for a GitHub host go (default `https://<host>`); tests point it at a local server. */
  origin?: (host: string) => string;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

/** The host `gh` in a box is logged in to. */
const GITHUB_HOST = "github.com";
/** GitHub's API hosts: requests to them carry the account's token. */
const TOKEN_HOSTS = new Set(["api.github.com", "uploads.github.com"]);
/** Storage hosts GitHub's API redirects `gh` to with a signed URL; requests to them carry no token. */
const DOWNLOAD_HOST_SUFFIXES = [".githubusercontent.com", ".blob.core.windows.net"];

/** Headers that belong to one connection, plus the ones this proxy sets itself. */
const NOT_FORWARDED = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "expect", "host", "authorization"]);

/** The GitHub account whose token the host may use for this box; null when it has none. */
async function ghAccountForBox(context: BoxRequestContext, deps: Pick<BoxGhApiDeps, "workspaceAccount">): Promise<(BoxGhAccount & { token: string }) | null> {
  const account = await accountForBox(context, deps);
  if (!account || account.provider !== "github" || !account.token) return null;
  return { ...account, token: account.token };
}

/** The `gh` login a box's welcome announces (`BoxAgentConfig.gh`); null leaves `gh` in the box alone. */
export async function boxGhLogin(context: BoxRequestContext, deps: Pick<BoxGhApiDeps, "workspaceAccount">): Promise<BoxGhConfig | null> {
  const account = await ghAccountForBox(context, deps);
  return account ? { host: GITHUB_HOST, user: account.login } : null;
}

/** Whether requests to `host` (a `Host` header, lower-case) are forwarded, and with the token. */
function routeFor(host: string): { token: boolean } | null {
  if (TOKEN_HOSTS.has(host)) return { token: true };
  if (/^[a-z0-9.-]+$/.test(host) && DOWNLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { token: false };
  return null;
}

function forwardedHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !NOT_FORWARDED.has(name)) out[name] = value;
  }
  return out;
}

/** An answer of the proxy itself, shaped like a GitHub API error so `gh` prints the message. */
function refuse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ message });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), connection: "close" });
  res.end(body);
}

async function forward(context: BoxRequestContext, req: IncomingMessage, res: ServerResponse, deps: BoxGhApiDeps): Promise<void> {
  const host = (req.headers.host ?? "").toLowerCase();
  const route = routeFor(host);
  if (!route) return refuse(res, 403, `Orquester forwards gh only to GitHub's API, not to ${host || "an unnamed host"}.`);
  // Origin form only: an absolute target would name its own host.
  const path = req.url ?? "";
  if (!path.startsWith("/")) return refuse(res, 400, "Orquester forwards gh requests by path only.");
  const account = await ghAccountForBox(context, deps);
  if (!account) return refuse(res, 401, "This box has no GitHub login: its workspace needs a GitHub account with a token (Settings → Git accounts).");

  const origin = new URL(deps.origin ? deps.origin(host) : `https://${host}`);
  const headers = forwardedHeaders(req.headers);
  headers.host = host;
  if (route.token) headers.authorization = `token ${account.token}`;
  const upstream = (origin.protocol === "http:" ? httpRequest : httpsRequest)({
    hostname: origin.hostname,
    port: origin.port || undefined,
    method: req.method,
    path,
    headers
  });
  upstream.once("response", (answer) => {
    res.writeHead(answer.statusCode ?? 502, forwardedHeaders(answer.headers));
    answer.pipe(res);
    answer.once("error", () => res.destroy());
  });
  upstream.once("error", (error: NodeJS.ErrnoException) => {
    deps.logger?.warn("box gh request failed upstream", { boxId: context.boxId, host, code: error.code ?? error.name });
    refuse(res, 502, "Orquester could not reach GitHub.");
  });
  // The box went away (or gh was interrupted): stop the upstream request too.
  res.once("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** Register the `gh-api` channel on the hub. */
export function registerBoxGhApi(hub: Pick<BoxHub, "handleChannel">, deps: BoxGhApiDeps): void {
  const contexts = new WeakMap<object, BoxRequestContext>();
  // Never listens: each channel is handed to it as a connection, and it parses the HTTP on it.
  const server = createServer((req, res) => {
    const context = contexts.get(req.socket);
    if (!context) return refuse(res, 500, "Orquester lost track of this box.");
    forward(context, req, res, deps).catch((error: unknown) => {
      deps.logger?.warn("box gh request failed", { boxId: context.boxId, error: error instanceof Error ? error.name : "error" });
      refuse(res, 502, "Orquester could not forward this request.");
    });
  });
  hub.handleChannel("gh-api", (context, _spec, stream: Duplex) => {
    contexts.set(stream, context);
    stream.on("error", () => {
      // the box side went away; the server drops the connection
    });
    server.emit("connection", stream);
  });
}
