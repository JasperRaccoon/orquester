import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { TabNotFound, AmbiguousTab, ToolError } from "./terminal-control.ts";
import { SessionError } from "../sessions.ts";
import { toSafeToolError, SERVER_INSTRUCTIONS, PROMPT_HINT } from "./server.ts";

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

// The #1 observed failure: the driver Escapes a real select-menu (which cancels it)
// and its next write lands in the composer as a stray message. Lock in the guidance
// that prevents it — in BOTH the global instructions and the per-tool hint the driver
// actually reads — so a future trim can't silently drop the warning.
test("prompt guidance warns Escape cancels a menu and teaches the number shortcut", () => {
  for (const g of [SERVER_INSTRUCTIONS, PROMPT_HINT]) {
    assert.match(g, /Esc/i, "must name Escape");
    assert.match(g, /cancel/i, "must say Escape cancels");
    assert.match(g, /number/i, "must teach the option-number shortcut");
    assert.match(g, /submit:true/, "must cover the plain input box");
  }
  assert.match(SERVER_INSTRUCTIONS, /Type something|write-your-own/i, "must cover the write-your-own option");
});
