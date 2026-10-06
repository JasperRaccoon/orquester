/**
 * Codex adapter — replay tests against the REAL recorded traffic (spec §9).
 *
 * Every fixture in `apps/daemon/test/fixtures/codex/` is fed through the
 * normaliser exactly as the transport would deliver it, and the emitted
 * `RuntimeEvent` sequence is asserted. These are the tests that catch a
 * protocol drift the type system cannot: a field that moved, a notification
 * that stopped firing, a shape that only the live CLI produces.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import { CodexNormaliser } from "./normalise.ts";
import { CodexUsageTracker } from "./usage.ts";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/codex"
);

interface FixtureLine {
  t: number;
  dir: "send" | "recv" | "stderr" | "note";
  frame: unknown;
}

function readFixture(name: string): FixtureLine[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
}

interface Frame {
  id?: number | string;
  method?: string;
  params?: unknown;
}

/** Notifications are the normaliser's input; replies belong to the peer. */
function inbound(lines: FixtureLine[]): {
  notifications: { method: string; params: unknown }[];
} {
  const notifications: { method: string; params: unknown }[] = [];
  for (const line of lines) {
    if (line.dir !== "recv" || typeof line.frame !== "object" || line.frame === null) {
      continue;
    }
    const frame = line.frame as Frame;
    if (frame.method !== undefined && (frame.id === undefined || frame.id === null)) {
      notifications.push({ method: frame.method, params: frame.params });
    }
  }
  return { notifications };
}

function replay(name: string): {
  events: { type: string; payload: unknown; turnId?: string; itemId?: string }[];
  notifications: { method: string; params: unknown }[];
} {
  const lines = readFixture(name);
  const { notifications } = inbound(lines);
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  const events: ReturnType<typeof replay>["events"] = [];
  for (const notification of notifications) {
    for (const draft of normaliser.notification(
      notification.method as never,
      notification.params
    )) {
      events.push({
        type: draft.type,
        payload: draft.payload,
        ...(draft.turnId !== undefined ? { turnId: draft.turnId } : {}),
        ...(draft.itemId !== undefined ? { itemId: draft.itemId } : {})
      });
    }
  }
  return { events, notifications };
}

describe("codex replay — no item is left dangling inProgress (R3 finding 1)", () => {
  /**
   * The reviewer's exact reproduction: replay each capture and pair
   * `item.started` / `item.completed` by `itemId`. Before the fix, `06-…`,
   * `14-…` and `05-…` each left one.
   *
   * `14-…` is SIGTERM with no `turn/completed`. The session exit regression
   * owns that teardown; a notification replay cannot prove process cleanup.
   */
  function danglingItems(name: string): string[] {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const open = new Map<string, string>();
    const apply = (drafts: ReturnType<CodexNormaliser["notification"]>): void => {
      for (const draft of drafts) {
        if (draft.type === "item.started") {
          open.set(String(draft.itemId), draft.payload.itemType);
        } else if (draft.type === "item.completed") {
          open.delete(String(draft.itemId));
        }
      }
    };
    for (const notification of inbound(readFixture(name)).notifications) {
      apply(normaliser.notification(notification.method as never, notification.params));
    }
    return [...open.keys()];
  }

  it("every capture that ends with a settled turn closes all its items", () => {
    const leftOpen: Record<string, string[]> = {};
    for (const name of fixtureNames()) {
      // SIGTERM has no closing provider frame; session.test.ts owns exit cleanup.
      if (name.startsWith("14-")) continue;
      const dangling = danglingItems(name);
      if (dangling.length > 0) {
        leftOpen[name] = dangling;
      }
    }
    assert.deepEqual(leftOpen, {});
  });

});

