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

import { lstat, mkdir, writeFile } from "node:fs/promises";
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
 * The config the adapter needs the CLI to see, as an **overlay it owns
 * outright** — never a key written into a file somebody else's process owns.
 *
 * - `[features] support_permission = true`. The single biggest behavioural
 *   surprise in the capture set (observation 5): with the stock configuration
 *   a file write under `--permission-mode default` produces **no
 *   `session/request_permission` at all` — the agent resolves the interaction
 *   itself, 6 ms apart, and the whole approvals surface of §4.3 silently never
 *   fires while the UI claims the thread is supervised. Neither the spec nor
 *   T3 mentions the setting.
 * - `[cli] auto_update = false`. The stock home ships `auto_update = true` and
 *   the binary replaced itself *mid-capture* (1.0.3 → 1.0.34), changing the
 *   model list, the auth methods and the effort catalog between two spawns of
 *   one thread (observation 26). **Measured caveat:** `grok inspect --json`
 *   reports the overlay as `sections: features` only, so the CLI appears to
 *   honour `[cli]` at user scope alone — pinning the version is a deployment
 *   concern, not something this adapter can enforce. It is emitted anyway
 *   because it costs nothing and a later release may widen the overlay; the
 *   adapter's real defence is reading `agentVersion` on every handshake.
 *
 * **Deliberately NOT here: `[ui] permission_mode`.** The user's own config
 * may say `permission_mode = "always-approve"` (this host's does), so pinning
 * the mode per thread was the obvious move — and the overlay cannot carry it.
 * Verified against grok 1.0.34 (2026-09-22): the key is `[ui]
 * permission_mode`, its values `default` / `ask` / `auto` / `always-approve`
 * (the CLI's own config reference; `acceptEdits` is a `--permission-mode`
 * value, not a config one), but a `GROK_CONFIG_PATH` / `GROK_CONFIG` overlay
 * keeps only `models`, `features`, a narrowed `toolset` and
 * `shell_environment_policy` and drops every other table. `grok inspect
 * --json` reports an overlay of `[features]` + `[cli]` + `[ui]` as `sections:
 * features`, and one of `[ui]` + `[models]` as `sections: models`. A `[ui]`
 * line would pin nothing, so the mode rides argv instead ({@link
 * grokSpawnArgs}: every runtime mode names itself there) — the CLI-flag tier,
 * which the CLI documents as overriding config for that process.
 *
 * Nor is it written "for a later release" the way `[cli] auto_update` is.
 * Where argv is honoured it wins regardless — the config reference ranks CLI
 * flags layer 8 of 8, above a `GROK_CONFIG_PATH` overlay (layer 5) and the
 * user's `config.toml` (layer 3) — and an unsupported value in the overlay
 * (`acceptEdits`) risks the CLI rejecting the whole overlay, and
 * `support_permission` with it.
 *
 * **UNMEASURED: that argv beats this host's user-level `always-approve`.**
 * That precedence is the CLI's documentation, not an observation. Fixture
 * observation 6 saw `--permission-mode default … agent stdio` ask for an
 * edit, but the captures predate the last change to this host's
 * `config.toml`, and it found `agent stdio` honours that global flag for some
 * values only. Whether a Supervised thread here really gets its approval card
 * stays open until a live Supervised Grok chat is asked to write a file; if
 * it gets none, neither argv nor this overlay is the lever.
 *
 * **Why an overlay and not the account home.** The previous revision patched
 * `<accountHome>/config.toml`. On this host that path is a SYMLINK:
 *
 * ```
 * …/agent-accounts/grok/<id>/home/config.toml -> /var/lib/orquester/.grok/config.toml
 * ```
 *
 * so `writeFile` followed it and rewrote the daemon user's **global** Grok
 * configuration for every Grok process on the box, terminal tabs included
 * (R4 #4; the orchestrator restored the file). The host owns its appdir and
 * nothing else — so the settings now ride `GROK_CONFIG_PATH`, which the CLI
 * applies as an `env_overlay` layer ON TOP of whatever the user's own config
 * says, touching no shared file at all.
 */
export const GROK_MANAGED_CONFIG: ReadonlyArray<{ section: string; key: string; value: string }> = [
  { section: "features", key: "support_permission", value: "true" },
  { section: "cli", key: "auto_update", value: "false" }
];

/** The env var the CLI reads an additional config layer from. */
export const GROK_CONFIG_PATH_ENV = "GROK_CONFIG_PATH";

/** The overlay's contents. Fully host-owned, so it is rendered, not patched. */
export function renderGrokOverlayConfig(): string {
  const bySection = new Map<string, string[]>();
  for (const { section, key, value } of GROK_MANAGED_CONFIG) {
    const lines = bySection.get(section) ?? [];
    lines.push(`${key} = ${value}`);
    bySection.set(section, lines);
  }
  const blocks: string[] = [
    "# Written by Orquester for one agent-chat thread. Not the user's config:",
    "# it reaches the CLI through GROK_CONFIG_PATH as an overlay layer.",
    ""
  ];
  for (const [section, lines] of bySection) {
    blocks.push(`[${section}]`, ...lines, "");
  }
  return blocks.join("\n");
}

/**
 * What to tell the user when the overlay could not be written. Returned rather
 * than thrown: a missing setting degrades the approvals surface, it does not
 * stop the session.
 */
export function grokConfigAdvisory(): string {
  return "Grok will approve tool calls itself unless `[features] support_permission = true` reaches it; approval cards are disabled for this session.";
}

/**
 * Write the overlay into a host-owned directory and return its path, or `null`
 * when it could not be written.
 *
 * **Refuses to follow a symlink.** The whole reason this module changed is that
 * a path inside an account home turned out to be a link into the user's global
 * config; the guard makes that class of mistake impossible rather than merely
 * unlikely, even though the directory is now the host's own.
 */
export async function writeGrokOverlayConfig(dir: string): Promise<string | null> {
  const path = join(dir, "orquester-grok.toml");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    return null;
  }
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) {
      // Never write through a link: the target belongs to somebody else.
      return null;
    }
    if (!existing.isFile()) {
      return null;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return null;
    }
  }
  try {
    await writeFile(path, renderGrokOverlayConfig(), { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
