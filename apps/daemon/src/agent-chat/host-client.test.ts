import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { isUploadTooLarge, UploadTooLargeError } from "../upload-stream.ts";
import { agentHostRoutes } from "../agent-host/host-protocol.ts";
import { agentHostExtraRoutes } from "../agent-host/server/extra-routes.ts";
import {
  AgentHostClient,
  HostUnavailableError,
  RoutingHostClient,
  type HostClient,
  type HostJsonResponse,
  type HostStream
} from "./host-client.ts";
import type { HostDirectory, HostEndpoint, HostRole } from "./host-directory.ts";

// The host client reports every failed request as HOST_UNAVAILABLE. The one
// failure that is the CALLER's rather than the host's — a chat upload's body
// passing the daemon's cap (§6.3) — must still be tellable from a host that is
// gone, so it rides the wrapper as its `cause`, and `isUploadTooLarge` reads it
// there.

test("a body that fails before the host answers rejects as HOST_UNAVAILABLE, carrying the body's own error as its cause", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-host-client-"));
  const socketPath = join(dir, "host.sock");
  // Like the agent host's attachment route, this host answers only once the
  // whole body is in, so the body fails while `open()` still waits for headers.
  const host = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end("{}"));
  });
  await new Promise<void>((resolve) => host.listen(socketPath, resolve));
  t.after(async () => {
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const client = new AgentHostClient({ socketPath, token: () => "token" });
  const body = new Readable({ read() {} });
  const opened = client.open("POST", "/threads/t1/attachments", { body, timeoutMs: 0 });
  body.push(Buffer.from("the first bytes"));
  const tooLarge = new UploadTooLargeError();
  body.destroy(tooLarge);

  const error = await opened.then(
    () => assert.fail("open() resolved for a body that failed"),
    (rejection: unknown) => rejection
  );
  assert.ok(error instanceof HostUnavailableError, `expected HostUnavailableError, got ${String(error)}`);
  assert.equal(error.code, "HOST_UNAVAILABLE");
  assert.equal(error.cause, tooLarge, "the body's own error, kept whole");
  assert.equal(isUploadTooLarge(error), true);
});

test("upload cap classification does not mistake timeouts, cancellation or message text for a size refusal", () => {
  assert.equal(isUploadTooLarge(new HostUnavailableError("agent host request timed out")), false);
  assert.equal(isUploadTooLarge(new Error("aborted")), false);
  assert.equal(isUploadTooLarge(new UploadTooLargeError().message), false, "its message alone is not the refusal");
});

// Host updates (spec 2026-11-01 P2.4 R24): the routing client over several hosts.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

interface FakeAnswer {
  status: number;
  body?: unknown;
  /** Sent as-is instead of `body` as JSON (an NDJSON stream). */
  raw?: string;
}

/** One host's socket, faked at the {@link HostClient} seam: it records what it is sent. */
class FakeHost implements HostClient {
  readonly sent: Sent[] = [];
  aborted = 0;
  constructor(public answer: (sent: Sent) => FakeAnswer) {}

  async json<T>(method: string, path: string, body?: unknown): Promise<HostJsonResponse<T>> {
    const answer = this.record({ method, path, body });
    const raw = answer.raw ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
    return { status: answer.status, value: answer.body === undefined ? null : (answer.body as T), raw };
  }

  async open(method: string, path: string, init: { body?: string | Buffer | Readable } = {}): Promise<HostStream> {
    const answer = this.record({ method, path, body: init.body instanceof Readable ? "<stream>" : init.body });
    const raw = answer.raw ?? JSON.stringify(answer.body ?? null);
    return {
      status: answer.status,
      body: Readable.from([Buffer.from(raw)]),
      abort: () => {
        this.aborted += 1;
      }
    };
  }

  private record(sent: Sent): FakeAnswer {
    this.sent.push(sent);
    return this.answer(sent);
  }
}

