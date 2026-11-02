import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deviceRoutes } from "@orquester/api";

import { ApiClient } from "../api-client.ts";
import type { HttpClient } from "../http-client.ts";
import { HttpTransporter } from "./http-transporter.ts";

/** An HttpClient that records the headers of each request and answers `{}`. */
function recording(): { client: HttpClient; seen: Record<string, string>[] } {
  const seen: Record<string, string>[] = [];
  const client = {
    send: async (req: { headers: Record<string, string> }) => {
      seen.push(req.headers);
      return { status: 200, ok: true, headers: {}, text: async () => "{}" };
    }
  } as unknown as HttpClient;
  return { client, seen };
}

describe("HttpTransporter.authHeaders", () => {
  it("is the bearer its requests send, and empty without a credential", async () => {
    const { client, seen } = recording();
    const transporter = new HttpTransporter({ baseUrl: "http://daemon.test", credential: "s3cret", httpClient: client });
    assert.deepEqual(transporter.authHeaders(), { Authorization: "Bearer s3cret" });
    await transporter.request({ method: "GET", path: "/api/x" });
    assert.equal(seen[0]?.Authorization, "Bearer s3cret");
    const anonymous = new HttpTransporter({ baseUrl: "http://daemon.test", httpClient: client });
    assert.deepEqual(anonymous.authHeaders(), {});
    await anonymous.request({ method: "GET", path: "/api/x" });
    assert.equal(seen[1]?.Authorization, undefined);
  });
});

describe("ApiClient device URLs", () => {
  // The headers come from the transporter (an HttpTransporter would also open its session socket here).
  const transporter = {
    kind: "http",
    request: async () => ({ status: 200, ok: true, data: {} }),
    openStream: () => ({ close() {} }),
    authHeaders: () => ({ Authorization: "Bearer transport-token" })
  };
  const api = new ApiClient({ id: "c1", endpoint: "http://daemon.test/", password: "s3cret" } as never, transporter as never);

  it("a fetched device path carries the transport's bearer header and no token in its URL", () => {
    const path = deviceRoutes.hub("local", "vendor/serve-emu/api/screenshot?device=emulator-5554");
    assert.deepEqual(api.deviceHttpRequest(path), {
      url: `http://daemon.test${path}`,
      headers: { Authorization: "Bearer transport-token" }
    });
  });

  it("only an <img> URL (a kept screenshot) carries ?token=", () => {
    const path = deviceRoutes.screenshot("l1", "s1");
    assert.equal(api.deviceImageUrl(path), `http://daemon.test${path}?token=s3cret`);
  });

  it("nothing off HTTP", () => {
    const unix = new ApiClient({ id: "c2" } as never, { kind: "unix", request: async () => ({ status: 200, ok: true, data: {} }), openStream: () => ({ close() {} }) } as never);
    assert.equal(unix.deviceHttpRequest(deviceRoutes.hub("local", "api/devices")), null);
    assert.equal(unix.deviceImageUrl(deviceRoutes.screenshot("l1", "s1")), null);
  });

  describe("the desktop's device relay", () => {
    const TOKEN = "t".repeat(43);
    const unix = () => new ApiClient({ id: "c2" } as never, { kind: "unix", request: async () => ({ status: 200, ok: true, data: {} }), openStream: () => ({ close() {} }) } as never);
    const withRelay = (relay: unknown, run: () => void) => {
      (globalThis as { window?: unknown }).window = { orquesterDesktop: { deviceRelay: relay } };
      try {
        run();
      } finally {
        delete (globalThis as { window?: unknown }).window;
      }
    };

    it("carries a unix connection's devices over loopback", () => {
      withRelay({ origin: "http://127.0.0.1:4100", token: TOKEN }, () => {
        const api = unix();
        const hub = deviceRoutes.hub("local", "vendor/serve-sim/x/stream.avcc");
        assert.deepEqual(api.deviceHttpRequest(hub), { url: `http://127.0.0.1:4100${hub}`, headers: { Authorization: `Bearer ${TOKEN}` } });
        const socket = deviceRoutes.socket("local", "vendor/serve-emu/ws");
        assert.equal(api.deviceSocketUrl(socket), `ws://127.0.0.1:4100${socket}?token=${TOKEN}`);
        const shot = deviceRoutes.screenshot("l1", "s1");
        assert.equal(api.deviceImageUrl(shot), `http://127.0.0.1:4100${shot}?token=${TOKEN}`);
      });
    });

    it("trusts only a well-formed loopback relay", () => {
      for (const relay of [{ origin: "http://evil.test:80", token: TOKEN }, { origin: "http://127.0.0.1:4100", token: "" }, "http://127.0.0.1:4100", null]) {
        withRelay(relay, () => assert.equal(unix().deviceSocketUrl(deviceRoutes.socket("local", "x")), null));
      }
    });

    it("leaves a remote connection on its own server", () => {
      withRelay({ origin: "http://127.0.0.1:4100", token: TOKEN }, () => {
        assert.match(api.deviceSocketUrl(deviceRoutes.socket("local", "x")) ?? "", /^ws:\/\/daemon\.test/);
      });
    });
  });
});
