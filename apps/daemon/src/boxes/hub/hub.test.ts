import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { boxRoutes, type BoxControlMessage } from "@orquester/api";

import { bootstrapSecondStage } from "../bootstrap/bootstrap.ts";
import type { VerifyGithubOidc } from "../contracts.ts";
import { hashSecret } from "./auth.ts";
import type { BoxAgentBuilds } from "./builds.ts";
import { createBoxHub, type BoxHubServer } from "./hub.ts";
import { BOX_HUB_PUBLIC_ROUTES } from "./routes.ts";
import { FakeBox, MemoryRecords, startHubServer } from "./test-helpers.ts";

const NOW = Date.parse("2026-10-20T10:00:00Z");

function fakeJwt(payload: Record<string, unknown>): string {
  const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", kid: "k" })}.${segment(payload)}.c2ln`;
}

function expectT<T extends BoxControlMessage["t"]>(message: BoxControlMessage, t: T): Extract<BoxControlMessage, { t: T }> {
  assert.equal(message.t, t, `expected ${t}, got ${JSON.stringify(message)}`);
  return message as Extract<BoxControlMessage, { t: T }>;
}

describe("box hub authentication", () => {
  let appdir: string;
  let records: MemoryRecords;
  let hub: BoxHubServer;
  let url: string;
  let close: () => Promise<void>;
  const oidcCalls: { jwt: string; repository: string; runId: string; audience: string }[] = [];
  const verifyGithubOidc: VerifyGithubOidc = async (jwt, expectation) => {
    oidcCalls.push({ jwt, ...expectation });
    return jwt.endsWith(".c2ln") && expectation.repository === "org/control" ? { ok: true } : { ok: false, message: "bad signature" };
  };
  const builds: BoxAgentBuilds = {
    current: async () => ({ version: "test" }),
    resolve: async () => null
  };

  before(async () => {
    appdir = await mkdtemp(join(tmpdir(), "orq-hub-"));
    records = new MemoryRecords();
    hub = createBoxHub({
      appdir,
      records,
      verifyGithubOidc,
      daemonUrls: () => ["https://orq.example:8443/t4", "http://100.64.0.1:47831"],
      builds,
      now: () => NOW,
      relay: false
    });
    const server = await startHubServer(hub);
    url = server.url;
    close = async () => {
      await hub.close();
      await server.app.close();
    };
  });

  after(async () => {
    await close();
    await rm(appdir, { recursive: true, force: true });
  });

  test("bootstrap → welcome with a credential; the token is single-use; the credential works", async () => {
    records.add("box-boot-0001");
    const token = await hub.issueBootstrapToken("box-boot-0001", 60_000);
    assert.match(token, /^box-boot-0001\.[A-Za-z0-9_-]{43}$/);
    assert.equal(records.get("box-boot-0001")?.bootstrapTokenHash, hashSecret(token));

    const box = await FakeBox.connect(url);
    box.hello({ kind: "bootstrap", token });
    const welcome = expectT(await box.next(), "welcome");
    assert.equal(welcome.boxId, "box-boot-0001");
    assert.equal(welcome.config.heartbeatMs > 0, true);
    assert.deepEqual(welcome.config.paths, { kind: "identity" });
    const credential = welcome.credential!;
    assert.match(credential, /^box-boot-0001\./);
    const stored = records.get("box-boot-0001")!;
    assert.equal(stored.credentialHash, hashSecret(credential));
    assert.equal(stored.bootstrapTokenHash, undefined);
    assert.equal(stored.bootstrapExpiresAt, undefined);
    const connection = await hub.waitConnected("box-boot-0001", { timeoutMs: 5_000 });
    assert.equal(connection.connected, true);

    // Replay of the spent token is refused.
    const replay = await FakeBox.connect(url);
    replay.hello({ kind: "bootstrap", token });
    assert.equal(expectT(await replay.next(), "reject").code, "AUTH_FAILED");
    await replay.closed;

    // The credential reconnects (and replaces the first link).
    const again = await FakeBox.connect(url);
    again.hello({ kind: "credential", boxId: "box-boot-0001", credential });
    const second = expectT(await again.next(), "welcome");
    assert.equal(second.credential, undefined);
    assert.equal(await box.closed, 4000);
    assert.equal(hub.get("box-boot-0001"), connection, "the connection object survives reconnects");
    again.close();
    await again.closed;
  });

  test("an expired bootstrap token is refused", async () => {
    records.add("box-expired-01");
    const token = await hub.issueBootstrapToken("box-expired-01", 60_000);
    await records.update("box-expired-01", (r) => {
      r.bootstrapExpiresAt = new Date(NOW - 1).toISOString();
    });
    const box = await FakeBox.connect(url);
    box.hello({ kind: "bootstrap", token });
    const reject = expectT(await box.next(), "reject");
    assert.equal(reject.code, "AUTH_FAILED");
    assert.match(reject.message, /expired/);
  });

  test("a wrong credential, a forged token and a destroyed box are refused", async () => {
    records.add("box-cred-0001", { credentialHash: hashSecret("box-cred-0001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") });
    const wrong = await FakeBox.connect(url);
    wrong.hello({ kind: "credential", boxId: "box-cred-0001", credential: "box-cred-0001.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" });
    assert.equal(expectT(await wrong.next(), "reject").code, "AUTH_FAILED");

    const otherBox = await FakeBox.connect(url);
    // A credential minted for another box id never authenticates this one.
    otherBox.hello({ kind: "credential", boxId: "box-cred-0001", credential: "box-other-01.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal(expectT(await otherBox.next(), "reject").code, "AUTH_FAILED");

    const forged = await FakeBox.connect(url);
    forged.hello({ kind: "bootstrap", token: "nonsense" });
    assert.equal(expectT(await forged.next(), "reject").code, "AUTH_FAILED");

    records.add("box-gone-0001", { state: "destroyed", credentialHash: hashSecret("box-gone-0001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") });
    const gone = await FakeBox.connect(url);
    gone.hello({ kind: "credential", boxId: "box-gone-0001", credential: "box-gone-0001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    assert.equal(expectT(await gone.next(), "reject").code, "BOX_DESTROYED");
  });

  test("protocol mismatch and a non-hello first frame", async () => {
    const old = await FakeBox.connect(url);
    old.hello({ kind: "bootstrap", token: "x" }, { protocol: 2 });
    assert.equal(expectT(await old.next(), "reject").code, "PROTOCOL_MISMATCH");

    const rude = await FakeBox.connect(url);
    rude.send({ t: "ping", id: 1 });
    assert.equal(await rude.closed, 1002);
  });

  test("GitHub OIDC: verified against the box's dispatch and the daemon origin", async () => {
    records.add("box-mac-00001", { provider: "blacksmith", providerRef: { repository: "org/control", runId: 1234 } });
    const jwt = fakeJwt({ aud: "https://orq.example:8443", repository: "org/control" });
    const box = await FakeBox.connect(url);
    box.hello({ kind: "github-oidc", boxId: "box-mac-00001", jwt });
    const welcome = expectT(await box.next(), "welcome");
    assert.equal(welcome.boxId, "box-mac-00001");
    assert.deepEqual(oidcCalls.at(-1), { jwt, repository: "org/control", runId: "1234", audience: "https://orq.example:8443" });
    box.close();
    await box.closed;

    // A token for another audience never reaches the verifier.
    const calls = oidcCalls.length;
    const wrongAud = await FakeBox.connect(url);
    wrongAud.hello({ kind: "github-oidc", boxId: "box-mac-00001", jwt: fakeJwt({ aud: "https://evil.example" }) });
    assert.equal(expectT(await wrongAud.next(), "reject").code, "AUTH_FAILED");
    assert.equal(oidcCalls.length, calls);

    // The verifier's verdict is final.
    records.add("box-mac-00002", { provider: "blacksmith", providerRef: { repository: "org/other", runId: "9" } });
    const refused = await FakeBox.connect(url);
    refused.hello({ kind: "github-oidc", boxId: "box-mac-00002", jwt });
    assert.equal(expectT(await refused.next(), "reject").code, "AUTH_FAILED");
  });

  test("agent-binary route: box auth only", async () => {
    records.add("box-dl-000001", { credentialHash: hashSecret("box-dl-000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") });
    const token = await hub.issueBootstrapToken("box-dl-000001", 60_000);
    const get = (headers: Record<string, string>) => fetch(`${url}/api/boxes/agent/linux-x64`, { headers });
    assert.equal((await get({})).status, 401);
    assert.equal((await get({ authorization: "Bearer box-dl-000001.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" })).status, 401);
    // Authenticated, but no build: 404 (not 401).
    assert.equal((await get({ authorization: `Bearer ${token}` })).status, 404);
    assert.equal((await get({ authorization: "Bearer box-dl-000001.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).status, 404);
    // Downloading does not spend the bootstrap token.
    assert.equal(records.get("box-dl-000001")?.bootstrapTokenHash, hashSecret(token));
    records.add("box-mac-dl-001", { provider: "blacksmith", providerRef: { repository: "org/control", runId: "77" } });
    const jwt = fakeJwt({ aud: "http://100.64.0.1:47831" });
    assert.equal((await get({ authorization: `GitHubOIDC ${jwt}`, "x-orq-box-id": "box-mac-dl-001" })).status, 404);
    assert.equal((await get({ authorization: `GitHubOIDC ${jwt}`, "x-orq-box-id": "box-dl-000001" })).status, 401);
  });

  test("bootstrap-script route: box auth only, one generic script per variant", async () => {
    records.add("box-stage-0001");
    const token = await hub.issueBootstrapToken("box-stage-0001", 60_000);
    const get = (variant: string, headers: Record<string, string>) => fetch(`${url}/api/boxes/bootstrap/${variant}`, { headers });
    assert.equal((await get("container", {})).status, 401);
    assert.equal((await get("container", { authorization: "Bearer box-stage-0001.CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" })).status, 401);
    // Authenticated: an unknown variant is 404, not 401.
    assert.equal((await get("windows", { authorization: `Bearer ${token}` })).status, 404);
    for (const variant of ["posix", "container"]) {
      const response = await get(variant, { authorization: `Bearer ${token}` });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/x-shellscript");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const script = await response.text();
      assert.equal(script, bootstrapSecondStage(variant));
      assert.ok(!script.includes(token) && !script.includes("box-stage-0001"), "the second stage is generic");
    }
    // Fetching the script does not spend the token: the binary download that follows still works.
    assert.equal(records.get("box-stage-0001")?.bootstrapTokenHash, hashSecret(token));
    assert.equal((await fetch(`${url}/api/boxes/agent/linux-x64`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  });

  test("revoke closes the link and refuses the box from then on", async () => {
    records.add("box-revoke-01");
    const token = await hub.issueBootstrapToken("box-revoke-01", 60_000);
    const box = await FakeBox.connect(url);
    box.hello({ kind: "bootstrap", token });
    const credential = expectT(await box.next(), "welcome").credential!;
    await hub.waitConnected("box-revoke-01", { timeoutMs: 5_000 });
    await hub.revoke("box-revoke-01");
    assert.equal(await box.closed, 4001);
    assert.equal(records.get("box-revoke-01")?.credentialHash, undefined);
    const again = await FakeBox.connect(url);
    again.hello({ kind: "credential", boxId: "box-revoke-01", credential });
    assert.equal(expectT(await again.next(), "reject").code, "BOX_DESTROYED");
  });

  test("box → host requests reach handlers; unknown methods answer UNKNOWN_METHOD", async () => {
    records.add("box-req-00001");
    hub.handle("git.credential", async (context, params) => ({ output: `box=${context.boxId} op=${params.operation}\n` }));
    const token = await hub.issueBootstrapToken("box-req-00001", 60_000);
    const box = await FakeBox.connect(url);
    box.hello({ kind: "bootstrap", token });
    expectT(await box.next(), "welcome");
    box.send({ t: "req", id: 1, method: "git.credential", params: { operation: "get", input: "" } });
    const res = expectT(await box.next(), "res");
    assert.deepEqual(res, { t: "res", id: 1, ok: true, result: { output: "box=box-req-00001 op=get\n" } });
    box.send({ t: "req", id: 2, method: "nope.nothing", params: {} });
    const unknown = expectT(await box.next(), "res");
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.error.code, "UNKNOWN_METHOD");
    box.send({ t: "open", ch: 1, spec: { kind: "ssh-agent" } });
    const refused = expectT(await box.next(), "open-failed");
    assert.equal(refused.error.code, "UNKNOWN_CHANNEL");
    box.close();
    await box.closed;
  });

  test("the user-auth exemption names exactly the box routes", () => {
    assert.deepEqual([...BOX_HUB_PUBLIC_ROUTES].sort(), ["/api/boxes/agent/:platform", "/api/boxes/bootstrap/:variant", "/api/boxes/connect"]);
    assert.equal(boxRoutes.bootstrapScript("container"), "/api/boxes/bootstrap/container");
  });
});
