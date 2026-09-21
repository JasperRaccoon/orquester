/**
 * Grok adapter — launch configuration (spec §3.2, §4.4, §4.5 Grok, §10).
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/acp/GrokAcpSupport.ts`.
 *
 * Everything that decides *how the child is started* lives here: argv per
 * runtime mode, the extra environment, the minimum-version gate, the model /
 * reasoning-effort payload for `session/set_model`, and the one piece of
 * on-disk configuration the host owns.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ModelSelection, RuntimeMode } from "@orquester/api/agent-chat";

/**
 * Argv per runtime mode. **The flag position moves**: `--permission-mode` is a
 * *global* option and must precede the `agent` subcommand, while
 * `--always-approve` is an option *of* `agent` and must follow it. It is
 * `grok agent stdio`, never `grok --acp`.
 *
 * *T3: `GrokAcpSupport.ts:33-46` (`grokAcpSpawnArgs`).*
 *
 * **Reality check** (`apps/daemon/test/fixtures/grok/09*.ndjson`, observation
 * 6): measured against a file write with `support_permission = true`,
 * `default` asks, `auto` does not, `agent --always-approve` does not — and
 * `acceptEdits` **still asks**, i.e. the flag is a no-op for the ACP edit
 * gate. The argv below is still the spec's, because it is what the CLI
 * documents and a later release may honour; the *behaviour* the mode promises
 * is delivered by {@link autoApprovesEdits} instead, which makes the adapter
 * answer edit approvals itself. Without that compensation the mode would be a
 * label for nothing.
 */
export function grokSpawnArgs(mode: RuntimeMode): readonly string[] {
  switch (mode) {
    case "approval-required":
      return ["--permission-mode", "default", "agent", "stdio"];
    case "auto-accept-edits":
      return ["--permission-mode", "acceptEdits", "agent", "stdio"];
    case "auto":
      return ["--permission-mode", "auto", "agent", "stdio"];
    case "full-access":
      // `--always-approve` belongs to `agent`, so it goes AFTER it.
      return ["agent", "--always-approve", "stdio"];
    default: {
      const exhaustive: never = mode;
      void exhaustive;
      return ["--permission-mode", "default", "agent", "stdio"];
    }
  }
}

/**
 * True where the adapter must answer an edit-flavoured approval itself,
 * because the CLI flag that should have done it is a no-op (see
 * {@link grokSpawnArgs}). `full-access` is covered here too as belt and
 * braces: `--always-approve` did suppress every ask in the captures, but a
 * mode the user selected must not depend on that holding.
 */
export function autoApprovesEdits(mode: RuntimeMode): boolean {
  return mode === "auto-accept-edits" || mode === "auto" || mode === "full-access";
}

/** True where EVERY approval is answered by the adapter without a card (§4.3). */
export function autoApprovesEverything(mode: RuntimeMode): boolean {
  return mode === "full-access";
}

/**
 * Extra environment for the child, on top of `support/env.ts`'s base.
 *
 * - `GROK_OAUTH2_REFERRER` is T3's marker (`GrokAcpSupport.ts:48-63`).
 * - `GROK_ASK_USER_QUESTION=1` turns on the `ask_user_question` tool. It is
 *   off by default and **in every capture without this variable the model
 *   never called the tool** (observation 16), so the §7.5 question card would
 *   simply never appear on Grok. It is opt-in per spawn, not a user setting.
 * - `GROK_HOME` is NOT set here — `support/env.ts` binds the managed account
 *   home through `ACCOUNT_HOME_ENV_VAR`, and `XAI_API_KEY` is stripped by the
 *   same module's ambient-credential denylist so a thread can never silently
 *   bill an identity the user did not select (§3.1).
 */
export const GROK_EXTRA_ENV: Readonly<Record<string, string>> = {
  GROK_OAUTH2_REFERRER: "orquester",
  GROK_ASK_USER_QUESTION: "1"
};

/**
 * The lowest CLI this adapter will start a session against (§3.2, §10). A CLI
 * below it is **refused with the required version in the message** rather than
 * started and allowed to fail on the first unrecognised frame.
 *
 * 1.0.3 is the oldest build seen speaking this protocol on this host; 1.0.34
 * is what every fixture was captured from.
 */
export const MINIMUM_GROK_VERSION = "1.0.3";
/** The version the fixtures — and therefore the normaliser — were built against. */
export const VALIDATED_GROK_VERSION = "1.0.34";

/** `grok 1.0.34 (3736acbc8658) [stable]` → `1.0.34`. */
export function parseGrokVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match === null ? null : match[1];
}

