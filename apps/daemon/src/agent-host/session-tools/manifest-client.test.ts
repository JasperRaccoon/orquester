/**
 * The host's manifest read (unified MCP design 2026-10-15 §9.4, §14.1) over a real unix socket:
 * the daemon's manifest; a daemon without the route (its generic route-miss 404) → the legacy
 * definitions; a thread it has no tab for → none; anything else → unavailable (the fallback list).
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { daemonRoutesForHost } from "../host-protocol.ts";
import { createDaemonManifestClient } from "./forwarder.ts";

async function daemon(t: { after(fn: () => Promise<void> | void): void }, handle: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "umcp-manifest-"));
  const socketPath = join(dir, "daemon.sock");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handle(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return socketPath;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

test("the daemon's manifest, asked with the host's bearer for a launch", async (t) => {
  const seen: { path?: string; authorization?: string; body?: unknown }[] = [];
  const socketPath = await daemon(t, (req, body, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    json(res, 200, { tools: ["list_sessions"], instructions: "## Orquester", deny: ["remote"], toolsets: ["core"] });
  });
  const fetchManifest = createDaemonManifestClient({ socketPath: () => socketPath, token: "host-token" });
  assert.deepEqual(await fetchManifest("thread-1"), {
    kind: "manifest",
    manifest: { tools: ["list_sessions"], instructions: "## Orquester", deny: ["remote"], toolsets: ["core"] }
  });
  assert.deepEqual(seen, [{ path: daemonRoutesForHost.sessionToolsManifest, authorization: "Bearer host-token", body: { threadId: "thread-1", purpose: "launch" } }]);
});

test("404: the route-miss of an older daemon is legacy; our own THREAD_NOT_FOUND is no thread", async (t) => {
  let body: unknown = { message: "Route POST:/api/agent-host/session-tools/manifest not found", error: "Not Found", statusCode: 404 };
  const socketPath = await daemon(t, (_req, _body, res) => json(res, 404, body));
  const fetchManifest = createDaemonManifestClient({ socketPath: () => socketPath, token: "t" });
  assert.deepEqual(await fetchManifest("thread-1"), { kind: "legacy" });
  body = { code: "THREAD_NOT_FOUND", message: "No chat thread with that id." };
  assert.deepEqual(await fetchManifest("thread-1"), { kind: "no-thread" });
});

test("a refusal, a malformed manifest, a dead socket or a silent daemon: unavailable", async (t) => {
  let answer: [number, unknown] = [401, { code: "UNAUTHORIZED" }];
  let silent = false;
  const socketPath = await daemon(t, (_req, _body, res) => {
    if (silent) return;
    json(res, answer[0], answer[1]);
  });
  const fetchManifest = createDaemonManifestClient({ socketPath: () => socketPath, token: "t", timeoutMs: 200 });
  assert.deepEqual(await fetchManifest("x"), { kind: "unavailable" });
  answer = [200, { tools: "nope" }];
  assert.deepEqual(await fetchManifest("x"), { kind: "unavailable" });
  assert.deepEqual(await createDaemonManifestClient({ socketPath: () => join(tmpdir(), "no-such-orquester.sock"), token: "t" })("x"), { kind: "unavailable" });
  silent = true;
  assert.deepEqual(await fetchManifest("x"), { kind: "unavailable" }, "bounded: a session start never hangs on it");
});
