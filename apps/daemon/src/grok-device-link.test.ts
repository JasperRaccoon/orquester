import { test } from "node:test";
import assert from "node:assert/strict";
import type { GrokDevicePoll, GrokDeviceStart } from "./grok-device-auth.ts";
import { GrokDeviceLinkService } from "./grok-device-link.ts";

const DEVICE_PROMPT = {
  url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
  userCode: "ABCD-EFGH",
  deviceCode: "dev-1",
  intervalSec: 0,
  expiresIn: 1800
};

function setup(opts: {
  start: () => Promise<GrokDeviceStart>;
  poll: (deviceCode: string) => Promise<GrokDevicePoll>;
  importAccount?: (content: string) => Promise<unknown>;
}) {
  const imported: string[] = [];
  const statuses: string[] = [];
  const service = new GrokDeviceLinkService({
    deviceAuth: { start: opts.start, poll: opts.poll },
    importAccount:
      opts.importAccount ??
      (async (content) => {
        imported.push(content);
      }),
    sleep: () => new Promise((resolve) => setImmediate(resolve))
  });
  service.events.on("changed", (s: { state: string }) => statuses.push(s.state));
  return { service, imported, statuses };
}

function settled(service: GrokDeviceLinkService): Promise<void> {
  return new Promise((resolve) => {
    if (service.status().state !== "linking") return resolve();
    service.events.on("changed", (s: { state: string }) => {
      if (s.state !== "linking") resolve();
    });
  });
}

test("a granted link imports the tokens as a managed grok account", async () => {
  const h = setup({
    start: async () => ({ ok: true, value: { ...DEVICE_PROMPT } }),
    poll: async () => ({
      status: "ok",
      tokens: { access_token: "at-dev", refresh_token: "rt-dev", expires_in: 21600 }
    })
  });

  const started = await h.service.start();
  assert.equal(started.ok, true);
  assert.equal(started.ok && started.link.url, DEVICE_PROMPT.url);
  assert.equal(started.ok && started.link.userCode, "ABCD-EFGH");
  assert.equal(h.service.status().state, "linking");

  await settled(h.service);
  assert.equal(h.imported.length, 1);
  const native = JSON.parse(h.imported[0]) as Record<string, Record<string, unknown>>;
  const entry = native["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"];
  assert.equal(entry?.key, "at-dev");
  assert.equal(entry?.refresh_token, "rt-dev");
  assert.equal(typeof entry?.expires_at, "string");
  assert.deepEqual(h.service.status(), { state: "idle", link: null, lastError: null });
  assert.deepEqual(h.statuses, ["linking", "idle"]);
});

test("a start failure is an upstream result carrying the status, and leaves nothing pending", async () => {
  const h = setup({
    start: async () => ({ ok: false, error: "xAI device authorization failed: HTTP 500", status: 500 }),
    poll: async () => ({ status: "wait" })
  });

  const res = await h.service.start();
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "upstream");
  assert.equal(res.ok === false ? res.status : undefined, 500);
  assert.equal(h.service.status().state, "idle");
});

test("a second start while one is pending is a conflict; cancel drops it locally", async () => {
  const h = setup({
    start: async () => ({ ok: true, value: { ...DEVICE_PROMPT, deviceCode: "dev-9" } }),
    poll: async () => ({ status: "wait" })
  });

  assert.equal((await h.service.start()).ok, true);
  const duplicate = await h.service.start();
  assert.equal(duplicate.ok === false && duplicate.code, "conflict");

  assert.equal(h.service.cancel().state, "idle");
  assert.equal(h.service.cancel().state, "idle", "cancelling nothing is a no-op");
  assert.equal(h.imported.length, 0);
});

test("a failed verdict lands on lastError and a fresh attempt clears it", async () => {
  const h = setup({
    start: async () => ({ ok: true, value: { ...DEVICE_PROMPT, deviceCode: "dev-2" } }),
    poll: async () => ({ status: "error", error: "authorization denied" })
  });

  assert.equal((await h.service.start()).ok, true);
  await settled(h.service);
  assert.equal(h.service.status().lastError, "authorization denied");

  assert.equal((await h.service.start()).ok, true);
  assert.equal(h.service.status().lastError, null, "a fresh attempt supersedes the verdict");
});

test("a failed import is reported as the link's error", async () => {
  const h = setup({
    start: async () => ({ ok: true, value: { ...DEVICE_PROMPT, deviceCode: "dev-3" } }),
    poll: async () => ({ status: "ok", tokens: { access_token: "at", refresh_token: "rt" } }),
    importAccount: async () => {
      throw new Error("disk full");
    }
  });

  assert.equal((await h.service.start()).ok, true);
  await settled(h.service);
  assert.equal(h.service.status().lastError, "disk full");
});
