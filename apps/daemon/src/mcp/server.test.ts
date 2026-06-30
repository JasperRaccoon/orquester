import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { TabNotFound, AmbiguousTab, ToolError } from "./terminal-control.ts";
import { SessionError } from "../sessions.ts";
import { toSafeToolError } from "./server.ts";

test("typed tool errors surface their (safe) message", () => {
  for (const e of [new TabNotFound("no tab x"), new AmbiguousTab("ambiguous: a=1,b=2"), new ToolError("tab limit"), new SessionError("entry not available")]) {
    const r = toSafeToolError(e);
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, e.message);
  }
});

test("FsSandboxError is generic (never echoes the path)", () => {
  const r = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!r.content[0].text.includes("/etc/shadow"));
});

test("unknown errors collapse to a fixed string (no leak)", () => {
  const r = toSafeToolError(new Error("ENOENT: /home/alice/.ssh/id_rsa"));
  assert.ok(!r.content[0].text.includes("/home/alice"));
  assert.equal(r.isError, true);
});