describe("codex replay — 01 initialize, thread start, one text turn", () => {
  const { events } = replay("01-initialize-thread-start-text-turn.ndjson");

  it("emits thread.started with the provider thread id from its notification", () => {
    const started = events.find((event) => event.type === "thread.started");
    assert.ok(started !== undefined);
    assert.equal(
      (started.payload as { providerThreadId: string }).providerThreadId,
      "01a0c19e-a2ec-7bc0-bb96-49a226d1fb15"
    );
  });

  it("streams the assistant answer as content.delta {assistant_text}", () => {
    const deltas = events.filter(
      (event) =>
        event.type === "content.delta" &&
        (event.payload as { streamKind: string }).streamKind === "assistant_text"
    );
    assert.ok(deltas.length > 0, "the corpus streams agentMessage deltas");
    const text = deltas.map((event) => (event.payload as { delta: string }).delta).join("");
    assert.equal(text, "391");
  });

  it("emits turn.started then turn.completed with a complete token usage", () => {
    const order = events
      .filter((event) => event.type === "turn.started" || event.type === "turn.completed")
      .map((event) => event.type);
    assert.deepEqual(order.slice(0, 2), ["turn.started", "turn.completed"]);
    const completed = events.find((event) => event.type === "turn.completed");
    const payload = completed!.payload as {
      state: string;
      tokenUsage?: { usageStatus: string; inputTokens?: number; outputTokens?: number };
    };
    assert.equal(payload.state, "completed");
    // `turn/completed` carries NO usage on the wire; the adapter stamps it.
    assert.equal(payload.tokenUsage?.usageStatus, "complete");
    assert.ok((payload.tokenUsage?.inputTokens ?? 0) > 0);
  });

  it("classifies the reasoning item even though it carries no text", () => {
    const reasoning = events.filter(
      (event) =>
        (event.type === "item.started" || event.type === "item.completed") &&
        (event.payload as { itemType: string }).itemType === "reasoning"
    );
    assert.ok(reasoning.length > 0, "a reasoning row must tolerate having no text ever");
  });
});

describe("codex replay — 03 decline / cancel / acceptForSession", () => {
  const { events } = replay("03-command-approval-decline-cancel-session.ndjson");

  it("a cancelled turn completes as interrupted and NEVER clears accumulated items", () => {
    const interrupted = events.filter(
      (event) =>
        event.type === "turn.completed" &&
        (event.payload as { state: string }).state === "interrupted"
    );
    assert.equal(interrupted.length, 1, "exactly one turn was cancelled");
    // The wire carries `items: []` with `itemsView:"notLoaded"` on that turn;
    // nothing in the payload may propagate it.
    assert.ok(!("items" in (interrupted[0]!.payload as object)));
  });

  it("an interrupted turn's usage is partial, not complete", () => {
    const interrupted = events.find(
      (event) =>
        event.type === "turn.completed" &&
        (event.payload as { state: string }).state === "interrupted"
    );
    assert.equal(
      (interrupted!.payload as { tokenUsage?: { usageStatus: string } }).tokenUsage?.usageStatus,
      "partial"
    );
  });

  it("classifies the declined command item as declined", () => {
    const declined = events.filter(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { itemType: string; status?: string }).itemType ===
          "command_execution" &&
        (event.payload as { status?: string }).status === "declined"
    );
    assert.ok(declined.length >= 2, "decline and cancel both land the item as declined");
  });
});

/**
 * Fixture 05's abandoned attempt (fixtures README obs. 22): a `commentary`
 * agentMessage that streams 27 deltas, stops mid-sentence and never gets an
 * `item/completed`. Codex's own rollout for the session does not contain it.
 */
const ABANDONED_MESSAGE_ID = "msg_0d0d102f2f46ad5c016ab0a4422a1087d287b60bfd06c10b98";

/**
 * Every item the abandoned-message close fired on in one capture: an
 * `item.completed` produced while handling an `item/started`, which is the
 * only way a frame about one item can close ANOTHER.
 */
function abandonedMessageCloses(name: string): string[] {
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  const closed: string[] = [];
  for (const notification of inbound(readFixture(name)).notifications) {
    const drafts = normaliser.notification(notification.method as never, notification.params);
    if (notification.method !== "item/started") {
      continue;
    }
    for (const draft of drafts) {
      if (draft.type === "item.completed") {
        closed.push(String(draft.itemId));
      }
    }
  }
  return closed;
}

describe("codex replay — 05 an abandoned agentMessage (fixtures README obs. 22)", () => {
  it("closes the abandoned message when the next item of its turn starts — nowhere else in the corpus", () => {
    // The close must never split a real message: across every capture it may
    // fire on exactly one item, the attempt 05 abandons.
    const fired: Record<string, string[]> = {};
    for (const name of fixtureNames()) {
      const closed = abandonedMessageCloses(name);
      if (closed.length > 0) {
        fired[name] = closed;
      }
    }
    assert.deepEqual(fired, { "05-tool-request-user-input.ndjson": [ABANDONED_MESSAGE_ID] });
  });
});

describe("codex replay — 08 compaction", () => {
  const { events } = replay("08-compaction.ndjson");

  it("synthesises thread.state.changed {state:'compacted'} from the item", () => {
    const compacted = events.find(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.payload as { state: string }).state === "compacted"
    );
    assert.ok(compacted !== undefined);
    assert.equal(typeof (compacted.payload as { afterTokens?: number }).afterTokens, "number");
  });

});

