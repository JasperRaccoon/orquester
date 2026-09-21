/**
 * Grok adapter — reading the `_meta` blocks (spec §4.5 Grok, fixtures
 * observations 14, 15, 31).
 *
 * Every ACP frame Grok sends carries a vendor `_meta`, and it is where most of
 * the information the UI needs actually lives. None of it is typed by the ACP
 * schema, so every read is a hand-rolled shape check with an `undefined`
 * fallback — an unexpected shape must degrade a field, never throw.
 */

import type { XaiToolMeta, XaiUpdateMeta } from "./acp/_generated/xai.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * `_meta["x.ai/tool"]` on every `tool_call` / `tool_call_update`.
 *
 * ```json
 * {"version":1,"name":"enter_plan_mode","kind":"enter_plan",
 *  "namespace":"grok_build","label":"Enter Plan Mode","read_only":true}
 * ```
 *
 * `kind` is the **authoritative** tool discriminant (observation 15): T3
 * detects plan mode by matching tool titles, which this CLI makes unnecessary.
 * `read_only` is a free safety signal.
 */
export function xaiToolMeta(meta: unknown): XaiToolMeta | undefined {
  const block = record(record(meta)?.["x.ai/tool"]);
  if (block === undefined) {
    return undefined;
  }
  const name = nonEmptyString(block["name"]);
  const kind = nonEmptyString(block["kind"]);
  if (name === undefined || kind === undefined) {
    return undefined;
  }
  return {
    version: finiteNumber(block["version"]) ?? 1,
    name,
    kind: kind as XaiToolMeta["kind"],
    namespace: nonEmptyString(block["namespace"]) ?? "",
    label: nonEmptyString(block["label"]) ?? name,
    read_only: block["read_only"] === true,
    ...(record(block["input"]) === undefined ? {} : { input: record(block["input"]) })
  };
}

/** The `_meta` carried on `session/update` and `_x.ai/session_notification`. */
export function xaiUpdateMeta(meta: unknown): XaiUpdateMeta | undefined {
  const block = record(meta);
  return block === undefined ? undefined : (block as XaiUpdateMeta);
}

/** `true` on every frame replayed by `session/load` (observation 10). */
export function isReplayFrame(meta: unknown): boolean {
  return record(meta)?.["isReplay"] === true;
}

/** The turn a streamed frame belongs to, so two outstanding prompts don't mix. */
export function promptIdOf(meta: unknown): string | undefined {
  const block = record(meta);
  return nonEmptyString(block?.["promptId"]) ?? nonEmptyString(block?.["requestId"]);
}

/**
 * The **running context size** in tokens, present on every streamed chunk and
 * on the `session/prompt` result.
 *
 * Careful: the two `totalTokens` fields mean different things. This one is the
 * context size; `usage.totalTokens` is the turn's input+output. A locally
 * handled slash command reports `"totalTokens": 0` — **treat 0 as "no
 * measurement", not "empty context"** (observation 14).
 */
export function contextTokensOf(meta: unknown): number | undefined {
  const total = finiteNumber(record(meta)?.["totalTokens"]);
  return total === undefined || total <= 0 ? undefined : total;
}

/**
 * `_meta.agentVersion` from `initialize`. Read on **every** handshake, never
 * cached per host: the CLI ships `auto_update = true` and replaced itself
 * mid-capture, changing models, auth methods and the effort catalog between
 * two spawns of one thread (observation 26).
 */
export function agentVersionOf(initializeMeta: unknown): string | undefined {
  return nonEmptyString(record(initializeMeta)?.["agentVersion"]);
}

/**
 * `initialize._meta.modelState.availableModels[]._meta.totalContextTokens`
 * for the current model — 500 000 on both models of 1.0.34. This is what makes
 * `reportsContextWindow` true for Grok, against the spec's claim that it
 * reports nothing (observation 14).
 */
export function contextWindowFromModelState(modelState: unknown, modelId?: string): number | undefined {
  const state = record(modelState);
  if (state === undefined) {
    return undefined;
  }
  const models = state["availableModels"];
  if (!Array.isArray(models)) {
    return undefined;
  }
  const current = nonEmptyString(modelId) ?? nonEmptyString(state["currentModelId"]);
  let fallback: number | undefined;
  for (const entry of models) {
    const model = record(entry);
    if (model === undefined) {
      continue;
    }
    const total = finiteNumber(record(model["_meta"])?.["totalContextTokens"]);
    if (total === undefined) {
      continue;
    }
    if (nonEmptyString(model["modelId"]) === current) {
      return total;
    }
    fallback ??= total;
  }
  return fallback;
}

/** `_meta.modelState` wherever it appears (initialize, session/new, …). */
export function modelStateOf(meta: unknown): unknown {
  return record(meta)?.["modelState"];
}
