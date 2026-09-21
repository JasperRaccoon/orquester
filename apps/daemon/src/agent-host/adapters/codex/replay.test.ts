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

import {
  SERVER_NOTIFICATION_METHODS,
  SERVER_REQUEST_METHODS
} from "./_generated/index.ts";
import { CodexNormaliser, canonicalRequestType, presentableError } from "./normalise.ts";
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
  result?: unknown;
  error?: unknown;
}

/** Server→client frames only, split the way the transport splits them. */
function inbound(lines: FixtureLine[]): {
  notifications: { method: string; params: unknown }[];
  requests: { id: number | string; method: string; params: unknown }[];
  responses: Frame[];
} {
  const notifications: { method: string; params: unknown }[] = [];
  const requests: { id: number | string; method: string; params: unknown }[] = [];
  const responses: Frame[] = [];
  for (const line of lines) {
    if (line.dir !== "recv" || typeof line.frame !== "object" || line.frame === null) {
      continue;
    }
    const frame = line.frame as Frame;
    const hasId = frame.id !== undefined && frame.id !== null;
    if (frame.method !== undefined && hasId) {
      requests.push({ id: frame.id!, method: frame.method, params: frame.params });
    } else if (frame.method !== undefined) {
      notifications.push({ method: frame.method, params: frame.params });
    } else if (hasId) {
      responses.push(frame);
    }
  }
  return { notifications, requests, responses };
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

describe("codex replay — the whole recorded corpus", () => {
  it("routes every observed notification method without an unknown-method warning", () => {
    const unroutedByFixture: Record<string, string[]> = {};
    for (const name of fixtureNames()) {
      const { events } = replay(name);
      const unknown = events
        .filter(
          (event) =>
            event.type === "runtime.warning" &&
            typeof (event.payload as { message?: unknown }).message === "string" &&
            (event.payload as { message: string }).message.startsWith(
              "Unrecognised codex notification"
            )
        )
        .map((event) => (event.payload as { message: string }).message);
      if (unknown.length > 0) {
        unroutedByFixture[name] = unknown;
      }
    }
    assert.deepEqual(unroutedByFixture, {});
  });

  it("every observed notification method is in the generated catalogue", () => {
    const catalogued = new Set(Object.keys(SERVER_NOTIFICATION_METHODS));
    const seen = new Set<string>();
    for (const name of fixtureNames()) {
      for (const notification of replay(name).notifications) {
        seen.add(notification.method);
      }
    }
    const missing = [...seen].filter((method) => !catalogued.has(method));
    assert.deepEqual(missing, [], "the bindings must describe every method the CLI sent");
    assert.ok(seen.size >= 15, `expected a broad corpus, saw ${seen.size} methods`);
  });

  it("every observed server→client request maps to a canonical request type", () => {
    const catalogued = new Set(Object.keys(SERVER_REQUEST_METHODS));
    const seen = new Set<string>();
    for (const name of fixtureNames()) {
      for (const request of inbound(readFixture(name)).requests) {
        seen.add(request.method);
      }
    }
    assert.ok(seen.size > 0, "the corpus contains server requests");
    for (const method of seen) {
      assert.ok(catalogued.has(method), `${method} is in the generated catalogue`);
      assert.notEqual(
        canonicalRequestType(method),
        "unknown",
        `${method} maps to a canonical request type`
      );
    }
    // The four §4.5 handlers the corpus actually reaches.
    assert.deepEqual(
      [...seen].sort(),
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request"
      ]
    );
  });

  it("never emits an event type outside the §4.2 union", () => {
    const allowed = new Set([
      "session.started",
      "session.state.changed",
      "session.exited",
      "thread.started",
      "thread.state.changed",
      "thread.metadata.updated",
      "thread.token-usage.updated",
      "turn.started",
      "turn.completed",
      "turn.aborted",
      "turn.plan.updated",
      "turn.proposed.delta",
      "turn.proposed.completed",
      "turn.diff.updated",
      "item.started",
      "item.updated",
      "item.completed",
      "content.delta",
      "request.opened",
      "request.resolved",
      "user-input.requested",
      "user-input.resolved",
      "task.started",
      "task.progress",
      "task.updated",
      "task.completed",
      "hook.started",
      "hook.progress",
      "hook.completed",
      "tool.progress",
      "tool.denied",
      "auth.status",
      "account.rate-limits.updated",
      "model.rerouted",
      "runtime.warning",
      "runtime.error"
    ]);
    for (const name of fixtureNames()) {
      for (const event of replay(name).events) {
        assert.ok(allowed.has(event.type), `${name}: ${event.type} is in the union`);
      }
    }
  });
});

