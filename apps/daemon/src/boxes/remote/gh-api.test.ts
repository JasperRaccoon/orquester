import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { duplexPair } from "node:stream";
import test, { after, before } from "node:test";

import type { StoredBox } from "@orquester/config";

import type { BoxChannelHandler, BoxRequestContext } from "../contracts.ts";
import { boxGhLogin, registerBoxGhApi, type BoxGhAccount } from "./gh-api.ts";

const TOKEN = "ghp_hostOnlyToken";

const projectRecord = (workspace: string): StoredBox => ({
  id: "box-1",
  purpose: "project",
  kind: "linux",
  provider: "hetzner",
  region: "fsn1",
  size: "cx22",
  name: "orq-box-1",
  createdAt: "2026-10-20T00:00:00.000Z",
  state: "ready",
  project: { workspace, name: "app", path: `/srv/ws/${workspace}/app` }
});

const context = (record: StoredBox): BoxRequestContext => ({ boxId: record.id, record });
const temporary = (): StoredBox => ({ ...projectRecord("acme"), id: "box-2", purpose: "temporary", project: null, threadId: "t-1" });

const ACCOUNTS: Record<string, BoxGhAccount> = {
  acme: { provider: "github", login: "octocat", token: TOKEN },
  "ssh-only": { provider: "github", login: "keys-only" },
  bitbucket: { provider: "bitbucket-cloud", login: "bb", token: "bb-token" }
};

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Stands for every GitHub host: records what reached it and answers with a body that names the host. */
let github: Server;
let seen: Seen[] = [];
let serve: BoxChannelHandler;

before(async () => {
  github = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json", "x-github-request-id": "r1" });
      res.end(JSON.stringify({ via: req.headers.host }));
    });
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  const port = (github.address() as AddressInfo).port;
  registerBoxGhApi(
    {
      handleChannel: (_kind, handler) => {
        serve = handler;
      }
    },
    { workspaceAccount: async (workspace) => ACCOUNTS[workspace] ?? null, origin: () => `http://127.0.0.1:${port}` }
  );
});

after(() => {
  github.close();
});

/** One `gh` request from a box: an HTTP client on the box's end of a `gh-api` channel. */
async function gh(
  record: StoredBox,
  options: { method?: string; host: string; path: string; body?: string }
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  seen = [];
  const [boxEnd, hostEnd] = duplexPair();
  serve(context(record), { kind: "gh-api" }, hostEnd);
  const req = request({
    createConnection: () => boxEnd as never,
    method: options.method ?? "GET",
    path: options.path,
    headers: { host: options.host, authorization: "token held-by-the-orquester-host", connection: "close", "user-agent": "GitHub CLI 2.95.0" }
  });
  req.end(options.body);
  const [res] = (await once(req, "response")) as [import("node:http").IncomingMessage];
  let body = "";
  res.on("data", (chunk: Buffer) => (body += chunk.toString()));
  await once(res, "end");
  return { status: res.statusCode ?? 0, headers: res.headers, body };
}

test("gh in a project box reaches the GitHub API as the workspace account, and the box never sees the token", async () => {
  const query = JSON.stringify({ query: "{viewer{login}}" });
  const reply = await gh(projectRecord("acme"), { method: "POST", host: "api.github.com", path: "/graphql", body: query });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), { via: "api.github.com" });
  assert.equal(reply.headers["x-github-request-id"], "r1");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "/graphql");
  assert.equal(seen[0]!.body, query);
  assert.equal(seen[0]!.headers.authorization, `token ${TOKEN}`);
  assert.equal(seen[0]!.headers["user-agent"], "GitHub CLI 2.95.0");
  assert.ok(!JSON.stringify(reply).includes(TOKEN));

  // GitHub's own answer, errors included, is the box's answer.
  assert.equal((await gh(projectRecord("acme"), { host: "api.github.com", path: "/missing" })).status, 404);
  assert.deepEqual(await boxGhLogin(context(projectRecord("acme")), { workspaceAccount: async (workspace) => ACCOUNTS[workspace] ?? null }), {
    host: "github.com",
    user: "octocat"
  });
});

test("a box with no GitHub token to broker gets no gh login, and its requests stop at the host", async () => {
  const deps = { workspaceAccount: async (workspace: string) => ACCOUNTS[workspace] ?? null };
  for (const record of [temporary(), projectRecord("ssh-only"), projectRecord("bitbucket"), projectRecord("unbound")]) {
    assert.equal(await boxGhLogin(context(record), deps), null);
    const reply = await gh(record, { host: "api.github.com", path: "/user" });
    assert.equal(reply.status, 401);
    assert.match((JSON.parse(reply.body) as { message: string }).message, /GitHub/);
    assert.deepEqual(seen, []);
  }
});

test("the token goes to GitHub's API hosts only: download hosts get none, and any other host is refused", async () => {
  // A release asset or a run log: the API redirects gh to a signed URL on a storage host.
  for (const host of ["objects.githubusercontent.com", "productionresultssa1.blob.core.windows.net"]) {
    const reply = await gh(projectRecord("acme"), { host, path: "/asset?sig=1" });
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { via: host });
    assert.equal(seen[0]!.headers.authorization, undefined);
  }
  await gh(projectRecord("acme"), { method: "POST", host: "uploads.github.com", path: "/repos/o/r/releases/1/assets", body: "bytes" });
  assert.equal(seen[0]!.headers.authorization, `token ${TOKEN}`);

  for (const [host, path] of [
    ["attacker.example", "/"],
    ["api.github.com.attacker.example", "/"],
    ["127.0.0.1:8080", "/"],
    ["api.github.com", "http://attacker.example/"]
  ] as const) {
    const reply = await gh(projectRecord("acme"), { host, path });
    assert.ok(reply.status === 403 || reply.status === 400, `${host} ${path} → ${reply.status}`);
    assert.deepEqual(seen, [], `${host} ${path} must not be forwarded`);
  }
});
