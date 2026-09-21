/**
 * Claude adapter — the fixture replay harness (spec §9).
 *
 * `apps/daemon/test/fixtures/claude/*.ndjson` is real traffic captured from
 * the CLI installed on this host. This module replays one of those files
 * through {@link ClaudeNormalizer} exactly as the live session would drive it,
 * so a replay test asserts the normalised `RuntimeEvent` sequence against
 * reality rather than against the design's guesses.
 *
 * It lives beside the source (not under `test/`) because the smoke script uses
 * the same deterministic clock and id generator.
 */

import { readFileSync, readdirSync } from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import type { RuntimeEvent, UserInputQuestion } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Clock, IdGen } from "../../adapter.ts";
import { classifyRequestType, summarizeToolRequest, trimmedString } from "./classify.ts";
import { ClaudeNormalizer, extractExitPlanModePlan } from "./normalize.ts";
import { questionsFromAskUserQuestionInput } from "./questions.ts";

export const CLAUDE_FIXTURES_DIR = nodePath.resolve(
  nodePath.dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/claude"
);

export interface FixtureLine {
  t: number;
  kind: "sdk-message" | "input" | "canUseTool" | "canUseToolResult" | "control" | "note";
  data: unknown;
}

export function listClaudeFixtures(): string[] {
  return readdirSync(CLAUDE_FIXTURES_DIR)
    .filter((name) => name.endsWith(".ndjson"))
    .sort();
}

export function readClaudeFixture(name: string): FixtureLine[] {
  const raw = readFileSync(nodePath.join(CLAUDE_FIXTURES_DIR, name), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureLine);
}

/** A clock that never moves, so a replay is byte-stable (§9). */
export function fixedClock(iso = "2026-09-21T00:00:00.000Z"): Clock {
  const date = new Date(iso);
  return { now: () => date, nowIso: () => iso };
}

/** Counting id generators, so a replay is byte-stable (§9). */
export function countingIds(): IdGen {
  let events = 0;
  let messages = 0;
  let uuids = 0;
  return {
    eventId: () => `ev-${++events}`,
    messageId: (prefix) => `${prefix}-${++messages}`,
    uuid: () => `uuid-${++uuids}`
  };
}

export interface ReplayResult {
  events: RuntimeEvent[];
  /** Every `type` / `type:subtype` the capture contained. */
  observed: string[];
  normalizer: ClaudeNormalizer;
}

export function sdkMessageTag(message: unknown): string {
  if (message === null || typeof message !== "object") {
    return "<non-object>";
  }
  const record = message as { type?: unknown; subtype?: unknown };
  const type = typeof record.type === "string" ? record.type : "<untyped>";
  return typeof record.subtype === "string" ? `${type}/${record.subtype}` : type;
}

/**
 * Replay one capture. `input` lines open a turn (the harness stamps the turn
 * id as the message uuid, exactly as `sendTurn` does), `canUseTool` lines open
 * an approval or a question, and `canUseToolResult` lines resolve it.
 */