describe("codex replay — no item is left dangling inProgress (R3 finding 1)", () => {
  /**
   * The reviewer's exact reproduction: replay each capture and pair
   * `item.started` / `item.completed` by `itemId`. Before the fix, `06-…`,
   * `14-…` and `05-…` each left one.
   *
   * `14-…` is SIGTERM with no `turn/completed` at all, so the protocol stream
   * alone cannot close it — the session's `handleExit` does, which the replay
   * models by draining `closeOpenItems()` at stream end exactly as
   * `handleExit` step 1 does.
   */
  function danglingItems(name: string, drainAtEnd: boolean): string[] {
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
    if (drainAtEnd) {
      apply(normaliser.closeOpenItems("failed"));
    }
    return [...open.keys()];
  }

  it("every capture that ends with a settled turn closes all its items", () => {
    const leftOpen: Record<string, string[]> = {};
    for (const name of fixtureNames()) {
      // `14-…` is the SIGTERM capture: the stream simply stops.
      const dangling = danglingItems(name, name.startsWith("14-"));
      if (dangling.length > 0) {
        leftOpen[name] = dangling;
      }
    }
    assert.deepEqual(leftOpen, {});
  });

  it("06 (interrupt with a pending approval) closes its abandoned command", () => {
    // Fixtures README obs. 5: "the commandExecution item that was inProgress
    // never gets an item/completed … Both dangle forever."
    assert.deepEqual(danglingItems("06-interrupt-with-pending-approval.ndjson", false), []);
  });

  it("14 (SIGTERM mid-turn) needs the session's exit drain, and is closed by it", () => {
    assert.equal(
      danglingItems("14-sigterm-mid-turn.ndjson", false).length,
      1,
      "the protocol stream alone cannot close it — SIGTERM writes not one further byte"
    );
    assert.deepEqual(
      danglingItems("14-sigterm-mid-turn.ndjson", true),
      [],
      "handleExit's closeOpenItems is what closes it"
    );
  });
});

