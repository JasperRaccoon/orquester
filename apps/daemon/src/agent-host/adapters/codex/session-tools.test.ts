/**
 * Codex's `orquester` session-tool server (design 2026-10-14 §1.2–§1.4),
 * against the scripted mock app-server: the thread config carries the
 * server and names an env var, the credential is in the child's env only —
 * never argv, never a frame — the instruction block is additive application
 * context, and the credential is revoked when the child is gone.
 */

import assert from "node:assert/strict";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { recordingSessionTools } from "../../session-tools/testing.ts";
import { createCodexAdapter } from "./index.ts";
import { classifyItem } from "./items.ts";
import {
  CODEX_DENIED_STUB_URL,
  CODEX_SESSION_TOOLS_CONTEXT_KEY,
  CODEX_SESSION_TOOLS_TOKEN_ENV,
  codexDenyConfig,
  codexSessionToolsConfig,
  codexSessionToolsContext,
  codexSessionToolsServerName
} from "./session-tools.ts";
import { createFakeContext, EventCollector, writeMockCodexServer } from "./testing.ts";

const cleanups: Array<() => void | Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe("codex session tools — the builders", () => {
  it("the thread config switches off every server the manifest denies, never our own name (§12.1)", () => {
    const config = codexSessionToolsConfig({
      url: "http://127.0.0.1:4711/mcp",
      instructions: "x",
      deny: ["orquester_remote", "orquester", "my remote", "my-remote"]
    });
    assert.equal(config["mcp_servers.orquester_remote.enabled"], false);
    assert.equal(config["mcp_servers.my-remote.enabled"], false);
    // Any character but `.` is fine in a dotted key (probed on 0.159.0).
    assert.equal(config["mcp_servers.my remote.enabled"], false);
    // `orquester` is ours: the thread entry already replaces a user's same-named one.
    assert.equal(config["mcp_servers.orquester.enabled"], undefined);
    assert.ok(config["mcp_servers.orquester"]);
  });

  it("a denied name with a `.` is never dropped: the whole override becomes ONE mcp_servers table", () => {
    const ours = { url: "http://127.0.0.1:4711/mcp", bearer_token_env_var: "ORQUESTER_SESSION_TOOLS_TOKEN", default_tools_approval_mode: "approve", tool_timeout_sec: 3900 };
    // Codex splits override keys on every `.` (`mcp_servers."a.b"` fails the thread), and a separate
    // `mcp_servers` key would replace `mcp_servers.orquester`: one table, merged into the config.
    assert.deepEqual(codexSessionToolsConfig({ url: "http://127.0.0.1:4711/mcp", instructions: "x", deny: ["remote.prod", "plain", "orquester"] }), {
      mcp_servers: { orquester: ours, "remote.prod": { enabled: false }, plain: { enabled: false } }
    });
    assert.deepEqual(codexDenyConfig(["remote.prod", "plain"]), { mcp_servers: { "remote.prod": { enabled: false }, plain: { enabled: false } } });
    assert.deepEqual(codexDenyConfig(["plain"]), { "mcp_servers.plain.enabled": false });
    assert.deepEqual(codexDenyConfig([]), {});
  });

  it("the thread config attaches the server by URL and env-var NAME, pre-approved", () => {
    const config = codexSessionToolsConfig({ url: "http://127.0.0.1:4711/mcp", instructions: "x" });
    assert.deepEqual(config, {
      "mcp_servers.orquester": {
        url: "http://127.0.0.1:4711/mcp",
        bearer_token_env_var: "ORQUESTER_SESSION_TOOLS_TOKEN",
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 3900
      }
    });
  });

  it("the instruction block is application context, and absent when empty", () => {
    assert.deepEqual(codexSessionToolsContext({ url: "u", instructions: "## Orquester" }), {
      [CODEX_SESSION_TOOLS_CONTEXT_KEY]: { kind: "application", value: "## Orquester" }
    });
    assert.equal(codexSessionToolsContext({ url: "u", instructions: "" }), undefined);
    assert.equal(codexSessionToolsContext(undefined), undefined);
  });
});