/** Numeric-segment compare; a non-numeric suffix is ignored. -1 / 0 / 1. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const l = Number.isFinite(left[index]) ? (left[index] as number) : 0;
    const r = Number.isFinite(right[index]) ? (right[index] as number) : 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function meetsMinimumGrokVersion(version: string | null): boolean {
  // §10: "a CLI whose version cannot be read is treated as unsupported
  // wherever a window exists" — but Grok's version is read from the handshake
  // itself, so a null here means the handshake told us nothing, which is a
  // protocol surprise rather than an old binary. Allowing it keeps a working
  // CLI usable; the advisory still reports `unknown`.
  if (version === null) {
    return true;
  }
  return compareVersions(version, MINIMUM_GROK_VERSION) >= 0;
}

export function versionGateMessage(version: string | null): string {
  return `Grok ${version ?? "(unknown version)"} is too old for chat. Update to ${MINIMUM_GROK_VERSION} or newer (\`npm install -g @xai-official/grok\`).`;
}

// ---------------------------------------------------------------------------
// Model + reasoning effort (§4.5 "Model switching uses the unstable
// `session/set_model` RPC")
// ---------------------------------------------------------------------------

/**
 * The product slug. It means "keep the session's current model" and is
 * **never sent over the wire** — `13-errors-and-rpcs.ndjson` shows it coming
 * back as a hard `-32602 "unknown model id"`, exactly like a typo.
 */
export const GROK_PRODUCT_SLUG = "grok-build";

/** T3's validation for a reasoning-effort id. *T3: `GrokAcpSupport.ts:101-122`.* */
const REASONING_EFFORT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

/**
 * The descriptor id Grok's model options use. Carried as ACP `_meta`, not as
 * a config option (§4.1 "Grok `reasoningEffort` carried as ACP `_meta`").
 */
export const GROK_EFFORT_OPTION_ID = "reasoningEffort";

export interface GrokModelRequest {
  modelId: string;
  /** Omitted entirely when there is no valid preference — see below. */
  meta?: { reasoningEffort: string };
}

export interface GrokModelState {
  currentModelId?: string;
  currentReasoningEffort?: string;
}

/**
 * The `session/set_model` decision table, or `null` when **nothing must be
 * sent**.
 *
 * Four rules, all load-bearing:
 * - the product slug is never sent (see {@link GROK_PRODUCT_SLUG});
 * - the call is skipped entirely when neither the model nor the effort
 *   changed, which is what stops a same-model reselection from touching the
 *   CLI-advertised default;
 * - an **invalid** effort is dropped rather than forwarded, so a stale client
 *   value cannot make the RPC fail; and
 * - an **absent** preference is never sent as an explicit clear — `_meta` is
 *   omitted, not sent empty.
 *
 * *T3: `GrokAcpSupport.ts:156-187` (`applyGrokAcpModelSelection`), with the
 * no-explicit-clear comment at `:181-187`.*
 */
export function resolveGrokModelUpdate(
  selection: ModelSelection | undefined,
  state: GrokModelState = {}
): GrokModelRequest | null {
  const requestedRaw = selection?.model.trim();
  const requestedModelId =
    requestedRaw === undefined || requestedRaw.length === 0 || requestedRaw === GROK_PRODUCT_SLUG
      ? undefined
      : requestedRaw;

  const provided = hasReasoningEffortPreference(selection);
  const effort = grokReasoningEffort(selection);

  const modelChanged = requestedModelId !== undefined && requestedModelId !== state.currentModelId;
  // `provided && effort !== current` — an explicitly-sent INVALID effort still
  // counts as a change (undefined !== "high"), and then goes out as a bare
  // `{modelId}`, which is how the invalid value is dropped rather than echoed.
  const effortChanged = provided && (effort ?? undefined) !== state.currentReasoningEffort;

  const targetModelId = requestedModelId ?? state.currentModelId;
  if ((!modelChanged && !effortChanged) || targetModelId === undefined) {
    return null;
  }
  return provided && effort !== null
    ? { modelId: targetModelId, meta: { reasoningEffort: effort } }
    : { modelId: targetModelId };
}

/** Whether the selection names a reasoning effort at all, valid or not. */
export function hasReasoningEffortPreference(selection: ModelSelection | undefined): boolean {
  return selection?.options?.some((entry) => entry.id === GROK_EFFORT_OPTION_ID) === true;
}

