import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { UsageResponse } from "@orquester/api";
import { FsSandboxError } from "@orquester/config/fs";
import { TabNotFound, AmbiguousTab, ToolError } from "./terminal-control.ts";
import { SessionError } from "../sessions.ts";
import { TodoError } from "../todos.ts";
import {
  registerMcp,
  toSafeToolError,
  SERVER_INSTRUCTIONS,
  PROMPT_HINT,
  ATTENTION_HINT,
  READ_FILE_DESC,
  GET_USAGE_DESC,
  projectUsage,
} from "./server.ts";

test("typed tool errors surface their (safe) message", () => {
  for (const e of [new TabNotFound("no tab x"), new AmbiguousTab("ambiguous: a=1,b=2"), new ToolError("tab limit"), new SessionError("entry not available")]) {
    const r = toSafeToolError(e);
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, e.message);
  }
});

test("todo errors surface their safe message", () => {
  const r = toSafeToolError(new TodoError(404, "todo not found"));
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, "todo not found");
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

// #2: multi-question AskUserQuestion — the driver answered one of three and submitted.
// Lock in the guidance that answers all questions and never submits early.
test("instructions cover multi-question widgets (answer all, multi-select Next, no early submit)", () => {
  assert.match(SERVER_INSTRUCTIONS, /Question N of M/i, "must explain the N-of-M progress");
  assert.match(SERVER_INSTRUCTIONS, /multi-select/i, "must distinguish multi-select");
  assert.match(SERVER_INSTRUCTIONS, /"Next"/, "must name the Next/Submit finish row");
  assert.match(SERVER_INSTRUCTIONS, /Answer ALL|Never submit/i, "must forbid submitting with questions unanswered");
});

// The multi-select failure: the driver typed "5" (a numbered "Type something") thinking
// it was the unnumbered "Submit" row, lost track of toggles, then Escaped (declining all).
// Lock in the robust mechanics that prevent it.
test("instructions teach the robust multi-select advance (Tab, unnumbered finish, batch Escape)", () => {
  assert.match(SERVER_INSTRUCTIONS, /\bTab\b/, "must offer Tab as the finish shortcut");
  assert.match(SERVER_INSTRUCTIONS, /UNNUMBERED/, "must warn the finish row is unnumbered (not a number)");
  assert.match(SERVER_INSTRUCTIONS, /Type something/, "must call out the Type-something-vs-finish trap");
  assert.match(SERVER_INSTRUCTIONS, /every question|EVERY question|whole batch/i, "must warn Escape declines the whole batch");
  assert.match(PROMPT_HINT, /\bTab\b/, "per-tool hint must also point multi-select at Tab");
});

test("attention guidance: bell semantics + wait_for_idle fallback survive trims", () => {
  assert.match(ATTENTION_HINT, /bell/i, "must explain attention is bell-driven");
  assert.match(ATTENTION_HINT, /read_terminal/, "must tell the caller to read after attention");
  assert.match(ATTENTION_HINT, /wait_for_idle/, "must name the non-bell fallback");
  assert.match(SERVER_INSTRUCTIONS, /wait_for_attention/, "global instructions must advertise wait_for_attention");
});

test("read_file description documents paging defaults and binary refusal", () => {
  assert.match(READ_FILE_DESC, /offset/i, "must document byte-offset paging");
  assert.match(READ_FILE_DESC, /64\s?KB|65536/i, "must document the default read window");
  assert.match(READ_FILE_DESC, /binary/i, "must document binary refusal");
});

test("projectUsage derives per-agent freshness and preserves unknown windows honestly", () => {
  const asOf = "2026-07-07T11:37:20.000Z";
  const res = {
    updatedAt: "2026-07-07T11:59:00.000Z",
    agents: [
      {
        id: "claude",
        available: true,
        stale: false,
        plan: "Max 20x",
        session: null,
        weekly: { percent: 42, resetsAt: "2026-07-08T00:00:00.000Z" },
        asOf,
      },
      {
        id: "codex",
        available: true,
        stale: true,
        session: null,
        weekly: null,
      },
      {
        id: "bad-clock",
        available: true,
        stale: true,
        session: null,
        weekly: null,
        asOf: "not a date",
      },
    ],
  } as UsageResponse & { updatedAt: string };

  const projected = projectUsage(res, Date.parse("2026-07-07T12:00:00.000Z"));

  assert.ok(!("updatedAt" in projected), "legacy top-level updatedAt must be dropped");
  assert.equal(projected.agents[0].asOf, asOf);
  assert.equal(projected.agents[0].ageMinutes, 23);
  assert.equal(projected.agents[0].session, null);
  assert.deepEqual(projected.agents[0].weekly, { percent: 42, resetsAt: "2026-07-08T00:00:00.000Z" });
  assert.equal(projected.agents[1].session, null);
  assert.equal(projected.agents[1].weekly, null);
  assert.equal(projected.agents[1].ageMinutes, undefined);
  assert.equal(projected.agents[2].ageMinutes, undefined);
});

test("get_usage description pins honest quota semantics", () => {
  assert.match(GET_USAGE_DESC, /absent agent[^.]*not logged in/i);
  assert.match(GET_USAGE_DESC, /null windows?[^.]*no reading/i);
  assert.match(GET_USAGE_DESC, /NEVER[^.]*loop[^.]*refresh/i);
  assert.match(GET_USAGE_DESC, /asOf/);
  assert.match(GET_USAGE_DESC, /ageMinutes/);
});

test("SERVER_INSTRUCTIONS stays under the ~2KB truncation budget", () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `SERVER_INSTRUCTIONS is ${SERVER_INSTRUCTIONS.length} chars`);
});

