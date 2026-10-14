/**
 * Thread lineage × session tools (spec 2026-10-14 §1.2, §6), at the adapter:
 * a fork's child thread runs under its OWN per-thread `orquester-<key>`
 * registration and its own grant, and its ruleset allows only its own server —
 * never the parent's, whose ruleset OpenCode's fork may have copied.
 *
 * The REAL adapter and server pool against a real peer process (`testing/peer.ts`)
 * forwarding to an in-process OpenCode fake, as `recycle.test.ts` does. Nothing
 * sleeps: every wait is on a recorded request or a completed response.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdapterContext, StartSessionInput } from "../../adapter.ts";
import { recordingSessionTools } from "../../session-tools/testing.ts";
import { createOpenCodeAdapter } from "./index.ts";
import { openCodeSessionToolsServerName } from "./session-tools.ts";
import { makePeer } from "./testing/peer.ts";

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

interface Rule {
  permission: string;
  pattern: string;
  action: string;
}

/** The session routes a start, a fork and a stop use; every session holds one exchange. */
class FakeOpenCode {
  readonly requests: Recorded[] = [];
  readonly http = createServer((req, res) => {
    void this.handle(req, res);
  });
  private readonly sessions = new Map<string, { id: string; directory: string; permission?: Rule[] }>();
  private next = 0;

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://upstream.invalid");
    const method = req.method ?? "GET";
    const path = url.pathname;
    if (path === "/__peer/up") return json(res, {});
    const body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
    this.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      return;
    }
    if (path === "/mcp" || /^\/mcp\/[^/]+\/disconnect$/.test(path)) return json(res, {});
    if (path === "/session" && method === "POST") {
      const permission = (body as { permission?: Rule[] } | undefined)?.permission;
      return json(res, this.create(url, permission));
    }
    if (path === "/session/status") return json(res, {});
    const match = /^\/session\/([^/]+)(\/.*)?$/.exec(path);
    if (match !== null) {
      const record = this.sessions.get(match[1]!);
      const tail = match[2] ?? "";
      if (record === undefined) return json(res, { name: "NotFoundError", data: { message: "gone" } }, 404);
      if (tail === "" && method === "GET") return json(res, record);
      if (tail === "" && method === "PATCH") {
        record.permission = (body as { permission?: Rule[] } | undefined)?.permission ?? record.permission;
        return json(res, record);
      }
      if (tail === "/fork" && method === "POST") {
        // OpenCode's fork copies the source's settings — its ruleset included.
        return json(res, this.create(url, record.permission));
      }
      if (tail === "/message") {
        return json(res, [
          { info: { id: `msg_u_${record.id}`, role: "user" }, parts: [] },
          { info: { id: `msg_a_${record.id}`, role: "assistant" }, parts: [] }
        ]);
      }
      if (tail === "/children") return json(res, []);
      if (tail === "/abort") return json(res, true);
    }
    json(res, {}, 404);
  }

  private create(url: URL, permission: Rule[] | undefined) {
    this.next += 1;
    const record = {
      id: `ses_${this.next}`,
      directory: url.searchParams.get("directory") ?? "/repo",
      ...(permission !== undefined ? { permission } : {})
    };
    this.sessions.set(record.id, record);
    return record;
  }

  registrations(): Array<{ name: string; authorization: string }> {
    return this.requests
      .filter((request) => request.method === "POST" && request.path === "/mcp")
      .map((request) => {
        const body = request.body as { name: string; config: { headers: { Authorization: string } } };
        return { name: body.name, authorization: body.config.headers.Authorization };
      });
  }

  rulesetOf(sessionId: string): Rule[] {
    return this.sessions.get(sessionId)?.permission ?? [];
  }
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** The last rule matching `permission` decides, as OpenCode's own `disabled` reads a ruleset. */
function decides(ruleset: readonly Rule[], permission: string): string | undefined {
  const matches = (pattern: string): boolean =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(permission);
  return ruleset.filter((rule) => matches(rule.permission)).at(-1)?.action;
}

