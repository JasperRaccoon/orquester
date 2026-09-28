// Integration: code and shell blocks through the REAL sandbox (short-lived node/bash children), and
// the HTTP block against a local node:http server — all driven by the engine on the real clock.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { Clock } from "./contracts.ts";
import { createHttpExecutor } from "./nodes/http.ts";
import { createSandboxRunner } from "./sandbox/sandbox.ts";
import { edge, FakeProjects, InMemoryRunStore, node, workflow } from "./testing/fakes.ts";
import { createHarness } from "./testing/harness.ts";
import { waitForFileState } from "./testing/daemon-harness.ts";

const realClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  }
};

let root: string;
let projectPath: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "orq-wf-int-"));
  projectPath = join(root, "ws", "app");
  await mkdir(projectPath, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("integration: code and shell through the real sandbox", () => {
  test("a code block reads its context and secrets; the secret is redacted from its output", async () => {
    const projects = new FakeProjects();
    projects.existing.add(projectPath);
    const h = createHarness({
      workflows: [
        workflow(
          "w1",
          [
            node("T", "trigger.manual"),
            node("A", "code", {
              source:
                "export default async ({ input, nodes, secrets, run, project, log }) => { log('hello'); return { doubled: input.input.n * 2, trig: nodes.T.output.kind, token: secrets.TOKEN, run: typeof run.id, cwd: project.path }; }"
            })
          ],
          [edge("T", "A")],
          { project: { kind: "existing", projectPath } }
        )
      ],
      runStore: new InMemoryRunStore(join(root, "runs")),
      projects,
      clock: realClock as never,
      sandbox: createSandboxRunner({ appdirTmp: root }) as never
    });
    await h.secrets.set("TOKEN", "tok-123456");
    const { runId } = await h.engine.run("w1", { input: { n: 21 } });
    const result = await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.equal(result.status, "succeeded", JSON.stringify(run.blocks.A));
    assert.deepEqual(run.blocks.A!.output, { doubled: 42, trig: "manual", token: "«secret:TOKEN»", run: "string", cwd: projectPath });
    assert.ok((run.blocks.A!.logs?.stdoutBytes ?? 0) > 0, "log sizes reported");
    const logPath = await h.engine.nodeLogPath(runId!, "A", "stdout");
    assert.ok(logPath?.endsWith(join("nodes", "A", "1", "stdout.log")));
    assert.equal(h.engine.isNodeLogLive(runId!, "A"), false);
  });

  test("a throw fails the block with its message and stack; stop() stops the run", async () => {
    const projects = new FakeProjects();
    projects.existing.add(projectPath);
    const make = (source: string) =>
      createHarness({
        workflows: [workflow("w1", [node("T", "trigger.manual"), node("A", "code", { source })], [edge("T", "A")], { project: { kind: "existing", projectPath } })],
        runStore: new InMemoryRunStore(join(root, "runs")),
        projects,
        clock: realClock as never,
        sandbox: createSandboxRunner({ appdirTmp: root }) as never
      });
    let h = make("export default () => { throw new Error('boom') }");
    let { runId } = await h.engine.run("w1", {});
    let result = await h.engine.waitForRun(runId!);
    let run = (await h.engine.getRun(runId!))!;
    assert.equal(result.status, "failed");
    assert.equal(run.blocks.A!.error?.kind, "exception");
    assert.equal(run.blocks.A!.error?.message, "boom");
    assert.match(String((run.blocks.A!.error?.detail as { stack?: string }).stack), /boom/);

    h = make("export default ({ stop }) => { stop('enough'); }");
    ({ runId } = await h.engine.run("w1", {}));
    result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "stopped");
    assert.equal(result.error, "enough");

    h = make("export default () => new Promise(() => { setInterval(() => {}, 1000); })");
    h.store.put(
      workflow("w1", [node("T", "trigger.manual"), node("A", "code", { source: "export default () => new Promise(() => { setInterval(() => {}, 1000); })", timeoutMinutes: 0.01 })], [edge("T", "A")], {
        project: { kind: "existing", projectPath }
      })
    );
    ({ runId } = await h.engine.run("w1", {}));
    result = await h.engine.waitForRun(runId!);
    run = (await h.engine.getRun(runId!))!;
    assert.equal(run.blocks.A!.error?.kind, "timeout");
  });

  test("a shell block gets its env (secrets included), never a rendered script; exit codes map", async () => {
    const projects = new FakeProjects();
    projects.existing.add(projectPath);
    const h = createHarness({
      workflows: [
        workflow(
          "w1",
          [
            node("T", "trigger.manual"),
            node("Ok", "shell", { script: 'echo "who=$WHO key=$KEY"; echo oops >&2', env: [{ name: "WHO", value: "{{ trigger.input.who }}" }, { name: "KEY", value: "{{ secrets.API_KEY }}" }] }),
            node("Bad", "shell", { script: "echo partial; exit 3" })
          ],
          [edge("T", "Ok"), edge("Ok", "Bad")],
          { project: { kind: "existing", projectPath } }
        )
      ],
      runStore: new InMemoryRunStore(join(root, "runs")),
      projects,
      clock: realClock as never,
      sandbox: createSandboxRunner({ appdirTmp: root }) as never
    });
    await h.secrets.set("API_KEY", "key-abcdef");
    const { runId } = await h.engine.run("w1", { input: { who: "$(touch /tmp/pwned) ada" } });
    const result = await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    assert.deepEqual(run.blocks.Ok!.output, { stdout: "who=$(touch /tmp/pwned) ada key=«secret:API_KEY»\n", stderr: "oops\n", exitCode: 0 });
    assert.equal(run.blocks.Bad!.status, "failed");
    assert.equal(run.blocks.Bad!.error?.kind, "exit_code");
    assert.deepEqual(run.blocks.Bad!.output, { stdout: "partial\n", stderr: "", exitCode: 3 });
    assert.equal(result.status, "failed");
  });

  test("cancelling a run kills its shell promptly", async () => {
    const projects = new FakeProjects();
    projects.existing.add(projectPath);
    const h = createHarness({
      workflows: [workflow("w1", [node("T", "trigger.manual"), node("S", "shell", { script: 'echo $$ > "$READY"; sleep 30', env: [{ name: "READY", value: join(root, "child-ready") }] })], [edge("T", "S")], { project: { kind: "existing", projectPath } })],
      runStore: new InMemoryRunStore(join(root, "runs")),
      projects,
      clock: realClock as never,
      sandbox: createSandboxRunner({ appdirTmp: root }) as never
    });
    const { runId } = await h.engine.run("w1", {});
    const pid = Number(await waitForFileState(join(root, "child-ready"), () => readFile(join(root, "child-ready"), "utf8").catch(() => ""), (text) => /^\d+\s*$/.test(text)));
    await h.engine.cancel(runId!);
    const result = await h.engine.waitForRun(runId!);
    assert.equal(result.status, "cancelled");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});

describe("integration: the HTTP block against a local server", () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];

  before(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
        const url = new URL(req.url ?? "/", "http://x");
        switch (url.pathname) {
          case "/json":
            res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ hello: "world", q: url.searchParams.get("q") }));
            return;
          case "/text":
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("plain text");
            return;
          case "/redirect":
            res.writeHead(302, { location: "/json" });
            res.end();
            return;
          case "/missing":
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "nope" }));
            return;
          case "/big":
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("z".repeat(32 * 1024 * 1024 + 1));
            return;
          case "/hang":
            return; // never answers
          case "/echo":
            res.writeHead(201, { "content-type": "application/json" });
            res.end(JSON.stringify({ method: req.method, body, contentType: req.headers["content-type"] ?? null }));
            return;
          default:
            res.writeHead(500);
            res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const runHttp = async (config: Record<string, unknown>, options: { secrets?: Record<string, string>; input?: unknown } = {}) => {
    const h = createHarness({
      workflows: [workflow("w1", [node("T", "trigger.manual"), node("H", "http", config)], [edge("T", "H")])],
      clock: realClock as never,
      executors: { http: createHttpExecutor() }
    });
    for (const [name, value] of Object.entries(options.secrets ?? {})) await h.secrets.set(name, value);
    const { runId } = await h.engine.run("w1", { input: options.input ?? null });
    const result = await h.engine.waitForRun(runId!);
    const run = (await h.engine.getRun(runId!))!;
    return { result, block: run.blocks.H! };
  };

  test("JSON responses are parsed; query and headers are rendered (secrets allowed, redacted after)", async () => {
    const { block } = await runHttp(
      {
        url: `${base}/json`,
        query: [{ name: "q", value: "{{ trigger.input.q }}" }],
        headers: [{ name: "Authorization", value: "Bearer {{ secrets.TOKEN }}" }]
      },
      { secrets: { TOKEN: "abcd-efgh" }, input: { q: "a b&c" } }
    );
    assert.equal(block.status, "succeeded");
    const output = block.output as { status: number; body: unknown; headers: Record<string, string> };
    assert.equal(output.status, 200);
    assert.deepEqual(output.body, { hello: "world", q: "a b&c" });
    assert.match(output.headers["content-type"]!, /application\/json/);
    assert.equal(seen[seen.length - 1]!.headers.authorization, "Bearer abcd-efgh", "the real value went out");
  });

  test("text stays text; redirects are followed or not; statuses map", async () => {
    let { block } = await runHttp({ url: `${base}/text` });
    assert.equal((block.output as { body: unknown }).body, "plain text");
    ({ block } = await runHttp({ url: `${base}/redirect` }));
    assert.deepEqual((block.output as { body: unknown }).body, { hello: "world", q: null });
    ({ block } = await runHttp({ url: `${base}/redirect`, followRedirects: false, successStatuses: [302] }));
    assert.equal((block.output as { status: number }).status, 302);
    assert.equal(block.status, "succeeded");
    ({ block } = await runHttp({ url: `${base}/missing` }));
    assert.equal(block.status, "failed");
    assert.equal(block.error?.kind, "http_status");
    assert.deepEqual((block.output as { body: unknown }).body, { error: "nope" }, "the response rides the failure");
    ({ block } = await runHttp({ url: `${base}/missing`, successStatuses: [404] }));
    assert.equal(block.status, "succeeded");
  });

  test("bodies: JSON rendered from a value, form fields, text", async () => {
    let { block } = await runHttp({ method: "POST", url: `${base}/echo`, body: { kind: "json", value: "{{ trigger.input }}" } }, { input: { a: [1, 2] } });
    assert.deepEqual((block.output as { body: unknown }).body, { method: "POST", body: '{"a":[1,2]}', contentType: "application/json" });
    ({ block } = await runHttp({ method: "POST", url: `${base}/echo`, body: { kind: "json", value: '{"name": "{{ trigger.input }}"}' } }, { input: "ada" }));
    assert.equal(((block.output as { body: { body: string } }).body).body, '{"name": "ada"}');
    ({ block } = await runHttp({ method: "POST", url: `${base}/echo`, body: { kind: "json", value: '{"broken": {{ trigger.input }}' } }, { input: "x" }));
    assert.equal(block.error?.kind, "expression");
    ({ block } = await runHttp({ method: "PUT", url: `${base}/echo`, body: { kind: "form", fields: [{ name: "a", value: "1 2" }, { name: "b", value: "&" }] } }));
    assert.deepEqual((block.output as { body: unknown }).body, { method: "PUT", body: "a=1+2&b=%26", contentType: "application/x-www-form-urlencoded" });
    ({ block } = await runHttp({ method: "PATCH", url: `${base}/echo`, body: { kind: "text", value: "hi {{ trigger.input }}", contentType: "text/x-custom" } }, { input: "there" }));
    assert.deepEqual((block.output as { body: unknown }).body, { method: "PATCH", body: "hi there", contentType: "text/x-custom" });
  });

  test("the body cap, the timeout and a network error each fail the block with their kind", async () => {
    let { block } = await runHttp({ url: `${base}/big` });
    assert.equal(block.error?.kind, "limit_exceeded");
    ({ block } = await runHttp({ url: `${base}/hang`, timeoutSeconds: 0.2 }));
    assert.equal(block.error?.kind, "timeout");
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    ({ block } = await runHttp({ url: `http://127.0.0.1:${port}/` }));
    assert.equal(block.error?.kind, "network");
    ({ block } = await runHttp({ url: "{{ trigger.input }}" }, { input: "ftp://example.test/" }));
    assert.equal(block.error?.kind, "validation", "a rendered URL is checked at run time");
  });
});