describe("codex replay — 09 plan mode", () => {
  const { events } = replay("09-plan-mode-and-per-turn-overrides.ndjson");

  it("streams the proposal as turn.proposed.delta and completes it", () => {
    const deltas = events.filter((event) => event.type === "turn.proposed.delta");
    assert.ok(deltas.length > 0, "item/plan/delta becomes turn.proposed.delta");
    const completed = events.find((event) => event.type === "turn.proposed.completed");
    assert.ok(completed !== undefined);
    assert.ok(
      (completed.payload as { planMarkdown: string }).planMarkdown.length > 0,
      "the plan item's text is the proposal"
    );
  });
});

describe("codex replay — 11 turn diff", () => {
  const { events, notifications } = replay("11-turn-diff-workspace-write.ndjson");

  it("de-duplicates the cumulative diff on content, not on arrival", () => {
    const raw = notifications.filter((n) => n.method === "turn/diff/updated").length;
    const emitted = events.filter((event) => event.type === "turn.diff.updated").length;
    assert.ok(raw > emitted, `${raw} notifications collapsed to ${emitted} distinct diffs`);
    assert.ok(emitted > 0);
    const diffs = new Set(
      events
        .filter((event) => event.type === "turn.diff.updated")
        .map((event) => (event.payload as { unifiedDiff: string }).unifiedDiff)
    );
    assert.equal(diffs.size, emitted, "every emitted diff is distinct");
  });
});

describe("codex replay — 13 error envelopes", () => {
  const { events } = replay("13-error-envelopes.ndjson");

  it("the JSON-string terminal error surfaces its captured provider message", () => {
    const errors = events.filter((event) => event.type === "runtime.error");
    assert.equal(errors.length, 1);
    assert.equal(
      (errors[0]!.payload as { message: string }).message,
      "The 'gpt-not-a-real-model' model is not supported when using Codex with a ChatGPT account."
    );
  });

  it("an enormous provider error retains its failure while bounding the catalogue", () => {
    const captured = readFixture("13-error-envelopes.ndjson")
      .find((line) => line.dir === "recv" && (line.frame as { id?: number }).id === 2)!
      .frame as { error: { message: string } };
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const [event] = normaliser.notification("error", {
      error: { message: captured.error.message, codexErrorInfo: "other", additionalDetails: null },
      willRetry: false,
      threadId: "thread-1",
      turnId: "turn-1"
    });
    assert.equal(event?.type, "runtime.error");
    const message = (event!.payload as { message: string }).message;
    assert.ok(message.startsWith("Invalid request: unknown variant `thread/definitelyNotAMethod`"));
    assert.ok(message.length < captured.error.message.length, "do not surface the entire captured method catalogue");
  });

  it("a model-metadata warning is a warning, and the turn still fails separately", () => {
    const warnings = events.filter((event) => event.type === "runtime.warning");
    assert.ok(
      warnings.some((event) =>
        String((event.payload as { message: string }).message).includes("Model metadata")
      ),
      "the `warning` notification is surfaced"
    );
    const failed = events.find(
      (event) =>
        event.type === "turn.completed" && (event.payload as { state: string }).state === "failed"
    );
    assert.ok(failed !== undefined, "a bad model fails at the TURN, not at the request");
  });
});