test("wait_for_attention tool is registered and delegates to TerminalControl", async () => {
  const calls: { selection: unknown; timeoutMs: unknown; signal: unknown }[] = [];
  const app = Fastify();
  registerMcp(app, {
    control: {
      waitForAttention: async (selection: unknown, options: { timeoutMs?: number; signal?: AbortSignal }) => {
        calls.push({ selection, timeoutMs: options.timeoutMs, signal: options.signal });
        return { tabs: [{ id: "tab-1" }] };
      },
    },
    todos: {},
  } as any);

  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tool = list.result.tools.find((t: { name: string }) => t.name === "wait_for_attention");
    assert.ok(tool, "wait_for_attention should be listed");
    assert.match(tool.description, /attention is WHY the tab wants you/, "description should include attention semantics");
    assert.match(tool.description, /settled/, "description should include the terminal prompt hint");

    const result = await postMcp(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wait_for_attention",
        arguments: { workspace: "w", project: "p", tabId: "tab-1", timeoutMs: 123 },
      },
    });

    assert.deepEqual(JSON.parse(result.result.content[0].text), { tabs: [{ id: "tab-1" }] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].selection, { workspace: "w", project: "p", tab: undefined, tabId: "tab-1" });
    assert.equal(calls[0].timeoutMs, 123);
    assert.ok(calls[0].signal instanceof AbortSignal);
  } finally {
    await app.close();
  }
});

test("file tools are registered and delegate to FsTools", async () => {
  const calls: { listPath?: string; readPath?: string; readOpts?: unknown } = {};
  const app = Fastify();
  registerMcp(app, {
    control: {},
    todos: {},
    files: {
      listFiles: async (path: string) => {
        calls.listPath = path;
        return { path: "/sandbox/src", entries: [{ name: "a.ts", kind: "file", size: 12 }], truncated: false };
      },
      readFileWindow: async (path: string, opts: { offset?: number; maxBytes?: number }) => {
        calls.readPath = path;
        calls.readOpts = opts;
        return { path: "/sandbox/src/a.ts", text: "hello", size: 99, offset: opts.offset ?? 0, truncated: true };
      },
    },
  } as any);

  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const listFiles = list.result.tools.find((t: { name: string }) => t.name === "list_files");
    const readFile = list.result.tools.find((t: { name: string }) => t.name === "read_file");
    assert.ok(listFiles, "list_files should be listed");
    assert.match(listFiles.description, /sandbox/i);
    assert.match(listFiles.description, /500/);
    assert.ok(readFile, "read_file should be listed");
    assert.equal(readFile.description, READ_FILE_DESC);

    const listed = await postMcp(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_files", arguments: { path: "src" } },
    });
    assert.deepEqual(JSON.parse(listed.result.content[0].text), {
      path: "/sandbox/src",
      entries: [{ name: "a.ts", kind: "file", size: 12 }],
      truncated: false,
    });

    const read = await postMcp(app, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "src/a.ts", offset: 65536, maxBytes: 1024 } },
    });
    assert.deepEqual(JSON.parse(read.result.content[0].text), {
      path: "/sandbox/src/a.ts",
      text: "hello",
      size: 99,
      offset: 65536,
      truncated: true,
    });
    assert.equal(calls.listPath, "src");
    assert.equal(calls.readPath, "src/a.ts");
    assert.deepEqual(calls.readOpts, { offset: 65536, maxBytes: 1024 });
  } finally {
    await app.close();
  }
});

test("get_usage is registered and projects UsageResponse", async () => {
  const calls: boolean[] = [];
  const app = Fastify();
  registerMcp(app, {
    control: {},
    todos: {},
    files: {},
    getUsage: async (force: boolean) => {
      calls.push(force);
      return {
        agents: [
          {
            id: "claude",
            available: true,
            stale: false,
            session: { percent: 51 },
            weekly: null,
            asOf: new Date(Date.now() - 61_000).toISOString(),
          },
        ],
      };
    },
  } as any);

  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const usageTool = list.result.tools.find((t: { name: string }) => t.name === "get_usage");
    assert.ok(usageTool, "get_usage should be listed");
    assert.equal(usageTool.description, GET_USAGE_DESC);

    const result = await postMcp(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_usage", arguments: { refresh: true } },
    });

    assert.deepEqual(calls, [true]);
    const projected = JSON.parse(result.result.content[0].text);
    assert.equal(projected.agents[0].id, "claude");
    assert.equal(projected.agents[0].session.percent, 51);
    assert.equal(projected.agents[0].weekly, null);
    assert.equal(projected.agents[0].ageMinutes, 1);
  } finally {
    await app.close();
  }
});

async function postMcp(app: ReturnType<typeof Fastify>, payload: unknown) {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body);
}
