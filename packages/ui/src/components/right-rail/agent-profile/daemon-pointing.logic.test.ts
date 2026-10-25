import assert from "node:assert/strict";
import test from "node:test";
import type { DaemonPointingServer } from "@orquester/api";
import { daemonPointingReasonFor } from "./daemon-pointing.logic";

const servers: DaemonPointingServer[] = [
  { agent: "claude", home: "system", scope: "user", name: "orquester_remote", reason: "bearer" },
  { agent: "claude", home: "acc1", scope: "user", name: "other", reason: "url" },
  { agent: "claude", home: "system", scope: "project", projectPath: "/w/a/b", name: "proj", reason: "url" },
  { agent: "codex", home: "system", scope: "user", name: "orquester", reason: "name" }
];

test("daemonPointingReasonFor: only the agent's own user-scope MCP server of that name", () => {
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "orquester_remote" }, "claude", servers), "bearer");
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "orquester_remote" }, "codex", servers), null);
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "other" }, "claude", servers), null, "an account home's config is another file");
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "proj" }, "claude", servers), null, "a project's config is another file");
  assert.equal(daemonPointingReasonFor({ kind: "skill", name: "orquester_remote" }, "claude", servers), null);
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "orquester" }, "codex", null), null);
  assert.equal(daemonPointingReasonFor({ kind: "mcp", name: "orquester" }, "codex", servers), "name");
});
