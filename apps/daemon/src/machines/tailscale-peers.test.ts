import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTailnetReader, localApiStatusSource } from "./tailscale-peers.ts";

const STATUS = readFileSync(new URL("./fixtures/localapi-status.json", import.meta.url), "utf8");

test("the LocalAPI status over tailscaled's socket: Self and every peer, with MagicDNS names, OS, online, last seen and IPv4 first", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-tailnet-"));
  const socket = join(dir, "tailscaled.sock");
  const seen: { path?: string; host?: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, host: req.headers.host });
    res.writeHead(200, { "content-type": "application/json" }).end(STATUS);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const read = await createTailnetReader({ localApi: localApiStatusSource(socket), cli: () => Promise.reject(new Error("not used")) })();
  assert.deepEqual(seen, [{ path: "/localapi/v0/status", host: "local-tailscaled.sock" }]);
  assert.ok(read.ok);
  assert.equal(read.via, "localapi");
  assert.equal(read.status.self?.stableId, "nSELF0000CNTRL");
  assert.equal(read.status.self?.dnsName, "orquester-host.tail0000.ts.net");
  const byHost = new Map(read.status.peers.map((peer) => [peer.hostName, peer]));
  assert.deepEqual(byHost.get("jasper"), {
    stableId: "nJASPER000CNTRL",
    hostName: "jasper",
    dnsName: "jasper.tail0000.ts.net",
    os: "linux",
    online: true,
    lastSeenAt: null,
    tailnetIps: ["100.64.0.2", "fd7a:115c:a1e0::2"]
  });
  assert.equal(byHost.get("Eduard’s MacBook Pro")?.os, "macos");
  assert.equal(byHost.get("Eduard’s MacBook Pro")?.dnsName, "eduards-macbook-pro.tail0000.ts.net");
  const minipc = byHost.get("minipc-desktop-0000000");
  assert.equal(minipc?.online, false);
  assert.equal(minipc?.lastSeenAt, "2026-11-21T18:30:00.000Z");
  assert.equal(byHost.get("iphone")?.os, "other");
  assert.equal(read.status.peers.length, 4);
});

test("no socket: tailscale status --json is read instead; neither: tailscale-unavailable with its fix; a stopped backend names `tailscale up`", async () => {
  const noSocket = () => Promise.reject(Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));
  const viaCli = await createTailnetReader({ localApi: noSocket, cli: async () => STATUS })();
  assert.ok(viaCli.ok);
  assert.equal(viaCli.via, "cli");
  assert.equal(viaCli.status.peers.length, 4);

  const neither = await createTailnetReader({ localApi: noSocket, cli: () => Promise.reject(new Error("spawn tailscale ENOENT")) })();
  assert.ok(!neither.ok);
  assert.equal(neither.problem.code, "tailscale-unavailable");
  assert.match(neither.problem.fix ?? "", /tailscale up/);

  const garbage = await createTailnetReader({ localApi: async () => "<html>", cli: () => Promise.reject(new Error("no")) })();
  assert.ok(!garbage.ok);

  const stopped = await createTailnetReader({ localApi: async () => JSON.stringify({ BackendState: "NeedsLogin", Peer: JSON.parse(STATUS).Peer }), cli: async () => STATUS })();
  assert.ok(!stopped.ok, "a logged-out daemon's stale peer map is not read as the tailnet");
  assert.equal(stopped.problem.code, "tailscale-unavailable");
  assert.match(stopped.problem.message, /NeedsLogin/);
});