function endpoint(generation: number, role: HostRole, client: HostClient): HostEndpoint {
  return { generation, role, client };
}

/**
 * A directory over fixed hosts: `owners` maps a thread to the generation that owns it (else the
 * primary). `onStale` is what the supervisor's re-read finds — an adoption, say.
 */
function fakeDirectory(
  hosts: HostEndpoint[],
  owners: Map<string, number>,
  onStale: (threadId: string, generation: number) => void = () => undefined
): HostDirectory & { stale: Array<[string, number]>; list: HostEndpoint[] } {
  const directory = {
    stale: [] as Array<[string, number]>,
    list: hosts,
    primary: () => directory.list.find((host) => host.role === "primary") ?? null,
    hosts: () => directory.list,
    hostForThread: async (threadId: string) => {
      const owner = owners.get(threadId);
      return directory.list.find((host) => host.generation === owner) ?? directory.primary();
    },
    ownershipStale: async (threadId: string, generation: number) => {
      directory.stale.push([threadId, generation]);
      onStale(threadId, generation);
    }
  };
  return directory;
}

const notOwned: FakeAnswer = { status: 409, body: { error: { code: "THREAD_NOT_OWNED", message: "Thread 't1' belongs to another agent host." } } };
const retiringRefusal: FakeAnswer = { status: 409, body: { error: { code: "HOST_RETIRING", message: "This agent host is retiring." } } };

async function textOf(stream: HostStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString("utf8");
}

test("a thread's requests reach the host that owns it (its id decoded), and every other request the primary", async () => {
  const id = "a/b c?";
  const retiring = new FakeHost(() => ({ status: 200, body: { from: 1 } }));
  const primary = new FakeHost(() => ({ status: 200, body: { from: 2 } }));
  const client = new RoutingHostClient(
    fakeDirectory([endpoint(2, "primary", primary), endpoint(1, "retiring", retiring)], new Map([[id, 1]]))
  );

  assert.deepEqual((await client.json("GET", agentHostExtraRoutes.summary(id))).value, { from: 1 });
  await client.json("POST", agentHostRoutes.turn(id), { commandId: "c1" });
  await client.json("GET", `${agentHostRoutes.read(id)}?after=3`);
  assert.equal(await textOf(await client.open("GET", agentHostRoutes.events(id))), JSON.stringify({ from: 1 }));
  await client.json("GET", agentHostRoutes.read("someone-else"));
  await client.json("POST", agentHostRoutes.createThread, { title: "new" });
  await client.json("GET", agentHostRoutes.providers);
  await client.json("GET", `${agentHostRoutes.search}?q=x`);

  assert.deepEqual(
    retiring.sent.map((sent) => sent.path),
    [agentHostExtraRoutes.summary(id), agentHostRoutes.turn(id), `${agentHostRoutes.read(id)}?after=3`, agentHostRoutes.events(id)]
  );
  assert.deepEqual(
    primary.sent.map((sent) => sent.path),
    [agentHostRoutes.read("someone-else"), agentHostRoutes.createThread, agentHostRoutes.providers, `${agentHostRoutes.search}?q=x`]
  );
});

