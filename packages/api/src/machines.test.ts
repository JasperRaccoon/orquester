import assert from "node:assert/strict";
import test from "node:test";

import { agentSshAliasName, agentSshKeyComment, parseAgentSshKeyComment } from "./agent-ssh.ts";
import { boxMachineId, parseMachineId, tailnetMachineId } from "./machines.ts";

test("machine ids round-trip and anything else parses as no machine", () => {
  assert.deepEqual(parseMachineId(tailnetMachineId("nX1abcCNTRL")), { kind: "tailnet", stableId: "nX1abcCNTRL" });
  assert.deepEqual(parseMachineId(boxMachineId("0a1b2c3d4e5f")), { kind: "box", boxId: "0a1b2c3d4e5f" });
  for (const id of ["", "ts:", "box:", "local", "ts:a/b", "box:../x", "vphone:abc"]) assert.equal(parseMachineId(id), null, id);
  assert.throws(() => tailnetMachineId("a b"));
});

test("alias names are lowercase ASCII slugs, or null when nothing is left", () => {
  assert.equal(agentSshAliasName("Eduard's MacBook Pro"), "eduard-s-macbook-pro");
  assert.equal(agentSshAliasName("minipc-DESKTOP-11FQVRE"), "minipc-desktop-11fqvre");
  assert.equal(agentSshAliasName("Ünïcödé box"), "unicode-box");
  assert.equal(agentSshAliasName("---"), null);
  assert.equal(agentSshAliasName(`${"a".repeat(39)}-b`), "a".repeat(39));
});

test("key comments name their chat and box, and only Orquester's own comments parse", () => {
  const chat = { threadId: "t-1", boxId: "box1" };
  assert.deepEqual(parseAgentSshKeyComment(agentSshKeyComment(chat)), chat);
  assert.deepEqual(parseAgentSshKeyComment(agentSshKeyComment({ threadId: null, boxId: "box1" })), { threadId: null, boxId: "box1" });
  for (const comment of ["jasper@jasper", "orquester", "orquester chat=t-1", "orquester box=box1 extra", "orquester chat= box=x"]) {
    assert.equal(parseAgentSshKeyComment(comment), null, comment);
  }
  assert.throws(() => agentSshKeyComment({ threadId: "a b", boxId: "box1" }));
});
