import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agentHostAuthValue, daemonRoutesForHost } from "../host-protocol.ts";
import { BoxDaemonCallError, createDaemonBoxSyncClient, createDaemonBoxTokenSource } from "./daemon-client.ts";

interface Seen {
  path: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

async function daemon(answer: (seen: Seen, response: ServerResponse) => void): Promise<{ socketPath: string; seen: Seen[]; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "box-daemon-"));
  const socketPath = join(dir, "daemon.sock");
  const seen: Seen[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const entry = { path: request.url, authorization: request.headers.authorization, body: JSON.parse(body) as unknown };
      seen.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("a box token is asked on the broker's socket route with the host's bearer, and read field-wise", async () => {
  const fake = await daemon((_seen, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accessToken: "access", expiresAt: 1_800_000_000_000, extra: { chatgptAccountId: "ws-1", junk: 3 } }));
  });
  try {
    const tokens = createDaemonBoxTokenSource({ socketPath: () => fake.socketPath, token: "host-token" });
    const grant = await tokens.getToken({ boxId: "box-1", agent: "codex", accountId: "acct-1", minValidSeconds: 2700 });
    assert.deepEqual(grant, { accessToken: "access", expiresAt: 1_800_000_000_000, extra: { chatgptAccountId: "ws-1" } });
    assert.deepEqual(fake.seen, [
      {
        path: daemonRoutesForHost.boxToken,
        authorization: agentHostAuthValue("host-token"),
        body: { boxId: "box-1", agent: "codex", accountId: "acct-1", minValidSeconds: 2700 }
      }
    ]);
  } finally {
    await fake.close();
  }
});

test("a refusal keeps the broker's code and message; a daemon without the route says it cannot", async () => {
  const fake = await daemon((seen, response) => {
    if ((seen.body as { accountId?: string }).accountId === "gone") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "ACCOUNT_NOT_FOUND", message: "That account is gone." }));
      return;
    }
    response.writeHead(404).end();
  });
  try {
    const tokens = createDaemonBoxTokenSource({ socketPath: () => fake.socketPath, token: "t" });
    await assert.rejects(
      tokens.getToken({ boxId: "b", agent: "claude", accountId: "gone" }),
      (error: unknown) => error instanceof BoxDaemonCallError && error.code === "ACCOUNT_NOT_FOUND" && error.message === "That account is gone."
    );
    await assert.rejects(
      tokens.getToken({ boxId: "b", agent: "claude", accountId: "other" }),
      (error: unknown) => error instanceof BoxDaemonCallError && error.code === "NOT_SUPPORTED"
    );
  } finally {
    await fake.close();
  }
});

test("the sync seams are one socket route, one op each; an unreachable daemon is a clear failure", async () => {
  const fake = await daemon((_seen, response) => {
    response.writeHead(204).end();
  });
  try {
    const sync = createDaemonBoxSyncClient({ socketPath: () => fake.socketPath, token: "t" });
    await sync.ensureSynced("box-1", { agent: "grok", configRoots: ["/home/a"], threadId: "t1" });
    await sync.pushForResume("box-1", { agent: "grok", configRoot: "/home/a", cwd: "/w/p", sessionRef: "s1" });
    await sync.pullAfterTurn("box-1", { agent: "grok", configRoot: "/home/a", cwd: "/w/p", sessionRef: null });
    await sync.turnEnded("box-1", "t1");
    await sync.turnStarted("box-1", "t2");
    assert.deepEqual(
      fake.seen.map((entry) => [entry.path, (entry.body as { op: string }).op]),
      [
        [daemonRoutesForHost.boxSync, "ensureSynced"],
        [daemonRoutesForHost.boxSync, "pushForResume"],
        [daemonRoutesForHost.boxSync, "pullAfterTurn"],
        [daemonRoutesForHost.boxSync, "turnEnded"],
        [daemonRoutesForHost.boxSync, "turnStarted"]
      ]
    );
    assert.deepEqual(fake.seen.at(-1)?.body, { op: "turnStarted", boxId: "box-1", threadId: "t2" });
  } finally {
    await fake.close();
  }
  const gone = createDaemonBoxSyncClient({ socketPath: () => "/nonexistent/daemon.sock", token: "t" });
  await assert.rejects(gone.turnEnded("box-1", "t1"), (error: unknown) => error instanceof BoxDaemonCallError && error.code === "UNAVAILABLE");
});

test("a turn's start mark is bounded: an older daemon's 400 and a daemon that never answers both fail the call", async () => {
  const fake = await daemon((seen, response) => {
    if ((seen.body as { threadId?: string }).threadId === "old") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "INVALID_ARGUMENT", message: "Not a box sync request." }));
    }
    // Any other thread: never answered; the client's deadline ends the wait and drops the request.
  });
  try {
    const sync = createDaemonBoxSyncClient({ socketPath: () => fake.socketPath, token: "t", turnStartTimeoutMs: 50 });
    await assert.rejects(
      sync.turnStarted("box-1", "old"),
      (error: unknown) => error instanceof BoxDaemonCallError && error.code === "INVALID_ARGUMENT" && error.status === 400
    );
    await assert.rejects(sync.turnStarted("box-1", "stuck"), (error: unknown) => error instanceof BoxDaemonCallError && error.code === "TIMEOUT");
  } finally {
    await fake.close();
  }
});
