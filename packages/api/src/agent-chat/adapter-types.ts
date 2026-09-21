/**
 * Agent chat — the adapter-facing contracts (spec §4.1, §4.3, §4.4, §4.6).
 *
 * Ported from T3 Code (MIT): `packages/contracts/src/provider.ts`,
 * `packages/contracts/src/model.ts`, `packages/contracts/src/server.ts`,
 * `apps/server/src/provider/Services/ProviderAdapter.ts`.
 *
 * NOTE on `RuntimeMode`: `@orquester/api` already exports a `RuntimeMode`
 * meaning the *client platform* ("desktop-local" | …). T3's `RuntimeMode` is
 * the *permission* mode, and this design uses T3's name. Both live here: the
 * root barrel `@orquester/api` re-exports this one as **`AgentRuntimeMode`**
 * (the platform type keeps the bare name there); importing from
 * `@orquester/api/agent-chat` gives you T3's spelling.
 */

import type { ProviderUsageLimits } from "./runtime-events.ts";

/** The four adapters of v1 (§3.2). claudex/claudemix are `claude` + proxy env. */
export type AgentAdapterId = "claude" | "codex" | "opencode" | "grok";

// ---------------------------------------------------------------------------
// Modes (§4.4)
// ---------------------------------------------------------------------------

/**
 * Permission mode, expressed as launch configuration by every provider — which
 * is why changing it restarts the session (§3.4).
 *
 * *T3: `packages/contracts/src/orchestration.ts:128-134`; differs: T3's
 * `DEFAULT_RUNTIME_MODE` is `full-access`, Orquester defaults to
 * `approval-required`.*
 */
export type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

/** Alias under which the root `@orquester/api` barrel exports {@link RuntimeMode}. */
export type AgentRuntimeMode = RuntimeMode;

export const RUNTIME_MODES: readonly RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access"
] as const;

/** §4.4. */
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required";

/**
 * Plan mode is a PER-TURN field and never restarts anything (§3.4). It is
 * client-local per thread (§6.2) and re-sent with every `/turn`.
 *
 * *T3: `orchestration.ts:136-138` (`ProviderInteractionMode`).*
 */
export type InteractionMode = "default" | "plan";

export const DEFAULT_INTERACTION_MODE: InteractionMode = "default";

// ---------------------------------------------------------------------------
// Model selection (§4.1)
// ---------------------------------------------------------------------------

/** *T3: `packages/contracts/src/model.ts:10-15`.* */
export interface ProviderOptionChoice {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** *T3: `model.ts:24-30`.* */
export interface SelectProviderOptionDescriptor {
  id: string;
  label: string;
  description?: string;
  type: "select";
  options: ProviderOptionChoice[];
  currentValue?: string;
}

/** *T3: `model.ts:33-37`.* */
export interface BooleanProviderOptionDescriptor {
  id: string;
  label: string;
  description?: string;
  type: "boolean";
  currentValue?: boolean;
}

/**
 * The model-selection options schema (§4.1). Descriptor ids in use: Claude
 * `effort`, `thinking`, `fastMode`; Codex `effort` (a plain string, not an
 * enum) and `serviceTier`; OpenCode `variant` (labelled "Reasoning") and
 * `agent`; Grok `reasoningEffort`, carried as ACP `_meta`.
 */
export type ProviderOptionDescriptor =
  | SelectProviderOptionDescriptor
  | BooleanProviderOptionDescriptor;

export type ProviderOptionSelectionValue = string | boolean;

/** *T3: `model.ts:49-52`.* */
export interface ProviderOptionSelection {
  id: string;
  value: ProviderOptionSelectionValue;
}

/** *T3: `model.ts:125-127` (`ModelCapabilities`).* */
export interface ModelCapabilities {
  optionDescriptors?: ProviderOptionDescriptor[];
}

/**
 * What a thread is pinned to (§4.1). A **deep-equality** change of this whole
 * object restarts a Claude session (§3.4); the other three apply it live.
 *
 * `instanceId` is the routing key — in Orquester the registry `refId` plus the
 * account that owns the session. It is optional so a bare model slug still
 * decodes.
 *
 * *T3: `orchestration.ts:93-126` (`ModelSelection`).*
 */
export interface ModelSelection {
  instanceId?: string;
  model: string;
  options?: ProviderOptionSelection[];
}

// ---------------------------------------------------------------------------
// Attachments (§4.1 input bounds — stated once, referenced everywhere)
// ---------------------------------------------------------------------------

/** `input` is one flat string, trimmed, ≤ this many characters. */
export const MAX_TURN_INPUT_CHARS = 120_000;
/** At most this many attachments per turn, and per question (§4.3). */
export const MAX_TURN_ATTACHMENTS = 8;
/** Images must match `^image/` and be ≤ 10 MiB. */
export const MAX_TURN_IMAGE_BYTES = 10 * 1024 * 1024;
/** Files ≤ 50 MiB. */
export const MAX_TURN_FILE_BYTES = 50 * 1024 * 1024;

/** gif/jpeg/png/webp only (§4.1). */
export const SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
] as const;