export function replayClaudeFixture(name: string): ReplayResult {
  const lines = readClaudeFixture(name);
  const normalizer = new ClaudeNormalizer({
    threadId: "thread-fixture",
    clock: fixedClock(),
    ids: countingIds()
  });
  const events: RuntimeEvent[] = [];
  const observed: string[] = [];
  let pendingRequest:
    | { requestId: string; kind: "approval" | "question"; toolName: string; toolUseId?: string }
    | undefined;
  let requestSeq = 0;

  for (const line of lines) {
    switch (line.kind) {
      case "input": {
        const data = line.data as { uuid?: unknown };
        const turnId = typeof data.uuid === "string" ? data.uuid : `turn-${events.length}`;
        events.push(...normalizer.beginTurn({ turnId, anchorUuid: turnId }));
        break;
      }
      case "sdk-message": {
        observed.push(sdkMessageTag(line.data));
        events.push(...normalizer.handleMessage(line.data as SDKMessage));
        break;
      }
      case "canUseTool": {
        const data = line.data as {
          toolName?: unknown;
          input?: unknown;
          options?: { toolUseID?: unknown; requestId?: unknown; description?: unknown };
        };
        const toolName = typeof data.toolName === "string" ? data.toolName : "unknown";
        const toolInput =
          data.input !== null && typeof data.input === "object"
            ? (data.input as Record<string, unknown>)
            : {};
        // The SDK's own `requestId` is the key, because the SDK redelivers a
        // request whose response was lost in a transport gap (fixtures README
        // observation 11).
        const requestId =
          trimmedString(data.options?.requestId) ?? `req-${(requestSeq += 1)}`;
        const toolUseId = trimmedString(data.options?.toolUseID);
        if (toolName === "AskUserQuestion") {
          const questions: UserInputQuestion[] = questionsFromAskUserQuestionInput(toolInput);
          events.push(
            normalizer.userInputRequested({
              requestId,
              questions,
              toolInput,
              ...(toolUseId !== undefined ? { toolUseId } : {})
            })
          );
          pendingRequest = {
            requestId,
            kind: "question",
            toolName,
            ...(toolUseId !== undefined ? { toolUseId } : {})
          };
          break;
        }
        if (toolName === "ExitPlanMode") {
          const plan = extractExitPlanModePlan(toolInput);
          if (plan) {
            events.push(
              ...normalizer.proposedPlanCompleted({
                planMarkdown: plan.planMarkdown,
                ...(toolUseId !== undefined ? { toolUseId } : {}),
                ...(plan.planFilePath !== undefined ? { planFilePath: plan.planFilePath } : {}),
                source: "claude.sdk.permission",
                method: "canUseTool/ExitPlanMode",
                payload: { toolName, input: toolInput }
              })
            );
          }
          pendingRequest = undefined;
          break;
        }
        events.push(
          normalizer.requestOpened({
            requestId,
            requestType: classifyRequestType(toolName),
            detail: trimmedString(data.options?.description) ?? summarizeToolRequest(toolName, toolInput),
            toolName,
            toolInput,
            ...(toolUseId !== undefined ? { toolUseId } : {})
          })
        );
        pendingRequest = {
          requestId,
          kind: "approval",
          toolName,
          ...(toolUseId !== undefined ? { toolUseId } : {})
        };
        break;
      }
      case "canUseToolResult": {
        if (!pendingRequest) {
          break;
        }
        const data = line.data as { result?: { behavior?: unknown; updatedInput?: unknown } };
        if (pendingRequest.kind === "question") {
          const answers =
            data.result?.updatedInput !== null &&
            typeof data.result?.updatedInput === "object" &&
            (data.result.updatedInput as { answers?: unknown }).answers !== undefined
              ? ((data.result.updatedInput as { answers: Record<string, unknown> }).answers)
              : {};
          events.push(
            normalizer.userInputResolved({
              requestId: pendingRequest.requestId,
              answers,
              ...(pendingRequest.toolUseId !== undefined
                ? { toolUseId: pendingRequest.toolUseId }
                : {})
            })
          );
        } else {
          const behavior = data.result?.behavior;
          const decision =
            behavior === "allow"
              ? ((data.result as { updatedPermissions?: unknown }).updatedPermissions !== undefined
                  ? ("acceptForSession" as const)
                  : ("accept" as const))
              : ((data.result as { message?: unknown }).message === "User cancelled tool execution."
                  ? ("cancel" as const)
                  : ("decline" as const));
          events.push(
            normalizer.requestResolved({
              requestId: pendingRequest.requestId,
              requestType: classifyRequestType(pendingRequest.toolName),
              decision,
              ...(pendingRequest.toolUseId !== undefined
                ? { toolUseId: pendingRequest.toolUseId }
                : {})
            })
          );
        }
        pendingRequest = undefined;
        break;
      }
      case "control":
      case "note":
        break;
    }
  }

  return { events, observed, normalizer };
}

export function eventTypes(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) => event.type);
}
