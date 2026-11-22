import assert from "node:assert/strict";
import test from "node:test";

import type { StoredBox } from "@orquester/config";

import { tailnetAddressUsers } from "./address-users.ts";

test("tailnetAddressUsers: boxes and paired machines dialing the address, by origin", () => {
  const settings = (mode: "tailscale" | "public-url", url: string) => ({
    mode,
    publicUrl: mode === "public-url" ? url : null,
    tailscale: { configured: true, keyHint: null, tailnet: null, daemonUrl: mode === "tailscale" ? url : null, policySnippet: "" }
  });
  const machines = [{ provider: "byo", state: "ready" }, { provider: "byo", state: "destroyed" }, { provider: "hetzner", state: "ready" }] as unknown as StoredBox[];
  const address = ["https://pc.tail1.ts.net:10000"];
  assert.deepEqual(tailnetAddressUsers(settings("tailscale", "https://PC.tail1.ts.net:10000/"), machines, address), ["Tailscale-mode boxes", "1 paired machine"]);
  assert.deepEqual(tailnetAddressUsers(settings("tailscale", "https://pc.tail1.ts.net:10001"), machines, address), []);
  assert.deepEqual(tailnetAddressUsers(settings("public-url", "https://orq.example.com"), machines, address), []);
});
