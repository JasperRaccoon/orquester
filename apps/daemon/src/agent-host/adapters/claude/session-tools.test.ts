/**
 * Claude's `orquester` session-tool server (design 2026-10-14 §1.2–§1.4):
 * the in-process SDK server advertises the registered tools and calls them
 * as the thread it was bound to; the launch options carry it, its
 * pre-approval and its instruction block, and nothing secret.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import type { DaemonApi } from "../../../mcp/daemon-api.ts";
import { defineSessionTool, defineSessionToolkit, SESSION_TOOL_READ_ONLY, type SessionToolContext } from "../../../session-tools/contract.ts";
import { executeSessionToolCall } from "../../../session-tools/executor.ts";
import { createSessionToolRegistry } from "../../../session-tools/registry.ts";
import { jsonResult } from "../../../session-tools/results.ts";
import { TEST_TOOLKIT_INSTRUCTIONS } from "../../../session-tools/testing.ts";
import { recordingSessionTools } from "../../session-tools/testing.ts";
import { buildClaudeQueryOptions } from "./launch.ts";
import { toProviderModels } from "./models.ts";
import {
  claudeDeniedMcpServers,
  claudeDisallowedTools,
  createClaudeSessionToolsLaunch,
  isClaudeSessionTool
} from "./session-tools.ts";

function fakeContext(): SessionToolContext {
  return {
    threadId: "thread-1",
    projectPath: "/p",
    cwd: "/p",
    agentId: "claude",
    callId: "c",
    signal: new AbortController().signal,
    api: {} as DaemonApi,
    now: Date.now
  };
}

async function connectInProcess(instance: unknown): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await (instance as { connect(transport: unknown): Promise<void> }).connect(serverSide);
  const client = new Client({ name: "claude-cli-stand-in", version: "0" });
  await client.connect(clientSide);
  return client;
}

describe("Claude in-process session-tool server", () => {
  it("advertises every registered tool and calls them as its own thread", async () => {
    const tools = recordingSessionTools();
    const launch = await createClaudeSessionToolsLaunch({
      sessionTools: tools,
      threadId: "thread-1",
      signal: new AbortController().signal
    });
    assert.equal(launch.server.type, "sdk");
    assert.equal(launch.server.name, "orquester");
    assert.equal(launch.instructions, tools.instructions);

    const client = await connectInProcess(launch.server.instance);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["echo", "wait_for_cancel", "pixel", "fail"]
    );
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "hi" },
      _meta: { "claudecode/toolUseId": "toolu_42" }
    });
    assert.deepEqual(result.content, [{ type: "text", text: "ran echo for thread-1" }]);
    assert.equal(tools.calls[0]!.threadId, "thread-1");
    assert.equal(tools.calls[0]!.callId, "toolu_42");
    assert.deepEqual(tools.calls[0]!.arguments, { text: "hi" });
    await client.close();
  });

  it("forwards the arguments raw: an unknown key survives and no default is applied", async () => {
    const registry = createSessionToolRegistry([
      defineSessionToolkit({
        id: "defaults",
        tools: [
          defineSessionTool({
            name: "paged",
            title: "Paged",
            description: "Has a default.",
            input: { limit: z.number().int().default(20), text: z.string().optional() },
            annotations: SESSION_TOOL_READ_ONLY,
            resultKind: "json",
            run: async () => jsonResult({})
          })
        ]
      })
    ]);
    const tools = recordingSessionTools(registry);
    const launch = await createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "thread-1", signal: new AbortController().signal });
    const client = await connectInProcess(launch.server.instance);
    // The schema is still advertised in full.
    const listed = await client.listTools();
    assert.deepEqual(Object.keys(listed.tools[0]!.inputSchema.properties ?? {}), ["limit", "text"]);
    await client.callTool({ name: "paged", arguments: { text: "x", bogus: true } });
    assert.deepEqual(tools.calls[0]!.arguments, { text: "x", bogus: true }, "the daemon sees what the model sent");
    // …so its refusal is the same one every provider gets.
    const refused = await executeSessionToolCall(registry, { name: "paged", arguments: tools.calls[0]!.arguments }, fakeContext());
    assert.equal(refused.isError, true);
    assert.match((refused.content[0] as { text: string }).text, /^INVALID_ARGUMENT: Invalid arguments for paged: arguments: Unrecognized key\(s\) in object: 'bogus'/);
    await client.close();
  });

  it("ending the session aborts a call still in flight", async () => {
    const tools = recordingSessionTools();
    const life = new AbortController();
    const launch = await createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "thread-1", signal: life.signal });
    const client = await connectInProcess(launch.server.instance);
    const called = tools.nextCall();
    const pending = client.callTool({ name: "wait_for_cancel", arguments: {} });
    await called;
    life.abort();
    const result = (await pending) as CallToolResult;
    assert.equal(result.isError, true);
    assert.equal(tools.calls[0]!.signal?.aborted, true);
    await client.close();
  });

  it("takes a new list in-session: list_changed, the new tools listed and pre-approved", async () => {
    const tools = recordingSessionTools();
    const launch = await createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "thread-1", signal: new AbortController().signal });
    const client = await connectInProcess(launch.server.instance);
    let changed!: () => void;
    const notified = new Promise<void>((resolve) => (changed = resolve));
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => changed());
    assert.equal(launch.names().has("pixel"), true);
    assert.equal(await tools.applyManifest("thread-1", { tools: ["echo"], instructions: "", deny: [] }), "live");
    await notified;
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["echo"]);
    assert.deepEqual([...launch.names()], ["echo"]);
    await client.close();
  });

  it("names only the REGISTERED tools of the orquester server as session tools", () => {
    const names = new Set(["echo"]);
    assert.equal(isClaudeSessionTool("mcp__orquester__echo", names), true);
    // A tool of the same-named external `/mcp` (docs/orquester-mcp.md) is not one.
    assert.equal(isClaudeSessionTool("mcp__orquester__send_message", names), false);
    assert.equal(isClaudeSessionTool("mcp__orquester2__echo", names), false);
    assert.equal(isClaudeSessionTool("mcp__github__orquester__echo", names), false);
    assert.equal(isClaudeSessionTool("Bash", names), false);
  });
});

describe("Claude launch options with session tools", () => {
  const canUseTool: CanUseTool = async () => ({ behavior: "allow", updatedInput: {} });
  const base = {
    cwd: "/work",
    executablePath: "/usr/local/bin/claude",
    env: { PATH: "/usr/bin" },
    runtimeMode: "approval-required" as const,
    models: toProviderModels([{ value: "default", displayName: "Default" }]),
    attachmentsDir: "/work/.attachments",
    canUseTool
  };

  it("attach the in-process server, its pre-approval and its instruction block", async () => {
    const tools = recordingSessionTools();
    const launch = await createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "t", signal: new AbortController().signal });
    const { options } = buildClaudeQueryOptions({ ...base, sessionTools: launch });
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["orquester"]);
    assert.equal(options.mcpServers?.orquester, launch.server);
    // Each registered tool by name — never the server-wide `mcp__orquester`.
    assert.deepEqual(options.allowedTools, [
      "mcp__orquester__echo",
      "mcp__orquester__wait_for_cancel",
      "mcp__orquester__pixel",
      "mcp__orquester__fail"
    ]);
    const systemPrompt = options.systemPrompt as { type: string; append: string };
    assert.equal(systemPrompt.type, "preset");
    assert.ok(systemPrompt.append.startsWith("You are running inside Orquester's agent chat"));
    assert.ok(systemPrompt.append.endsWith(TEST_TOOLKIT_INSTRUCTIONS));
    // `strictMcpConfig` stays unset: the user's own servers keep loading.
    assert.equal(options.strictMcpConfig, undefined);
    // Nothing that reaches argv carries a credential: the SDK serialises an
    // `sdk` server as its type and name only, and there is no token at all.
    const { instance: _instance, ...serialisable } = launch.server;
    assert.deepEqual(serialisable, { type: "sdk", name: "orquester" });
    // A user-config server named `orquester` never connects (it would race ours, Task 6 probe);
    // nothing else is denied without a manifest denial.
    assert.deepEqual((options.settings as { deniedMcpServers?: unknown }).deniedMcpServers, [{ serverName: "orquester" }]);
    assert.equal(options.disallowedTools, undefined);
  });

  it("deny every daemon-pointing server twice: the server-level rule and deniedMcpServers (§12.1)", async () => {
    const tools = recordingSessionTools(undefined, { deny: ["orquester_remote", "my.remote", "orquester"] });
    const launch = await createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "t", signal: new AbortController().signal });
    const { options } = buildClaudeQueryOptions({ ...base, sessionTools: launch });
    // `mcp__orquester` would remove our own server's tools: never.
    assert.deepEqual(options.disallowedTools, ["mcp__orquester_remote", "mcp__my_remote"]);
    assert.deepEqual((options.settings as { deniedMcpServers?: unknown }).deniedMcpServers, [
      { serverName: "orquester" },
      { serverName: "orquester_remote" },
      { serverName: "my.remote" }
    ]);
    assert.deepEqual(claudeDisallowedTools([]), []);
    assert.deepEqual(claudeDeniedMcpServers([]), [{ serverName: "orquester" }]);
  });

  it("without session tools, nothing changes", () => {
    const { options } = buildClaudeQueryOptions(base);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.allowedTools, undefined);
    const systemPrompt = options.systemPrompt as { append: string };
    assert.ok(!systemPrompt.append.includes("## Orquester"));
  });
});