describe("codex session tools — a launch", () => {
  for (const [failGrant, defined] of [[false, true], [true, true], [false, false], [true, false]] as const) {
    it(`the thread's MCP denials reach thread/start's config${failGrant ? " — also when no grant could be issued" : ""}${defined ? "" : " — as a harmless stub where its config does not define the server"}`, async () => {
      const server = writeMockCodexServer({ turns: [], mcpServers: defined ? { orquester_remote: { url: "http://127.0.0.1:47831/mcp" } } : {} });
      cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
      const recording = recordingSessionTools(undefined, { deny: ["orquester_remote"] });
      const tools = failGrant
        ? { ...recording, issue: async () => Promise.reject(new Error("the endpoint could not bind")) }
        : recording;
      const { context } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin), sessionTools: tools });
      const adapter = await createCodexAdapter(context);
      cleanups.push(() => adapter.stopAll());
      await adapter.refreshSnapshot({ cwd: process.cwd() });
      await adapter.startSession({ threadId: "thread-d", cwd: process.cwd(), home: { kind: "system", path: "" }, modelSelection: { model: "gpt-5.5" }, runtimeMode: "approval-required" });
      const config = (server.received().find((frame) => frame.method === "thread/start")?.params as { config?: Record<string, unknown> }).config;
      if (defined) assert.equal(config?.["mcp_servers.orquester_remote.enabled"], false);
      else assert.deepEqual(config?.["mcp_servers.orquester_remote"], { url: CODEX_DENIED_STUB_URL, enabled: false });
      assert.equal(config?.["mcp_servers.orquester"] !== undefined, !failGrant, "our own server only with a grant");
    });
  }

  it("credential in env only; config on thread/start; context on turn/start; revoked at exit", async () => {
    const server = writeMockCodexServer({ turns: [{ kind: "text", text: "done" }] });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    // A wrapper that records the argv and the env var the CLI is handed, then
    // execs the mock exactly as `codex` would be.
    const wrapper = join(server.dir, "codex-wrapper.sh");
    const argvLog = join(server.dir, "argv.txt");
    const envLog = join(server.dir, "env.txt");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$0" "$@" > '${argvLog}'\nprintf '%s' "$${CODEX_SESSION_TOOLS_TOKEN_ENV}" > '${envLog}'\nexec '${server.bin}' "$@"\n`,
      "utf8"
    );
    chmodSync(wrapper, 0o755);

    const tools = recordingSessionTools();
    const extraEnvs: Array<Record<string, string | undefined> | undefined> = [];
    const { context, rawFrames } = createFakeContext({
      resolveBin: () => Promise.resolve(wrapper),
      sessionTools: tools,
      buildEnv: (input) => {
        extraEnvs.push(input.extraEnv);
        return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", ...input.extraEnv } as Record<string, string>;
      }
    });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    const events = new EventCollector(adapter.events);
    await adapter.refreshSnapshot({ cwd: process.cwd() });

    await adapter.startSession({
      threadId: "thread-1",
      cwd: process.cwd(),
      home: { kind: "system", path: "" },
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    });
    assert.equal(tools.grants.length, 1);
    const grant = tools.grants[0]!;
    const sessionEnv = extraEnvs.find((env) => env?.[CODEX_SESSION_TOOLS_TOKEN_ENV] !== undefined);
    assert.equal(sessionEnv?.[CODEX_SESSION_TOOLS_TOKEN_ENV], grant.token);
    assert.equal(readFileSync(envLog, "utf8"), grant.token, "the child got the credential in its env");
    const argv = readFileSync(argvLog, "utf8");
    assert.ok(argv.endsWith("\napp-server\n"), "argv is exactly `app-server`");
    assert.ok(!argv.includes(grant.token), "no credential in argv");

    const start = server.received().find((frame) => frame.method === "thread/start");
    assert.deepEqual((start?.params as { config?: unknown }).config, {
      "mcp_servers.orquester": {
        url: grant.url,
        bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV,
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 3900
      }
    });

    await adapter.sendTurn({ threadId: "thread-1", input: "hello", attachments: [], interactionMode: "default" });
    await events.waitForType("turn.completed");
    const turn = server.received().find((frame) => frame.method === "turn/start")?.params as {
      input: Array<{ type: string; text?: string }>;
      additionalContext?: Record<string, { kind: string; value: string }>;
    };
    assert.deepEqual(turn.additionalContext, {
      orquester: { kind: "application", value: tools.instructions }
    });
    // The user's input is the user's alone.
    assert.deepEqual(
      turn.input.map((item) => item.text),
      ["hello"]
    );

    // No frame either way carried the credential.
    assert.ok(!JSON.stringify(server.received()).includes(grant.token));
    assert.ok(!JSON.stringify(rawFrames).includes(grant.token));

    assert.equal(grant.revoked, false);
    await adapter.stopSession("thread-1");
    assert.equal(grant.revoked, true, "the credential dies with its child");
  });

  it("a resume carries the server too", async () => {
    const server = writeMockCodexServer({ turns: [] });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const tools = recordingSessionTools();
    const { context } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin), sessionTools: tools });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    await adapter.startSession({
      threadId: "thread-2",
      cwd: process.cwd(),
      home: { kind: "system", path: "" },
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required",
      resumeCursor: { threadId: "prior-thread" }
    });
    const resume = server.received().find((frame) => frame.method === "thread/resume");
    assert.deepEqual(Object.keys((resume?.params as { config?: object }).config ?? {}), ["mcp_servers.orquester"]);
    await adapter.stopAll();
  });

  it("without a registered toolkit nothing changes", async () => {
    const server = writeMockCodexServer({ turns: [] });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    const { context } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin) });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    await adapter.startSession({
      threadId: "thread-3",
      cwd: process.cwd(),
      home: { kind: "system", path: "" },
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    });
    const start = server.received().find((frame) => frame.method === "thread/start");
    assert.equal((start?.params as { config?: unknown }).config, undefined);
    await adapter.stopAll();
  });
});

