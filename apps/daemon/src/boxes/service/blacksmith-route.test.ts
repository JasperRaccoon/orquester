import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BoxError } from "./errors.ts";
import { MACOS_ROUTE_MESSAGE, type BlacksmithSetupDriver, type BlacksmithTailnetJoin } from "./settings.ts";
import { testBoxService, type TestService } from "./testing.ts";

// macOS (Blacksmith) boxes are GitHub Actions runners outside the tailnet: they dial the public URL
// whenever one is known, the tailnet URL only with a federated identity; the control repo step
// re-runs when the connection changes.

interface DriverCall {
  daemonUrl: string;
  tailscale: BlacksmithTailnetJoin | null;
}

function fakeDriver(): { driver: BlacksmithSetupDriver; calls: DriverCall[] } {
  const calls: DriverCall[] = [];
  const driver: BlacksmithSetupDriver = {
    checkAccount: async () => ({ ok: true }),
    checkOrg: async () => ({ ok: true }),
    checkApp: async () => ({ ok: true }),
    ensureControlRepo: async (_token, org, options) => {
      calls.push({ daemonUrl: options.daemonUrl, tailscale: options.tailscale ?? null });
      return { repo: `${org}/orquester-macos-boxes`, workflowFile: "orquester-box.yml" };
    },
    adapterCredentials: () => ({})
  };
  return { driver, calls };
}

async function harness(t: test.TestContext, publicOrigin: string | null, fetch?: typeof globalThis.fetch): Promise<TestService & { calls: DriverCall[] }> {
  const root = await mkdtemp(join(tmpdir(), "orq-box-blacksmith-route-"));
  const { driver, calls } = fakeDriver();
  const service = testBoxService({ baseDir: root, overrides: { publicOrigin: () => publicOrigin, blacksmith: driver, ...(fetch ? { fetch } : {}) } });
  await service.service.start();
  t.after(async () => {
    await service.service.stop();
    await rm(root, { recursive: true, force: true });
  });
  return { ...service, calls };
}

const repoStep = (h: TestService) => h.service.settings.blacksmithSteps().find((step) => step.id === "repo")!;

test("macOS boxes dial the public URL even in Tailscale mode", async (t) => {
  const h = await harness(t, "https://orq.example.test");
  const settings = h.service.settings;
  await settings.setConnection({ mode: "tailscale", tailscaleDaemonUrl: "https://pc.tail1234.ts.net:10000", tailscaleApiToken: "tskey-api-secretvalue" });
  assert.equal(settings.route().daemonUrl, "https://pc.tail1234.ts.net:10000");
  assert.deepEqual(settings.route("blacksmith"), { mode: "public-url", daemonUrl: "https://orq.example.test", tailscale: null });

  await settings.setBlacksmith({ gitAccountId: "acct", org: "Org" });
  assert.equal(repoStep(h).state, "ok");
  assert.deepEqual(h.calls, [{ daemonUrl: "https://orq.example.test", tailscale: null }]);
});

test("without a public URL or a federated identity, the control repo step says how to fix it", async (t) => {
  const h = await harness(t, null);
  const settings = h.service.settings;
  await settings.setConnection({ mode: "tailscale", tailscaleDaemonUrl: "https://pc.tail1234.ts.net:10000", tailscaleApiToken: "tskey-api-secretvalue" });
  assert.throws(() => settings.route("blacksmith"), (error: BoxError) => error.code === "BOX_CONNECTION_NOT_CONFIGURED" && error.message === MACOS_ROUTE_MESSAGE);
  // Linux boxes still go over the tailnet.
  assert.equal(settings.route().mode, "tailscale");

  await settings.setBlacksmith({ gitAccountId: "acct", org: "Org" });
  assert.deepEqual(repoStep(h), { id: "repo", label: "Control repository", state: "action-needed", message: MACOS_ROUTE_MESSAGE, actionUrl: null });
  assert.equal(h.calls.length, 0);

  // Adding the federated identity re-runs the steps by itself: the runner joins the tailnet.
  const answer = await settings.setConnection({ tailscaleWorkloadClientId: "kJ2x7CNTRL", tailscaleWorkloadAudience: "api.tailscale.com/kJ2x7CNTRL" });
  assert.deepEqual(answer.tailscale.workloadIdentity, { clientId: "kJ2x7CNTRL", audience: "api.tailscale.com/kJ2x7CNTRL" });
  await settings.blacksmithChecksSettled();
  assert.equal(repoStep(h).state, "ok");
  assert.deepEqual(h.calls, [
    { daemonUrl: "https://pc.tail1234.ts.net:10000", tailscale: { oauthClientId: "kJ2x7CNTRL", audience: "api.tailscale.com/kJ2x7CNTRL" } }
  ]);
  assert.deepEqual(settings.route("blacksmith"), { mode: "tailscale", daemonUrl: "https://pc.tail1234.ts.net:10000", tailscale: null });

  // Setting a public URL re-runs them again; the public URL wins and the workflow has no Tailscale step.
  await settings.setConnection({ publicUrl: "https://orq.example.org" });
  await settings.blacksmithChecksSettled();
  assert.deepEqual(h.calls.at(-1), { daemonUrl: "https://orq.example.org", tailscale: null });
});

test("a stored route error is re-checked after a passing Check, not a failing one", async (t) => {
  let status = 502;
  const fetchCalls: string[] = [];
  const h = await harness(t, null, (async (url: string | URL) => {
    fetchCalls.push(String(url));
    return new Response("", { status });
  }) as typeof fetch);
  const settings = h.service.settings;
  await settings.setBlacksmith({ gitAccountId: "acct", org: "Org" });
  assert.equal(repoStep(h).state, "action-needed");

  await settings.setConnection({ publicUrl: "https://orq.example.org" });
  await settings.blacksmithChecksSettled();
  const runs = h.calls.length;
  assert.equal(runs, 1, "saving the URL re-ran the steps");

  await settings.testConnection();
  await settings.blacksmithChecksSettled();
  assert.equal(h.calls.length, runs, "a failed Check re-runs nothing");
  status = 401;
  await settings.testConnection();
  await settings.blacksmithChecksSettled();
  assert.equal(h.calls.length, runs + 1, "a passing Check re-runs the steps");
  assert.equal(fetchCalls.length, 2);
});

test("nothing is re-run before an account is picked; the identity is validated", async (t) => {
  const h = await harness(t, null);
  const settings = h.service.settings;
  await settings.setConnection({ publicUrl: "https://orq.example.org" });
  await settings.blacksmithChecksSettled();
  assert.equal(h.calls.length, 0);
  assert.equal(repoStep(h).state, "todo");
  await assert.rejects(settings.setConnection({ tailscaleWorkloadClientId: "only-id" }), /together/);
  await assert.rejects(settings.setConnection({ tailscaleWorkloadClientId: "bad id", tailscaleWorkloadAudience: "x" }), /letters, digits/);
  await settings.setConnection({ tailscaleWorkloadClientId: "id", tailscaleWorkloadAudience: "aud" });
  assert.deepEqual(settings.connectionSettings().tailscale.workloadIdentity, { clientId: "id", audience: "aud" });
  await settings.setConnection({ tailscaleWorkloadClientId: null, tailscaleWorkloadAudience: "" });
  assert.equal(settings.connectionSettings().tailscale.workloadIdentity, null);
});