export type SupportedAttachmentImageMimeType =
  (typeof SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES)[number];

/**
 * References only — never bytes and never a data URL (§6.3). Resolved by the
 * host against the thread's `attachments/` dir. The third arm is a deliberate
 * forward-compat catch-all so a newer producer cannot break an older decoder.
 *
 * *T3: `orchestration.ts:302-372` (`ChatAttachment`).*
 */
export type AttachmentRef =
  | { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number }
  | { type: "file"; id: string; name: string; mimeType?: string; sizeBytes: number }
  | { type: "unknown"; id: string; name: string; mimeType?: string; sizeBytes?: number };

/**
 * The composer-chip record set persisted beside a user message for re-render
 * only (§4.1). `@file` references are flattened into `input`; this binds
 * attachments by id and never holds bytes.
 */
export interface ComposerContextRecord {
  kind: "file" | "attachment" | "selection" | "element" | string;
  label: string;
  /** Absolute path for a file chip; attachment id for an attachment chip. */
  ref?: string;
}

// ---------------------------------------------------------------------------
// Account homes (§3.1, §5.1, §5.2)
// ---------------------------------------------------------------------------

/**
 * Which home dir a thread's provider child runs under. Mirrors
 * `AgentConversationHome` in the existing resume picker (§5.3).
 */
export type AccountHomeKind = "system" | "account" | "cliproxy";

/**
 * Resolved account home handed to `startSession` (§4.1).
 *
 * Ambiguity resolved here: §5.2's persisted `chat.home` field is only the
 * {@link AccountHomeKind}; the adapter additionally needs the absolute dir, so
 * `path` lives on this runtime shape and is **host-side only** — it is never
 * put on the wire (a host path is not a client concern, and §3.1 requires the
 * value to be already absolute because nothing expands `~` for a child).
 */
export interface AccountHome {
  kind: AccountHomeKind;
  /** Managed agent-account id — set only when `kind` is `"account"`. */
  accountId?: string;
  /** Launcher registry id owning the proxy home — only when `kind` is `"cliproxy"`. */
  proxyRefId?: string;
  /** Absolute path of the home dir. Host-side only. */
  path: string;
}

// ---------------------------------------------------------------------------
// Sessions (§4.1)
// ---------------------------------------------------------------------------

/**
 * The five states `session.state.changed` carries. `idle` exists only on the
 * thread head (§5.1), for a thread that has no session yet.
 */
export type ProviderSessionStatus = "starting" | "ready" | "running" | "stopped" | "error";

/**
 * The whole session record `startSession` returns — not just a cursor (§4.1).
 *
 * *T3: `packages/contracts/src/provider.ts:35-51`.*
 */