describe("codex session tools — a fork (thread lineage, spec 2026-10-14 §6)", () => {
  it("the fork's own process gets no credential, and the child thread gets its OWN grant — never the parent's", async () => {
    const server = writeMockCodexServer({ turns: [], forkThreadId: "forked-1" });
    cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
    // Every process the adapter spawns appends the credential it was handed.
    const wrapper = join(server.dir, "codex-wrapper.sh");
    const envLog = join(server.dir, "env.txt");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '[%s]\\n' "$${CODEX_SESSION_TOOLS_TOKEN_ENV}" >> '${envLog}'\nexec '${server.bin}' "$@"\n`,
      "utf8"
    );
    chmodSync(wrapper, 0o755);
    const tools = recordingSessionTools();
    const builds: Array<{ threadId: string; token: string | undefined }> = [];
    const { context } = createFakeContext({
      resolveBin: () => Promise.resolve(wrapper),
      sessionTools: tools,
      buildEnv: (input) => {
        builds.push({ threadId: input.threadId, token: input.extraEnv?.[CODEX_SESSION_TOOLS_TOKEN_ENV] });
        return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp", ...input.extraEnv } as Record<string, string>;
      }
    });
    const adapter = await createCodexAdapter(context);
    cleanups.push(() => adapter.stopAll());
    await adapter.refreshSnapshot({ cwd: process.cwd() });
    // The probe ran the CLI too; only the sessions and the fork are of interest.
    writeFileSync(envLog, "", "utf8");
    const home = { kind: "system" as const, path: "" };

    // The parent runs, with its grant.
    await adapter.startSession({
      threadId: "parent",
      cwd: process.cwd(),
      home,
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    });
    assert.equal(tools.grants.length, 1);
    const parentGrant = tools.grants[0]!;
    assert.equal(parentGrant.threadId, "parent");
    const parentCodexThread = (adapter.listSessions()[0]!.resumeCursor as { threadId: string }).threadId;

    // The fork: a short-lived process under the parent's home — no grant issued, no credential handed.
    const buildsBefore = builds.length;
    const forked = await adapter.forkConversation!({
      sourceThreadId: "parent",
      sourceResumeCursor: { threadId: parentCodexThread },
      threadId: "child",
      projectPath: process.cwd(),
      cwd: process.cwd(),
      home,
      cut: { firstRemovedTurnId: null, retainedTurnIds: ["turn-1"] }
    });
    assert.deepEqual(forked.resumeCursor, { threadId: "forked-1" });
    assert.equal(tools.grants.length, 1, "a fork issues nothing");
    assert.deepEqual(builds.slice(buildsBefore), [{ threadId: "parent", token: undefined }]);

    // The child: its own session, its own fresh grant, bound to the child.
    await adapter.startSession({
      threadId: "child",
      cwd: process.cwd(),
      home,
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required",
      resumeCursor: forked.resumeCursor
    });
    assert.equal(tools.grants.length, 2);
    const childGrant = tools.grants[1]!;
    assert.equal(childGrant.threadId, "child");
    assert.notEqual(childGrant.token, parentGrant.token);
    assert.equal(builds.at(-1)?.token, childGrant.token);
    assert.equal(parentGrant.revoked, false, "the parent keeps its own");
    // What each process was really handed: the parent's, nothing for the fork, the child's.
    assert.deepEqual(readFileSync(envLog, "utf8").trim().split("\n"), [
      `[${parentGrant.token}]`,
      "[]",
      `[${childGrant.token}]`
    ]);
    const resume = server.received().find(
      (frame) => frame.method === "thread/resume" && (frame.params as { threadId?: string }).threadId === "forked-1"
    );
    assert.ok(resume !== undefined, "the child resumes the fork");
    assert.deepEqual(Object.keys((resume.params as { config?: object }).config ?? {}), ["mcp_servers.orquester"]);
    await adapter.stopSession("child");
    assert.equal(childGrant.revoked, true);
    assert.equal(parentGrant.revoked, false, "ending the child never ends the parent's");
    await adapter.stopAll();
  });
});

describe("codex session tools — a config that has its own `orquester`", () => {
  it("names ours orquester_session (then _2, …) only where `orquester` is taken", () => {
    assert.equal(codexSessionToolsServerName([]), "orquester");
    assert.equal(codexSessionToolsServerName(["keep"]), "orquester");
    assert.equal(codexSessionToolsServerName(["orquester"]), "orquester_session");
    assert.equal(codexSessionToolsServerName(["orquester", "orquester_session", "orquester_session_2"]), "orquester_session_3");
  });

  for (const pointsAtUs of [false, true]) {
    it(`launches with ours under the alternate name; theirs is ${pointsAtUs ? "denied by name (it points at Orquester)" : "left alone"}`, async () => {
      // A user's stdio `orquester` (probed: merging ours into it fails thread/start on 0.159.0).
      const server = writeMockCodexServer({ turns: [{ kind: "text", text: "done" }], mcpServers: { orquester: { command: "sh", args: [] } } });
      cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
      const tools = recordingSessionTools(undefined, { deny: pointsAtUs ? ["orquester"] : [] });
      const { context } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin), sessionTools: tools });
      const adapter = await createCodexAdapter(context);
      cleanups.push(() => adapter.stopAll());
      const events = new EventCollector(adapter.events);
      await adapter.refreshSnapshot({ cwd: process.cwd() });
      await adapter.startSession({ threadId: "thread-o", cwd: process.cwd(), home: { kind: "system", path: "" }, modelSelection: { model: "gpt-5.5" }, runtimeMode: "approval-required" });
      const read = server.received().find((frame) => frame.method === "config/read");
      assert.deepEqual(read?.params, { cwd: process.cwd() }, "the thread's own effective config, project layers included");
      const config = (server.received().find((frame) => frame.method === "thread/start")?.params as { config?: Record<string, unknown> }).config ?? {};
      const grant = tools.grants[0]!;
      assert.deepEqual(config["mcp_servers.orquester_session"], {
        url: grant.url,
        bearer_token_env_var: CODEX_SESSION_TOOLS_TOKEN_ENV,
        default_tools_approval_mode: "approve",
        tool_timeout_sec: 3900
      }, "ours, pre-approved, under the alternate name");
      assert.equal(config["mcp_servers.orquester"], undefined, "never merged into theirs");
      assert.equal(config["mcp_servers.orquester.enabled"], pointsAtUs ? false : undefined);
      // The instruction block says the chat's name for our server.
      await adapter.sendTurn({ threadId: "thread-o", input: "hello", attachments: [], interactionMode: "default" });
      await events.waitForType("turn.completed");
      const turn = server.received().find((frame) => frame.method === "turn/start")?.params as { additionalContext?: Record<string, { value: string }> };
      assert.match(turn.additionalContext?.[CODEX_SESSION_TOOLS_CONTEXT_KEY]?.value ?? "", /named `orquester_session`/);
    });
  }

  it("a row says whose server it came from: ours under its alternate name, never the user's `orquester`", () => {
    const call = (server: string) => ({
      type: "mcpToolCall" as const, id: "c", server, tool: "echo", status: "completed" as const, arguments: {}, appContext: null,
      pluginId: null, readOnlyHint: true, result: { content: [], structuredContent: { ok: true }, _meta: null }, error: null, durationMs: 1
    });
    const ours = classifyItem(call("orquester_session") as never, "orquester_session").data as Record<string, unknown>;
    const theirs = classifyItem(call("orquester") as never, "orquester_session").data as Record<string, unknown>;
    assert.equal(ours.sessionToolsServer, true);
    assert.ok("result" in ours, "our result is kept");
    assert.equal(theirs.sessionToolsServer, false);
    assert.equal("result" in theirs, false, "theirs is any other server's");
    // History (no session to ask): the spelling decides, the alternate name included.
    assert.ok("result" in (classifyItem(call("orquester_session") as never).data as Record<string, unknown>));
  });
});