describe("codex replay — 01 initialize, thread start, one text turn", () => {
  const { events } = replay("01-initialize-thread-start-text-turn.ndjson");

  it("emits thread.started with the provider thread id from result.thread.id", () => {
    const started = events.find((event) => event.type === "thread.started");
    assert.ok(started !== undefined);
    assert.match(
      (started.payload as { providerThreadId: string }).providerThreadId,
      /^[0-9a-f-]{36}$/
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
    assert.ok(text.length > 0);
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

  it("reports the context window on thread.token-usage.updated", () => {
    const usage = events.filter((event) => event.type === "thread.token-usage.updated");
    assert.ok(usage.length > 0);
    const last = usage.at(-1)!.payload as { usage: { usedTokens: number; maxTokens?: number } };
    assert.ok(last.usage.usedTokens > 0);
    assert.equal(typeof last.usage.maxTokens, "number");
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

describe("codex replay — 04 file-change approval", () => {
  const { events } = replay("04-file-change-approval.ndjson");

  it("the diff arrives on the fileChange ITEM, not on the approval request", () => {
    const item = events.find(
      (event) =>
        event.type === "item.started" &&
        (event.payload as { itemType: string }).itemType === "file_change"
    );
    assert.ok(item !== undefined, "a file_change item.started is emitted");
    const data = (item.payload as { data?: { changes?: { path: string; diff: string }[] } }).data;
    assert.ok((data?.changes?.length ?? 0) > 0);
    assert.equal(typeof data!.changes![0]!.diff, "string");
    // Rendering the card means joining on itemId.
    assert.equal(typeof item.itemId, "string");
  });
});

describe("codex replay — 05 request_user_input", () => {
  it("the question field is `question`, options have no `value`, and isOther maps to allowCustomAnswer", () => {
    const requests = inbound(readFixture("05-tool-request-user-input.ndjson")).requests.filter(
      (request) => request.method === "item/tool/requestUserInput"
    );
    assert.ok(requests.length >= 1);
    const params = requests[0]!.params as {
      questions: {
        id: string;
        header: string;
        question: string;
        isOther: boolean;
        isSecret: boolean;
        options: { label: string; description: string }[] | null;
      }[];
      isBlocking: boolean;
    };
    const question = params.questions[0]!;
    assert.equal(typeof question.question, "string");
    assert.ok(!("prompt" in question), "a filter keyed on `prompt` would drop every question");
    assert.ok(!("value" in question.options![0]!), "options carry no value; answer with the label");
    assert.equal(typeof question.isOther, "boolean");
    assert.equal(typeof question.isSecret, "boolean");
    assert.equal(typeof params.isBlocking, "boolean");
  });
});

describe("codex replay — 08 compaction", () => {
  const { events, notifications } = replay("08-compaction.ndjson");

  it("thread/compacted never fires; the contextCompaction item is the signal", () => {
    assert.equal(
      notifications.filter((n) => n.method === "thread/compacted").length,
      0,
      "thread/compacted is never emitted on this CLI"
    );
    const item = events.find(
      (event) =>
        event.type === "item.completed" &&
        (event.payload as { itemType: string }).itemType === "context_compaction"
    );
    assert.ok(item !== undefined);
  });

  it("synthesises thread.state.changed {state:'compacted'} from the item", () => {
    const compacted = events.find(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.payload as { state: string }).state === "compacted"
    );
    assert.ok(compacted !== undefined);
    assert.equal(typeof (compacted.payload as { afterTokens?: number }).afterTokens, "number");
  });

  it("compaction runs as a whole extra turn", () => {
    const turnsStarted = events.filter((event) => event.type === "turn.started");
    assert.ok(turnsStarted.length >= 2, "the compaction is its own turn");
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

  it("never emits turn.plan.updated — the update_plan tool is forbidden in plan mode", () => {
    assert.equal(events.filter((event) => event.type === "turn.plan.updated").length, 0);
  });

  it("an unprompted compaction mid-turn still produces the compacted state", () => {
    const compacted = events.filter(
      (event) =>
        event.type === "thread.state.changed" &&
        (event.payload as { state: string }).state === "compacted"
    );
    assert.ok(compacted.length > 0, "compaction happens unprompted too");
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

describe("codex replay — 12 rollback and revert", () => {
  const lines = readFixture("12-rollback-and-revert.ndjson");
  const { notifications, responses } = inbound(lines);

  it("thread/rollback is dead on a paginated thread", () => {
    const sent = lines
      .filter((line) => line.dir === "send")
      .map((line) => line.frame as Frame)
      .filter((frame) => frame.method === "thread/rollback");
    assert.equal(sent.length, 1, "the capture proves the dead path");
    const failed = responses.find(
      (frame) =>
        frame.error !== undefined &&
        typeof (frame.error as { message?: unknown }).message === "string" &&
        (frame.error as { message: string }).message.includes("do not support thread/rollback")
    );
    assert.ok(failed !== undefined, "thread/rollback answers -32600");
  });

  it("thread/reverted is the notification the working path emits", () => {
    assert.equal(notifications.filter((n) => n.method === "thread/reverted").length, 1);
  });

  it("thread/reverted is handled without a warning", () => {
    const { events } = replay("12-rollback-and-revert.ndjson");
    const warnings = events.filter(
      (event) =>
        event.type === "runtime.warning" &&
        String((event.payload as { message: string }).message).includes("thread/reverted")
    );
    assert.deepEqual(warnings, []);
  });
});

describe("codex replay — 13 error envelopes", () => {
  const { events } = replay("13-error-envelopes.ndjson");

  it("willRetry:false becomes runtime.error, never a warning", () => {
    const errors = events.filter((event) => event.type === "runtime.error");
    assert.ok(errors.length > 0, "a terminal provider error is an error");
    for (const error of errors) {
      assert.ok(
        ["provider_error", "transport_error", "permission_error", "validation_error", "unknown"].includes(
          (error.payload as { class: string }).class
        )
      );
    }
  });

  it("the JSON-string error message is parsed into something presentable", () => {
    const errors = events.filter((event) => event.type === "runtime.error");
    const message = (errors[0]!.payload as { message: string }).message;
    assert.ok(!message.startsWith("{"), `expected prose, got ${message.slice(0, 40)}`);
    assert.ok(message.length <= 600, "an error message is bounded");
  });

  it("presentableError bounds the ~8 KB unknown-method catalogue", () => {
    const enormous = `Invalid request: unknown variant \`x\`, expected one of ${"`m`, ".repeat(2000)}`;
    assert.ok(presentableError(enormous).length <= 600);
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

describe("codex replay — 15 MCP elicitation", () => {
  it("the params are a rendered form with the approval kind in _meta", () => {
    const requests = inbound(readFixture("15-mcp-elicitation-approval.ndjson")).requests.filter(
      (request) => request.method === "mcpServer/elicitation/request"
    );
    assert.ok(requests.length >= 1);
    const params = requests[0]!.params as {
      mode: string;
      message: string;
      serverName: string;
      _meta: { codex_approval_kind?: string; persist?: string[] } | null;
    };
    assert.equal(params.mode, "form");
    assert.ok(params.message.length > 0, "`message` is the provider's own wording");
    assert.equal(params._meta?.codex_approval_kind, "mcp_tool_call");
    assert.deepEqual(params._meta?.persist, ["session", "always"]);
  });

  it("mcpToolCall items carry their full arguments", () => {
    const { events } = replay("15-mcp-elicitation-approval.ndjson");
    const calls = events.filter(
      (event) => (event.payload as { itemType?: string }).itemType === "mcp_tool_call"
    );
    assert.ok(calls.length > 0);
    const data = (calls[0]!.payload as { data?: { server?: string; tool?: string } }).data;
    assert.equal(typeof data?.server, "string");
    assert.equal(typeof data?.tool, "string");
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

describe("codex replay — rate limits", () => {
  it("maps the weekly window with a stable id", () => {
    const { events } = replay("01-initialize-thread-start-text-turn.ndjson");
    const updates = events.filter((event) => event.type === "account.rate-limits.updated");
    assert.ok(updates.length > 0);
    const windows = (
      updates[0]!.payload as { limits: { windows: { id: string; kind: string; windowDurationMins?: number }[] } }
    ).limits.windows;
    assert.ok(windows.length > 0);
    assert.equal(windows[0]!.id, "codex:primary", "the id is stable so a sparse update merges");
    assert.equal(windows[0]!.kind, "weekly");
    assert.equal(windows[0]!.windowDurationMins, 10_080);
  });
});

describe("codex replay — thread/status/changed carries waitingOnApproval", () => {
  it("does not choke on activeFlags and reports the thread as active", () => {
    const { events, notifications } = replay("02-command-approval-accept.ndjson");
    const waiting = notifications.filter(
      (n) =>
        n.method === "thread/status/changed" &&
        Array.isArray(
          (n.params as { status?: { activeFlags?: unknown } }).status?.activeFlags
        ) &&
        ((n.params as { status: { activeFlags: string[] } }).status.activeFlags ?? []).includes(
          "waitingOnApproval"
        )
    );
    assert.ok(waiting.length > 0, "the flag IS emitted, contrary to §4.2");
    const states = events
      .filter((event) => event.type === "thread.state.changed")
      .map((event) => (event.payload as { state: string }).state);
    assert.ok(states.every((state) => state === "active" || state === "idle"));
  });
});