describe("codex — account failures carry a structured reason (workflows §5.4)", () => {
  // No capture holds a limit or a refused login; the frames below follow the
  // recorded envelope of 13-error-envelopes exactly, only the
  // `codexErrorInfo` differs (and the rate-limit body follows 01's).
  function errorFrame(codexErrorInfo: unknown, willRetry: boolean): unknown {
    return {
      error: {
        message: "{\"type\":\"error\",\"status\":429,\"error\":{\"message\":\"limit\"}}",
        codexErrorInfo,
        additionalDetails: null,
        misalignment: null
      },
      willRetry,
      threadId: "thread-1",
      turnId: "turn-1"
    };
  }
  function rateLimits(usedPercent: number, resetsAt: number | null): unknown {
    return {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        normalModelSlug: null,
        primary: { usedPercent, windowDurationMins: 10080, resetsAt },
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: "0" },
        individualLimit: null,
        spendControlReached: null,
        planType: "pro",
        rateLimitReachedType: null
      }
    };
  }
  function run(frames: Array<[string, unknown]>): RuntimeEvent["payload"][] {
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const out: RuntimeEvent["payload"][] = [];
    for (const [method, params] of frames) {
      for (const draft of normaliser.notification(method as never, params)) {
        if (draft.type === "runtime.error" || draft.type === "runtime.warning") {
          out.push(draft.payload);
        }
      }
    }
    return out;
  }

  for (const info of ["usageLimitExceeded", "rateLimitExceeded", "sessionBudgetExceeded"]) {
    it(`a terminal ${info} is a usage limit`, () => {
      const [payload] = run([["error", errorFrame(info, false)]]);
      assert.equal((payload as { reason?: string }).reason, "usage_limit");
      assert.equal((payload as { resetsAt?: string }).resetsAt, undefined, "no window said so");
    });
  }

  it("the reset is the exhausted window's, from the last rate-limit report", () => {
    const [payload] = run([
      ["account/rateLimits/updated", rateLimits(100, 1790220221)],
      ["error", errorFrame("usageLimitExceeded", false)]
    ]);
    assert.equal((payload as { reason?: string }).reason, "usage_limit");
    assert.equal(
      (payload as { resetsAt?: string }).resetsAt,
      new Date(1790220221 * 1000).toISOString()
    );
  });

  it("a window with headroom names no reset", () => {
    const [payload] = run([
      ["account/rateLimits/updated", rateLimits(30, 1790220221)],
      ["error", errorFrame("usageLimitExceeded", false)]
    ]);
    assert.equal((payload as { resetsAt?: string }).resetsAt, undefined);
  });

  it("a retry that may still succeed carries no reason", () => {
    const [payload] = run([["error", errorFrame("usageLimitExceeded", true)]]);
    assert.equal((payload as { reason?: string }).reason, undefined);
  });

  it("unauthorized, and a 401 connection failure, are auth", () => {
    const payloads = run([
      ["error", errorFrame("unauthorized", false)],
      ["error", errorFrame({ httpConnectionFailed: { httpStatusCode: 401 } }, false)],
      ["error", errorFrame({ httpConnectionFailed: { httpStatusCode: 502 } }, false)],
      ["error", errorFrame("other", false)]
    ]);
    assert.deepEqual(
      payloads.map((payload) => (payload as { reason?: string }).reason),
      ["auth", "auth", undefined, undefined]
    );
  });

  it("the recorded error envelopes name no account failure", () => {
    const { events } = replay("13-error-envelopes.ndjson");
    for (const event of events) {
      if (event.type === "runtime.error" || event.type === "runtime.warning") {
        assert.equal((event.payload as { reason?: string }).reason, undefined);
      }
    }
  });
});

describe("codex replay — 15 MCP elicitation", () => {
  it("mcpToolCall items carry their full arguments", () => {
    const { events } = replay("15-mcp-elicitation-approval.ndjson");
    const calls = events.filter(
      (event) => (event.payload as { itemType?: string }).itemType === "mcp_tool_call"
    );
    assert.ok(calls.length > 0);
    const call = calls.find((event) => event.itemId === "call_6Zw9kxWGAAkNTq2lnlC7RrXV");
    const data = (call?.payload as { data?: { server?: string; tool?: string; arguments?: unknown } } | undefined)?.data;
    assert.equal(data?.server, "serena");
    assert.equal(data?.tool, "replace_in_files");
    assert.deepEqual(data?.arguments, {
      relative_path: "a.ts", mode: "literal", needle: "export const a = 2;",
      repl: "export const a = 4;", expected_count: 1, max_answer_chars: 4000
    });
  });
});

describe("codex replay — hooks are a Codex notification too", () => {
  it("emits hook.started/hook.completed, which §4.2 marks Claude-only", () => {
    const { events } = replay("01-initialize-thread-start-text-turn.ndjson");
    const started = events.filter((event) => event.type === "hook.started");
    const completed = events.filter((event) => event.type === "hook.completed");
    assert.ok(started.length > 0, "an Orquester host always has hooks configured");
    assert.equal(started.length, completed.length);
    for (const event of completed) {
      assert.ok(
        ["success", "error", "cancelled"].includes(
          (event.payload as { outcome: string }).outcome
        )
      );
    }
  });
});

describe("codex replay — thread/status/changed carries waitingOnApproval", () => {
  it("does not choke on activeFlags and reports the thread as active", () => {
    const { notifications } = inbound(readFixture("02-command-approval-accept.ndjson"));
    const waiting = notifications.find((notification) =>
      notification.method === "thread/status/changed" &&
      (notification.params as { status?: { activeFlags?: string[] } }).status?.activeFlags?.includes("waitingOnApproval")
    );
    assert.ok(waiting !== undefined, "the captured provider frame carries the flag");
    const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
    const events = normaliser.notification("thread/status/changed", waiting.params);
    assert.deepEqual(events.map((event) => [event.type, event.payload]), [
      ["thread.state.changed", { state: "active" }]
    ]);
  });
});