test("THREAD_NOT_OWNED refreshes ownership, then sends the same request once more to the thread's new owner", async () => {
  const owners = new Map([["t1", 1]]);
  const retiring = new FakeHost(() => notOwned);
  const primary = new FakeHost(() => ({ status: 200, body: { accepted: true } }));
  // The refresh finds the release and completes the adoption: the primary owns t1 now.
  const directory = fakeDirectory([endpoint(2, "primary", primary), endpoint(1, "retiring", retiring)], owners, (id) => owners.delete(id));
  const client = new RoutingHostClient(directory);

  const response = await client.json("POST", agentHostRoutes.turn("t1"), { commandId: "c1", text: "go on" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.value, { accepted: true });
  assert.deepEqual(directory.stale, [["t1", 1]]);
  assert.equal(retiring.sent.length, 1);
  assert.deepEqual(primary.sent, [{ method: "POST", path: agentHostRoutes.turn("t1"), body: { commandId: "c1", text: "go on" } }]);
});

test("a second misroute answers HOST_UNAVAILABLE: one retry, never a loop, and never the host's own code", async () => {
  const owners = new Map([["t1", 1]]);
  const retiring = new FakeHost(() => notOwned);
  const primary = new FakeHost(() => notOwned);
  // Each refresh names the other host: a loop would bounce forever.
  const directory = fakeDirectory([endpoint(2, "primary", primary), endpoint(1, "retiring", retiring)], owners, (id, generation) =>
    owners.set(id, generation === 1 ? 2 : 1)
  );
  const client = new RoutingHostClient(directory);

  const error = await client.json("POST", agentHostRoutes.turn("t1"), { commandId: "c1" }).then(
    () => assert.fail("a misrouted request resolved"),
    (rejection: unknown) => rejection
  );
  assert.ok(error instanceof HostUnavailableError, `expected HostUnavailableError, got ${String(error)}`);
  assert.equal(retiring.sent.length + primary.sent.length, 2, "the first send and one retry");
  assert.deepEqual(directory.stale, [["t1", 1], ["t1", 2]], "the last misroute still marks ownership stale");

  // A global route has no thread to re-resolve: no retry at all.
  const only = new FakeHost(() => notOwned);
  const global = new RoutingHostClient(fakeDirectory([endpoint(3, "primary", only)], new Map()));
  await assert.rejects(global.json("POST", agentHostRoutes.recycleIdleOpenCode, {}), HostUnavailableError);
  assert.equal(only.sent.length, 1);
});

test("THREAD_NOT_OWNED about another thread than the path's answers HOST_UNAVAILABLE, and moves nothing", async () => {
  // Forking t1 touches t-src, which another host owns: t1's own owner is not in question.
  const otherThread: FakeAnswer = {
    status: 409,
    body: { error: { code: "THREAD_NOT_OWNED", message: "Thread 't-src' belongs to another agent host.", detail: { threadId: "t-src" } } }
  };
  const primary = new FakeHost(() => otherThread);
  const directory = fakeDirectory([endpoint(2, "primary", primary)], new Map());
  const client = new RoutingHostClient(directory);

  await assert.rejects(client.json("POST", agentHostRoutes.turn("t1"), { commandId: "c1" }), HostUnavailableError);
  await assert.rejects(client.open("GET", agentHostRoutes.events("t1")), HostUnavailableError);
  assert.equal(primary.sent.length, 2, "not retried");
  assert.deepEqual(directory.stale, [], "t1's ownership is not marked stale, so nothing is released or adopted");
});

test("HOST_RETIRING sends a create or a fork once more, to the primary", async () => {
  const old = new FakeHost(() => retiringRefusal);
  const fresh = new FakeHost(({ path }) => ({ status: 200, body: { createdBy: 2, path } }));
  const directory = fakeDirectory([endpoint(1, "primary", old)], new Map([["parent", 1]]));
  // The switch completes while the create is in flight: the old primary retired, a new one leads.
  old.answer = () => {
    directory.list = [endpoint(2, "primary", fresh), endpoint(1, "retiring", old)];
    return retiringRefusal;
  };
  const client = new RoutingHostClient(directory);

  assert.deepEqual((await client.json("POST", agentHostRoutes.createThread, { title: "t" })).value, {
    createdBy: 2,
    path: agentHostRoutes.createThread
  });
  // A fork of a thread the retiring host still owns: it refuses the new thread, the primary forks.
  assert.equal((await client.json("POST", agentHostRoutes.forkThread("parent"), { commandId: "f1" })).status, 200);
  assert.deepEqual(old.sent.map((sent) => sent.path), [agentHostRoutes.createThread, agentHostRoutes.forkThread("parent")]);
  assert.deepEqual(fresh.sent.map((sent) => sent.path), [agentHostRoutes.createThread, agentHostRoutes.forkThread("parent")]);

  // The primary itself retiring has no one else to ask.
  const alone = new FakeHost(() => retiringRefusal);
  const single = new RoutingHostClient(fakeDirectory([endpoint(4, "primary", alone)], new Map()));
  await assert.rejects(single.json("POST", agentHostRoutes.createThread, {}), HostUnavailableError);
  assert.equal(alone.sent.length, 1);
});

test("open() re-routes a misrouted stream before the caller reads it, and hands any other 409 over intact", async () => {
  const owners = new Map([["t1", 1]]);
  const retiring = new FakeHost(() => notOwned);
  const snapshot = `${JSON.stringify({ kind: "snapshot", thread: { seq: 4 } })}\n`;
  const primary = new FakeHost(() => ({ status: 200, raw: snapshot }));
  const directory = fakeDirectory([endpoint(2, "primary", primary), endpoint(1, "retiring", retiring)], owners, (id) => owners.delete(id));
  const client = new RoutingHostClient(directory);

  const stream = await client.open("GET", agentHostRoutes.events("t1"), { headers: { accept: "application/x-ndjson" } });
  assert.equal(stream.status, 200);
  assert.equal(await textOf(stream), snapshot);
  assert.equal(retiring.aborted, 1, "the misrouted upstream is torn down");

  const conflict = { error: { code: "COMMAND_REJECTED", message: "not now" } };
  primary.answer = () => ({ status: 409, body: conflict });
  const refused = await client.open("GET", agentHostRoutes.events("t1"));
  assert.equal(refused.status, 409);
  assert.deepEqual(JSON.parse(await textOf(refused)), conflict);
  assert.equal(primary.sent.length, 2, "a conflict of the caller's is not retried");
});

test("a streamed upload is never resent: a misroute answers HOST_UNAVAILABLE and marks the thread's ownership stale", async () => {
  const owners = new Map([["t1", 1]]);
  const retiring = new FakeHost(() => notOwned);
  const primary = new FakeHost(() => ({ status: 200, body: { id: "att-1" } }));
  const directory = fakeDirectory([endpoint(2, "primary", primary), endpoint(1, "retiring", retiring)], owners, (id) => owners.delete(id));
  const client = new RoutingHostClient(directory);

  await assert.rejects(
    client.open("POST", agentHostExtraRoutes.putAttachment("t1"), { body: Readable.from([Buffer.from("bytes")]), timeoutMs: 0 }),
    HostUnavailableError
  );
  assert.equal(primary.sent.length, 0, "the body was half-sent once; it is not replayed");
  assert.equal(retiring.aborted, 1);
  assert.deepEqual(directory.stale, [["t1", 1]], "so the client's retry reaches the new owner");
  const retried = await client.open("POST", agentHostExtraRoutes.putAttachment("t1"), { body: Readable.from([Buffer.from("bytes")]) });
  assert.equal(retried.status, 200);
});

test("with no primary, every request it would serve answers HOST_UNAVAILABLE, and a retiring host still serves its own", async () => {
  const retiring = new FakeHost(() => ({ status: 200, body: {} }));
  const client = new RoutingHostClient(fakeDirectory([endpoint(1, "retiring", retiring)], new Map([["t1", 1]])));

  await assert.rejects(client.json("GET", agentHostRoutes.providers), HostUnavailableError);
  await assert.rejects(client.json("GET", agentHostRoutes.read("t2")), HostUnavailableError);
  await assert.rejects(client.open("GET", agentHostRoutes.events("t2")), HostUnavailableError);
  assert.equal((await client.json("GET", agentHostRoutes.read("t1"))).status, 200);
  assert.deepEqual(retiring.sent.map((sent) => sent.path), [agentHostRoutes.read("t1")]);
});
