import assert from "node:assert/strict";
import test from "node:test";
import * as chatClient from "./index.ts";

test("sendCommand preserves a workflow command ID across recovery", async () => {
  const bodies: Record<string, unknown>[] = [];
  const api: chatClient.DaemonApi = {
    fsRoot: "/fs",
    workspacesDir: "/fs/ws",
    request: async (_method, _path, opts) => {
      bodies.push(opts?.body as Record<string, unknown>);
      return { status: 200, body: { seq: bodies.length } };
    },
    uploadAttachment: async () => ({ status: 503, value: null }),
    subscribe: () => () => undefined
  };
  await chatClient.sendCommand(api, "s1", "turn", { commandId: "ignored", input: "hi" }, { commandId: "persisted-1" });
  assert.equal(bodies[0]!.commandId, "persisted-1");
});