export interface ProviderSession {
  threadId: string;
  status: ProviderSessionStatus;
  runtimeMode: RuntimeMode;
  cwd?: string;
  model?: string;
  /**
   * Adapter-owned resume blob — `unknown` by contract, and the only thing
   * persisted for resume. Codex `{threadId}`; OpenCode and Grok
   * `{schemaVersion: 1, sessionId}`; Claude `{threadId, resume, resumeSessionAt,
   * turnCount, turnStartMessageIds[]}`. A cursor that fails its own shape check
   * means "no resume", never an error.
   */
  resumeCursor?: unknown;
  activeTurnId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

/** *T3: `ProviderAdapter.ts:57-60`.* */
export interface ProviderThreadTurnSnapshot {
  id: string;
  /** Opaque provider items. */
  items: unknown[];
}

/**
 * Used to reconcile after a restart without replaying a transcript into the
 * provider (§4.1).
 *
 * *T3: `ProviderAdapter.ts:62-65` (`ProviderThreadSnapshot`).*
 * Not to be confused with {@link import("./thread.ts").ThreadSnapshotPayload},
 * the §6.3 read.
 */
export interface ThreadSnapshot {
  threadId: string;
  turns: ProviderThreadTurnSnapshot[];
}

// ---------------------------------------------------------------------------
// Capabilities (§4.1)
// ---------------------------------------------------------------------------

/**
 * How the host runs manual context compaction for an adapter (§4.1). Native
 * adapters (Codex, OpenCode) expose a start call and must emit a compacted
 * thread state when they finish; slash-command adapters (Claude, Grok) get the
 * command sent as an ordinary turn.
 *
 * *T3: `ProviderAdapter.ts:35-43`.*
 */
export type ProviderCompaction =
  | { type: "native" }
  | { type: "slash-command"; command: `/${string}` };

/**
 * §4.1. Two of these are presentation flags in T3
 * (`packages/contracts/src/server.ts:199-201`); Orquester folds both onto the
 * adapter's capabilities, since one adapter serves one provider.
 */
export interface AdapterCapabilities {
  sessionModelSwitch: "in-session" | "unsupported";
  /** Codex. Starts a resumed turn with no synthetic user prompt (§3.3). */
  promptlessTurnContinuation?: boolean;
  /** Absent means true; Grok is false (§5.5 step 2 refuses before any write). */
  supportsConversationRollback?: boolean;
  /** Claude, Codex true; OpenCode, Grok false. Gates the composer chip (§7.4). */
  showPlanModeToggle: boolean;
  /**
   * Claude, Codex true; OpenCode, Grok false. Lets the status line reserve the
   * meter's space before the first `thread.token-usage.updated` (§7.6).
   */
  reportsContextWindow: boolean;
  compaction: ProviderCompaction;
}

// ---------------------------------------------------------------------------
// Provider snapshot (§4.1, §4.6.1, §6.3)
// ---------------------------------------------------------------------------

/** Never a credential (§6.3). *T3: `server.ts:61-66`.* */
export interface ProviderAuth {
  status: "authenticated" | "unauthenticated" | "unknown";
  type?: string;
  label?: string;
  email?: string;
}

/** *T3: `server.ts:69-80` (`ServerProviderModel`).* */
export interface ProviderModel {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  isDefault?: boolean;
  isLegacy?: boolean;
  capabilities: ModelCapabilities | null;
}

/** `input.hint` is the only argument metadata that exists (§4.6.1). */
export interface SlashCommand {
  name: string;
  description?: string;
  input?: { hint: string };
}

/**
 * §4.6.1 / §4.6.8. The last two flags are inverse:
 * `userInvocationOnly` means the composer MUST offer it under `/` (the agent
 * cannot start it); `userInvocable: false` means it must NOT.
 */
export interface Skill {
  name: string;
  path: string;
  enabled: boolean;
  description?: string;
  shortDescription?: string;
  displayName?: string;
  scope?: "user" | "project" | "plugin" | "bundled" | (string & {});
  userInvocationOnly?: boolean;
  userInvocable?: boolean;
}

/**
 * Per-cwd overlay of the machine-level catalog (§4.6.4). A cwd is probed once,
 * at most 16 are retained per provider, and a probe that comes back empty
 * never blanks a non-empty cached list.
 */
export interface WorkspaceSnapshot {
  cwd: string;
  checkedAt: string;
  slashCommands: SlashCommand[];
  skills: Skill[];
}

/** *T3: `server.ts:158-166`.* */
export interface ProviderVersionAdvisory {
  status: "unknown" | "current" | "behind_latest";
  currentVersion: string | null;
  latestVersion: string | null;
  updateCommand: string | null;
  canUpdate: boolean;
  checkedAt: string | null;
  message: string | null;
}

/**
 * One adapter's snapshot, produced by one `refresh()` call — never two (§4.1).
 * Probes never authenticate and never open a real session (§6.3).
 *
 * *T3: `packages/contracts/src/server.ts:188-239` (`ServerProvider`).*
 */
export interface ProviderSnapshot {
  /** Adapter id. */
  id: AgentAdapterId;
  /** Registry ids served by this adapter (claude ← claude/claudex/claudemix). */
  refIds: string[];
  installed: boolean;
  version: string | null;
  status: "ready" | "degraded" | "error" | "unknown";
  message?: string;
  auth: ProviderAuth;
  checkedAt: string;
  models: ProviderModel[];
  slashCommands: SlashCommand[];
  /**
   * Per-provider empty-state copy for the `/` menu, when an empty
   * `slashCommands` is a **known gap** rather than a failed probe — Codex has
   * no command-catalog RPC at all (§4.6.2 "differs": *"rather than letting an
   * empty list read as a failed probe"*). Absent means the generic empty state.
   *
   * *Added in the fix wave for R2 finding 9; W13 renders it.*
   */
  commandCatalogNote?: string;
  skills: Skill[];
  workspaceSnapshots?: WorkspaceSnapshot[];
  /** Absent when the adapter has no notion of subscription usage. */
  usageLimits?: ProviderUsageLimits;
  versionAdvisory?: ProviderVersionAdvisory;
  /**
   * The client cannot render without this: `showPlanModeToggle` gates the
   * composer chip, `supportsConversationRollback` decides whether "rewind to
   * here" is offered at all, and `reportsContextWindow` reserves the meter's
   * space (§6.3).
   */
  capabilities: AdapterCapabilities;
}
