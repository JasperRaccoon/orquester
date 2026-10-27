import assert from "node:assert/strict";
import test from "node:test";

import { agentDeviceConfig, parseDaemonInfo } from "./agent-device-daemon.ts";

test("agent-device: daemon.json → loopback endpoint; the --config file holds the base URL and token", () => {
  const endpoint = parseDaemonInfo(JSON.stringify({ pid: 1, httpPort: 43210, token: "t0k", version: "0.21.31" }));
  assert.deepEqual(endpoint, { baseUrl: "http://127.0.0.1:43210", token: "t0k" });
  assert.deepEqual(JSON.parse(agentDeviceConfig(endpoint!)), { daemonBaseUrl: "http://127.0.0.1:43210", daemonAuthToken: "t0k" });
  assert.equal(parseDaemonInfo(JSON.stringify({ port: 1, token: "x" })), null);
  assert.equal(parseDaemonInfo(JSON.stringify({ httpPort: 1, token: "" })), null);
  assert.equal(parseDaemonInfo("{"), null);
});
