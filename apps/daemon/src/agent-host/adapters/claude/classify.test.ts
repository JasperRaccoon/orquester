import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyRequestType, classifyToolItemType } from "./classify.ts";

describe("classifyToolItemType", () => {
  it("an MCP tool is an MCP call whatever words its name holds", () => {
    // The substring ladder read "create" first: a real GitHub MCP tool ran as a "File change".
    assert.equal(classifyToolItemType("mcp__github__create_issue"), "mcp_tool_call");
    assert.equal(classifyToolItemType("mcp__linear__update_issue_file"), "mcp_tool_call");
    assert.equal(classifyToolItemType("mcp__orchestrator__run_agent"), "mcp_tool_call");
    assert.equal(classifyToolItemType("mcp__shell__run_command"), "mcp_tool_call");
    assert.equal(classifyToolItemType("mcp__x__list"), "mcp_tool_call");
    // And its approval card is filed as an MCP tool's.
    assert.equal(classifyRequestType("mcp__github__create_issue"), "permission_approval");
  });

  it("the built-in tools keep their buckets", () => {
    assert.equal(classifyToolItemType("Bash"), "command_execution");
    assert.equal(classifyToolItemType("Write"), "file_change");
    assert.equal(classifyToolItemType("Edit"), "file_change");
    assert.equal(classifyToolItemType("Agent"), "collab_agent_tool_call");
    assert.equal(classifyToolItemType("TaskCreate"), "dynamic_tool_call");
    assert.equal(classifyToolItemType("WebSearch"), "web_search");
  });
});