test("a fork's child registers its own server under its own grant, and its ruleset allows only that server", async (t) => {
  const fake = new FakeOpenCode();
  await new Promise<void>((resolve) => fake.http.listen(0, "127.0.0.1", resolve));
  const upstream = `http://127.0.0.1:${(fake.http.address() as AddressInfo).port}`;
  const peer = makePeer();
  const project = await mkdtemp(join(tmpdir(), "orq-opencode-fork-tools-"));
  const abort = new AbortController();
  const tools = recordingSessionTools();
  let ids = 0;
  const ctx: AdapterContext = {
    logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    clock: { now: () => new Date(0), nowIso: () => "2026-10-14T00:00:00.000Z" },
    ids: {
      eventId: () => `evt-${(ids += 1)}`,
      messageId: (prefix: string) => `${prefix}-${(ids += 1)}`,
      uuid: () => `uuid-${(ids += 1)}`
    },
    resolveAttachmentPath: async (_threadId, attachmentId) => join(peer.dir, attachmentId),
    attachmentsDir: () => peer.dir,
    logRawFrame: () => undefined,
    buildEnv: () => ({
      PATH: process.env.PATH ?? "",
      HOME: peer.dir,
      TMPDIR: peer.dir,
      MOCK_VERSION: "1.18.32",
      MOCK_UPSTREAM: upstream
    }),
    resolveBin: async () => peer.bin,
    sessionPath: () => "/usr/bin",
    tmpDir: () => peer.dir,
    signal: abort.signal,
    sessionTools: tools
  };
  const adapter = await createOpenCodeAdapter(ctx);
  // The host's one consumer of the adapter's stream.
  const events: unknown[] = [];
  const consumed = (async () => {
    for await (const event of adapter.events) events.push(event);
  })();
  t.after(async () => {
    await adapter.stopAll();
    abort.abort();
    await consumed;
    fake.http.closeAllConnections();
    await new Promise<void>((resolve) => fake.http.close(() => resolve()));
    peer.cleanup();
    await rm(project, { recursive: true, force: true });
  });
  const base: Omit<StartSessionInput, "threadId"> = {
    projectPath: project,
    cwd: project,
    home: { kind: "system", path: peer.dir },
    modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
    runtimeMode: "approval-required"
  };
  const parentName = openCodeSessionToolsServerName("parent");
  const childName = openCodeSessionToolsServerName("child");
  assert.notEqual(parentName, childName);

  const parent = await adapter.startSession({ ...base, threadId: "parent" });
  const parentSession = (parent.resumeCursor as { sessionId: string }).sessionId;
  assert.equal(decides(fake.rulesetOf(parentSession), `${parentName}_echo`), "allow");

  const forked = await adapter.forkConversation!({
    sourceThreadId: "parent",
    sourceResumeCursor: parent.resumeCursor,
    threadId: "child",
    projectPath: project,
    cwd: project,
    home: base.home,
    cut: { firstRemovedTurnId: null, retainedTurnIds: ["msg_u_x"] }
  });
  const childSession = (forked.resumeCursor as { sessionId: string }).sessionId;
  assert.notEqual(childSession, parentSession);
  assert.equal(tools.grants.length, 1, "a fork issues nothing");
  // What OpenCode copied: the parent's ruleset, which allows the parent's server.
  assert.equal(decides(fake.rulesetOf(childSession), `${parentName}_echo`), "allow");

  await adapter.startSession({ ...base, threadId: "child", resumeCursor: forked.resumeCursor });
  assert.deepEqual(
    tools.grants.map((grant) => grant.threadId),
    ["parent", "child"]
  );
  const [parentGrant, childGrant] = tools.grants;
  assert.notEqual(childGrant!.token, parentGrant!.token);
  assert.deepEqual(fake.registrations(), [
    { name: parentName, authorization: parentGrant!.authorization },
    { name: childName, authorization: childGrant!.authorization }
  ]);
  // The child's resume re-asserted its own ruleset: its server only.
  const childRules = fake.rulesetOf(childSession);
  assert.equal(decides(childRules, `${childName}_echo`), "allow");
  assert.equal(decides(childRules, `${parentName}_echo`), "deny", "never the parent's tools");
  // …and the parent's stays as it was.
  assert.equal(decides(fake.rulesetOf(parentSession), `${childName}_echo`), "deny");
  assert.equal(parentGrant!.revoked, false);
});
