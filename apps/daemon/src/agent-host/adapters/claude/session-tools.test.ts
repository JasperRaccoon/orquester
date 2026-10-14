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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { TEST_TOOLKIT_INSTRUCTIONS } from "../../../session-tools/testing.ts";
import { recordingSessionTools } from "../../session-tools/testing.ts";
import { buildClaudeQueryOptions } from "./launch.ts";
import { toProviderModels } from "./models.ts";
import {
  CLAUDE_SESSION_TOOLS_ALLOW_RULE,
  createClaudeSessionToolsLaunch,
  isClaudeSessionTool
} from "./session-tools.ts";

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
    const launch = createClaudeSessionToolsLaunch({
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

  it("ending the session aborts a call still in flight", async () => {
    const tools = recordingSessionTools();
    const life = new AbortController();
    const launch = createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "thread-1", signal: life.signal });
    const client = await connectInProcess(launch.server.instance);
    const pending = client.callTool({ name: "wait_for_cancel", arguments: {} });
    while (tools.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    life.abort();
    const result = (await pending) as CallToolResult;
    assert.equal(result.isError, true);
    assert.equal(tools.calls[0]!.signal?.aborted, true);
    await client.close();
  });

  it("names only the orquester server's tools as session tools", () => {
    assert.equal(isClaudeSessionTool("mcp__orquester__echo"), true);
    assert.equal(isClaudeSessionTool("mcp__orquester2__echo"), false);
    assert.equal(isClaudeSessionTool("mcp__github__orquester__x"), false);
    assert.equal(isClaudeSessionTool("Bash"), false);
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

  it("attach the in-process server, its pre-approval and its instruction block", () => {
    const tools = recordingSessionTools();
    const launch = createClaudeSessionToolsLaunch({ sessionTools: tools, threadId: "t", signal: new AbortController().signal });
    const { options } = buildClaudeQueryOptions({ ...base, sessionTools: launch });
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["orquester"]);
    assert.equal(options.mcpServers?.orquester, launch.server);
    assert.deepEqual(options.allowedTools, [CLAUDE_SESSION_TOOLS_ALLOW_RULE]);
    assert.equal(CLAUDE_SESSION_TOOLS_ALLOW_RULE, "mcp__orquester");
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
  });

  it("without session tools, nothing changes", () => {
    const { options } = buildClaudeQueryOptions(base);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.allowedTools, undefined);
    const systemPrompt = options.systemPrompt as { append: string };
    assert.ok(!systemPrompt.append.includes("## Orquester"));
  });
});