/** The validated `reasoningEffort` of a selection, or null. */
export function grokReasoningEffort(selection: ModelSelection | undefined): string | null {
  const option = selection?.options?.find((entry) => entry.id === GROK_EFFORT_OPTION_ID);
  if (option === undefined || typeof option.value !== "string") {
    return null;
  }
  const value = option.value.trim();
  return REASONING_EFFORT_RE.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// The one piece of on-disk configuration the host owns
// ---------------------------------------------------------------------------

/**
 * Keys the adapter writes into a **managed** account home's `config.toml`:
 *
 * - `[features] support_permission = true`. This is the single biggest
 *   behavioural surprise in the capture set (observation 5): with the stock
 *   configuration a file write under `--permission-mode default` produces **no
 *   `session/request_permission` at all** — the agent resolves the interaction
 *   itself, 6 ms apart, and the whole approvals surface of §4.3 silently never
 *   fires. The user would get an agent that approves itself while the UI
 *   claims it is supervised. Neither the spec nor T3 mentions the setting.
 * - `[cli] auto_update = false`. The stock home ships `auto_update = true` and
 *   the binary replaced itself *mid-capture* (1.0.3 → 1.0.34), changing the
 *   model list, the auth methods and the effort catalog between two spawns of
 *   one thread (observation 26). A deployment that pins the version it was
 *   validated against is the only way a version gate means anything.
 *
 * Applied ONLY to a home the host owns. A `system` home is the user's own
 * `~/.grok` and the adapter must not rewrite it — see
 * {@link grokConfigAdvisory}.
 */
export const GROK_MANAGED_CONFIG: ReadonlyArray<{ section: string; key: string; value: string }> = [
  { section: "features", key: "support_permission", value: "true" },
  { section: "cli", key: "auto_update", value: "false" }
];

export function grokConfigPath(homeDir: string): string {
  return join(homeDir, "config.toml");
}

/**
 * What to tell the user when the home is not ours to edit. Returned rather
 * than thrown: a missing setting degrades the approvals surface, it does not
 * stop the session.
 */
export function grokConfigAdvisory(): string {
  return "Grok will approve tool calls itself unless `[features] support_permission = true` is set in its config; approval cards are disabled for this session.";
}

/**
 * Apply {@link GROK_MANAGED_CONFIG} to a TOML file, preserving everything
 * else. Returns the new text, or `null` when nothing needed changing.
 *
 * Deliberately a **targeted patcher, not a TOML parser**: this file is the
 * user's (through the managed home) and a round-trip through a serialiser
 * would reformat comments and ordering it is not ours to touch. No new
 * dependency either (§1 rule 5).
 */
export function patchGrokConfig(source: string): string | null {
  let text = source;
  let changed = false;

  for (const { section, key, value } of GROK_MANAGED_CONFIG) {
    const range = sectionRange(text, section);
    if (range === null) {
      const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
      text = `${text}${prefix}${text.length === 0 ? "" : "\n"}[${section}]\n${key} = ${value}\n`;
      changed = true;
      continue;
    }
    const body = text.slice(range.start, range.end);
    const assignment = new RegExp(`^([ \\t]*)${escapeRegExp(key)}([ \\t]*=[ \\t]*)(.*)$`, "m");
    const match = assignment.exec(body);
    if (match === null) {
      const insertion = body.endsWith("\n") || body.length === 0 ? "" : "\n";
      const nextBody = `${body}${insertion}${key} = ${value}\n`;
      text = `${text.slice(0, range.start)}${nextBody}${text.slice(range.end)}`;
      changed = true;
      continue;
    }
    if (match[3].trim() === value) {
      continue;
    }
    const nextBody = body.replace(assignment, `$1${key}$2${value}`);
    text = `${text.slice(0, range.start)}${nextBody}${text.slice(range.end)}`;
    changed = true;
  }

  return changed ? text : null;
}

/**
 * Best-effort: read, patch, write. Never throws — a read-only home or a
 * malformed file must not stop a session starting, it only costs the
 * approvals surface, which the caller surfaces as a warning.
 */
export async function ensureGrokManagedConfig(homeDir: string): Promise<"unchanged" | "patched" | "failed"> {
  const path = grokConfigPath(homeDir);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "failed";
    }
  }
  const next = patchGrokConfig(existing);
  if (next === null) {
    return "unchanged";
  }
  try {
    await writeFile(path, next, { encoding: "utf8", mode: 0o600 });
    return "patched";
  } catch {
    return "failed";
  }
}

/** `[name]` … up to the next `[` at the start of a line, or EOF. */
function sectionRange(text: string, section: string): { start: number; end: number } | null {
  const header = new RegExp(`^[ \\t]*\\[${escapeRegExp(section)}\\][ \\t]*$`, "m");
  const match = header.exec(text);
  if (match === null) {
    return null;
  }
  const start = match.index + match[0].length + 1;
  const rest = text.slice(start);
  const next = /^[ \t]*\[/m.exec(rest);
  return { start, end: next === null ? text.length : start + next.index };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
