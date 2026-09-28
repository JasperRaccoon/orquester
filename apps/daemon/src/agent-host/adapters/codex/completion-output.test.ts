/**
 * Codex adapter — a command's completion keeps its whole output, bounded
 * (plan `2026-09-24-follow-ups-adapters-output-composer-history`, Task 3).
 *
 * Codex delivers a command's output whole in `item/completed.aggregatedOutput`
 * (`item/commandExecution/outputDelta` never fired in the captures, fixtures
 * README observation 18), and the completion kept none of it in `data`: its
 * `detail` — cut to 180 characters by ingestion — was all that survived.
 * `data.item.aggregatedOutput` now keeps it, where every reader of a command's
 * output already looks (`commandOutputText`, the wire slimmer's
 * `projectCommandData`), up to 64 KiB of UTF-8. Past that the stored text is
 * its head, cut on a character boundary, and the row says so
 * (`payload.truncated`), so `read_tool_output` reads the call's streamed join
 * instead of answering a cut text as the whole output.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodexProtocol } from "./_generated/index.ts";
import { projectCodexHistory } from "./history.ts";
import { classifyItem } from "./items.ts";

const CAP = 64 * 1024;
const TURN = "turn-1";
const CALL = "call_1";

function command(
  status: CodexProtocol.v2.CommandExecutionStatus,
  aggregatedOutput: string | null
): Extract<CodexProtocol.v2.ThreadItem, { type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id: CALL,
    pluginId: null,
    scriptPath: null,
    command: "pnpm test",
    cwd: "/w/p",
    processId: null,
    source: "unifiedExecStartup",
    status,
    commandActions: [],
    aggregatedOutput,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 5 : null
  };
}

interface StoredCommandPayload {
  truncated?: boolean;
  data?: { item?: { aggregatedOutput?: string } };
}

describe("a Codex command's completion keeps its output (Task 3)", () => {

  it("the bound is exact: 64 KiB is whole, a byte more is cut, and a character never straddles it", () => {
    const at = (output: string) => {
      const classified = classifyItem(command("completed", output));
      return {
        stored: (classified.data as StoredCommandPayload["data"])?.item?.aggregatedOutput,
        truncated: (classified as { truncated?: boolean }).truncated
      };
    };
    assert.deepEqual(at("a".repeat(CAP)), { stored: "a".repeat(CAP), truncated: undefined });
    assert.deepEqual(at(`${"a".repeat(CAP)}b`), { stored: "a".repeat(CAP), truncated: true });
    // A 4-byte character with 2 bytes of room left is not stored at all.
    assert.deepEqual(at(`${"a".repeat(CAP - 2)}😀`), { stored: "a".repeat(CAP - 2), truncated: true });
    // No output, nothing stored: a declined command has none.
    const declined = classifyItem(command("declined", null));
    assert.equal((declined.data as StoredCommandPayload["data"])?.item, undefined);
    assert.equal((declined as { truncated?: boolean }).truncated, undefined);
  });

  it("a replayed command keeps its output too, bounded and marked the same way", () => {
    const whole = "done\n";
    const long = "y".repeat(CAP + 10);
    const drafts = projectCodexHistory({
      threadId: "t",
      turns: [{ id: TURN, items: [{ ...command("completed", whole), id: "c1" }, { ...command("completed", long), id: "c2" }] }]
    });
    const rows = drafts.filter((draft) => draft.type === "item.completed");
    const payloads = rows.map((row) => row.payload as StoredCommandPayload);
    assert.deepEqual(
      payloads.map((payload) => [payload.data?.item?.aggregatedOutput?.length, payload.truncated]),
      [
        [whole.length, undefined],
        [CAP, true]
      ]
    );
  });
});
