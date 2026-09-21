/**
 * Codex adapter — the provider snapshot probe (spec §4.1, §4.5 Codex "Probe",
 * §4.6.2, §4.6.3).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/CodexProvider.ts:325-487, 674-687`.
 *
 * One short-lived `codex app-server` serves models, auth, skills and usage.
 * **Probes never authenticate and never open a real session** (§4.1): the
 * whole sequence below is `initialize` + read-only reads, and `10-…` in the
 * fixtures proves it costs no tokens and starts no turn.
 *
 * `account/rateLimits/read` is an *enrichment*: a timeout or a failure degrades
 * to "no usage this probe" rather than costing the account and the model list.
 */

import type {
  ProviderAuth,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderSnapshot,
  ProviderUsageLimits,
  Skill,
  SlashCommand
} from "@orquester/api/agent-chat";

import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import type { CodexProtocol } from "./_generated/index.ts";
import { CODEX_ADAPTER_CAPABILITIES, CODEX_REF_IDS } from "./capabilities.ts";
import type { CodexPeer } from "./protocol.ts";
import { usageWindowsFromRateLimits } from "./usage.ts";

/**
 * Codex advertises exactly **two** slash commands and has no custom-prompt
 * catalogue: `~/.codex/prompts/*.md` is never enumerated by any RPC, and
 * `command.list` has no Codex equivalent (§4.6.2).
 *
 * `/compact` is the host-synthesised entry of §4.6.3 (compaction is a host
 * route), `/feedback` is Codex's own. `/effort` is NOT here — it is
 * client-only (see {@link codexSlashCommands}).
 *
 * *T3: `apps/server/src/provider/Layers/CodexProvider.ts:680-687` — the whole
 * Codex command catalog is these two hard-coded rows.*
 */
export const CODEX_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "compact", description: "Summarise the conversation to free context" },
  { name: "feedback", description: "Send feedback about Codex to OpenAI" }
] as const;

/**
 * The catalogue this adapter publishes (§4.6.3).
 *
 * **`/effort` is deliberately NOT here.** It is a CLIENT-ONLY affordance
 * (§4.6.5(a)): selecting it writes the `effort` option of the current
 * `ModelSelection` and inserts nothing into the draft. Synthesising a
 * *provider* `/effort` row put two entries in the menu, and picking the
 * provider one inserted the literal text `/effort ` and forwarded it to a CLI
 * that does not implement the command (R2 finding 2; fix-wave arbitration).
 * `/compact` is the only host entry that belongs in a provider catalog.
 */
export function codexSlashCommands(models: readonly ProviderModel[]): SlashCommand[] {
  void models;
  return [...CODEX_SLASH_COMMANDS];
}

/**
 * The menu's empty state when the catalogue is what it is. Orquester treats
 * Codex's missing command catalog as a **known gap** and says so, rather than
 * letting an empty list read as a failed probe (§4.6.2 "differs").
 *
 * Carried on the snapshot as `commandCatalogNote` so the composer can render
 * it; a constant nothing reads never reaches a user (R2 finding 9).
 */
export const CODEX_COMMAND_CATALOG_NOTE = "Codex reports no commands";

/**
 * The oldest `codex` this adapter speaks to. Below it the session is refused
 * with the required version in the message rather than started and allowed to
 * fail on the first unrecognised frame (§3.2, §10).
 *
 * The bindings are generated from 0.154.0, and `thread/turns/list` /
 * `thread/revert` — the only rollback path that works on a paginated thread —
 * were added after T3's pin, so anything that predates them cannot roll back.
 */
export const MINIMUM_CODEX_VERSION = "0.154.0";

export interface CodexProbeInput {
  peer: CodexPeer;
  /** The `initialize` response, already obtained by the handshake. */
  initialize: CodexProtocol.InitializeResponse;
  /** Scopes the per-cwd skills overlay (§4.6.4). */
  cwd?: string;
  nowIso: string;
  onWarning?: (message: string, detail?: unknown) => void;
}

/** Parse the version out of `initialize`'s `userAgent` — the ONLY source (§4.5). */
export function codexVersionFromUserAgent(userAgent: string): string | null {
  const match = /\/([^\s]+)/.exec(userAgent);
  return match?.[1] ?? null;
}

/**
 * Compare two dotted versions. Returns true when `version` is at least
 * `minimum`. An unreadable version is treated as **unsupported** wherever a
 * window exists (§10 "a CLI whose version cannot be read is treated as
 * unsupported").
 */
export function meetsMinimumVersion(version: string | null, minimum: string): boolean {
  if (version === null) {
    return false;
  }
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(version);
  const right = parse(minimum);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/**
 * Run the whole probe against an already-handshaken peer.
 *
 * Every read is individually bounded and individually recoverable: a failed
 * one shrinks the snapshot, it never fails it (§3.1 "Provider snapshots
 * refresh on a slow interval").
 */
export async function probeCodex(input: CodexProbeInput): Promise<ProviderSnapshot> {
  const { peer, initialize, cwd, nowIso } = input;
  const version = codexVersionFromUserAgent(initialize.userAgent);

  const account = await readOptional(
    () => peer.request("account/read", {}),
    AGENT_HOST_DEADLINES.authProbeMs,
    "account/read",
    input.onWarning
  );

  const auth = toProviderAuth(account);

  // Early return when unauthenticated: a logged-out CLI has no models, no
  // skills and no usage to report, and asking for them wastes a round trip
  // (§4.5). Login is never performed from the GUI — the flow is
  // `CODEX_HOME=… codex login` on the host.
  if (auth.status === "unauthenticated") {
    return {
      id: "codex",
      refIds: [...CODEX_REF_IDS],
      installed: true,
      version,
      status: "degraded",
      message: "Not signed in. Run `codex login` in a terminal for this account.",
      auth,
      checkedAt: nowIso,
      models: [],
      slashCommands: [...CODEX_SLASH_COMMANDS],
      commandCatalogNote: CODEX_COMMAND_CATALOG_NOTE,
      skills: [],
      capabilities: CODEX_ADAPTER_CAPABILITIES
    };
  }

  const [models, skills, usageLimits] = await Promise.all([
    readModels(peer, input.onWarning),
    readSkills(peer, cwd, input.onWarning),
    readUsage(peer, nowIso, input.onWarning)
  ]);

  const belowMinimum = !meetsMinimumVersion(version, MINIMUM_CODEX_VERSION);
  const slashCommands = codexSlashCommands(models);

  return {
    id: "codex",
    refIds: [...CODEX_REF_IDS],
    installed: true,
    version,
    status: belowMinimum ? "degraded" : "ready",
    ...(belowMinimum
      ? {
          message: `codex ${version ?? "(unknown version)"} is below the required ${MINIMUM_CODEX_VERSION}; chat sessions are refused until it is updated.`
        }
      : {}),
    auth,
    checkedAt: nowIso,
    models,
    slashCommands,
    commandCatalogNote: CODEX_COMMAND_CATALOG_NOTE,
    skills,
    // Only SKILLS are re-scoped per cwd for Codex; the command list is
    // machine-level (§4.6.4).
    ...(cwd !== undefined
      ? { workspaceSnapshots: [{ cwd, checkedAt: nowIso, slashCommands, skills }] }
      : {}),
    ...(usageLimits !== undefined ? { usageLimits } : {}),
    capabilities: CODEX_ADAPTER_CAPABILITIES
  };
}

/** The snapshot for a host where `codex` is not on PATH at all. */
export function uninstalledCodexSnapshot(nowIso: string, message?: string): ProviderSnapshot {
  return {
    id: "codex",
    refIds: [...CODEX_REF_IDS],
    installed: false,
    version: null,
    status: "error",
    ...(message !== undefined ? { message } : {}),
    auth: { status: "unknown" },
    checkedAt: nowIso,
    models: [],
    slashCommands: [],
    skills: [],
    capabilities: CODEX_ADAPTER_CAPABILITIES
  };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function toProviderAuth(account: CodexProtocol.v2.GetAccountResponse | undefined): ProviderAuth {
  if (account === undefined) {
    return { status: "unknown" };
  }
  if (account.account === null) {
    return { status: account.requiresOpenaiAuth ? "unauthenticated" : "unknown" };
  }
  switch (account.account.type) {
    case "chatgpt":
      return {
        status: "authenticated",
        type: "chatgpt",
        label: account.account.planType,
        ...(account.account.email !== null ? { email: account.account.email } : {})
      };
    case "apiKey":
      return { status: "authenticated", type: "apiKey", label: "API key" };
    case "amazonBedrock":
      return { status: "authenticated", type: "amazonBedrock", label: "Amazon Bedrock" };
    default: {
      const exhaustive: never = account.account;
      void exhaustive;
      return { status: "unknown" };
    }
  }
}

/** `model/list` is **paginated by `cursor`** (§4.5); follow it to the end. */
async function readModels(
  peer: CodexPeer,
  onWarning: CodexProbeInput["onWarning"]
): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  let cursor: string | null = null;
  // A guard against a server that never clears `nextCursor`.
  for (let page = 0; page < 20; page += 1) {
    const response: CodexProtocol.v2.ModelListResponse | undefined = await readOptional(
      () => peer.request("model/list", cursor === null ? {} : { cursor }),
      AGENT_HOST_DEADLINES.probeMs,
      "model/list",
      onWarning
    );
    if (response === undefined) {
      break;
    }
    for (const model of response.data) {
      if (model.hidden) {
        continue;
      }
      models.push(toProviderModel(model));
    }
    cursor = response.nextCursor;
    if (cursor === null) {
      break;
    }
  }
  return models;
}

function toProviderModel(model: CodexProtocol.v2.Model): ProviderModel {
  const descriptors: ProviderOptionDescriptor[] = [];

  if (model.supportedReasoningEfforts.length > 0) {
    descriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      // Codex `effort` is a plain non-empty STRING on the wire, not an enum
      // (§4.1) — the option ids are whatever the server reports, including
      // `xhigh`, `max` and `ultra`.
      options: model.supportedReasoningEfforts.map((option) => ({
        id: option.reasoningEffort,
        label: titleCase(option.reasoningEffort),
        description: option.description,
        ...(option.reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {})
      })),
      currentValue: model.defaultReasoningEffort
    });
  }

  if (model.serviceTiers.length > 0) {
    descriptors.push({
      id: "serviceTier",
      label: "Speed",
      type: "select",
      options: model.serviceTiers.map((tier) => ({
        id: tier.id,
        label: tier.name,
        description: tier.description,
        ...(tier.id === model.defaultServiceTier ? { isDefault: true } : {})
      })),
      ...(model.defaultServiceTier !== null ? { currentValue: model.defaultServiceTier } : {})
    });
  }

  return {
    slug: model.model,
    name: model.displayName,
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(model.upgrade !== null ? { isLegacy: true } : {}),
    capabilities: descriptors.length > 0 ? { optionDescriptors: descriptors } : null
  };
}

/** Skills come from `skills/list {cwds:[cwd]}` (§4.6.2). */
async function readSkills(
  peer: CodexPeer,
  cwd: string | undefined,
  onWarning: CodexProbeInput["onWarning"]
): Promise<Skill[]> {
  const response = await readOptional(
    () => peer.request("skills/list", cwd === undefined ? {} : { cwds: [cwd] }),
    AGENT_HOST_DEADLINES.probeMs,
    "skills/list",
    onWarning
  );
  if (response === undefined) {
    return [];
  }
  // Prefer the entry for the cwd we ASKED about; only fall back to flattening
  // every entry. With `cwds:[cwd]` there is normally exactly one, so this is
  // latent — but a server that answers for more than it was asked would
  // otherwise let another directory's skills win the dedupe (R2 finding 10).
  const entries =
    cwd !== undefined
      ? (response.data.filter((entry) => entry.cwd === cwd) ?? [])
      : [];
  const source = entries.length > 0 ? entries : response.data;

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const entry of source) {
    for (const skill of entry.skills) {
      if (seen.has(skill.name)) {
        continue;
      }
      seen.add(skill.name);
      // `shortDescription` is the legacy SKILL.md field; SKILL.json puts it
      // under `interface`. T3 reads both, in that order.
      const shortDescription = skill.shortDescription ?? skill.interface?.shortDescription;
      skills.push({
        name: skill.name,
        path: skill.path,
        enabled: skill.enabled,
        description: skill.description,
        ...(shortDescription !== undefined ? { shortDescription } : {}),
        ...(skill.interface?.displayName !== undefined
          ? { displayName: skill.interface.displayName }
          : {}),
        scope: mapSkillScope(skill.scope)
      });
    }
  }
  return skills;
}

/** Codex's scopes are `user|repo|system|admin`; §4.6.1's are `user|project|plugin|bundled`. */
function mapSkillScope(scope: CodexProtocol.v2.SkillScope): Skill["scope"] {
  switch (scope) {
    case "user":
      return "user";
    case "repo":
      return "project";
    case "system":
    case "admin":
      return "bundled";
    default: {
      const exhaustive: never = scope;
      return exhaustive;
    }
  }
}

/**
 * Usage is an **enrichment** (§4.5): a failure here degrades to "no usage this
 * probe" — `probeFailed` keeps the last good bars — rather than costing the
 * account and model list.
 */
async function readUsage(
  peer: CodexPeer,
  nowIso: string,
  onWarning: CodexProbeInput["onWarning"]
): Promise<ProviderUsageLimits | undefined> {
  const response = await readOptional(
    () => peer.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
    AGENT_HOST_DEADLINES.probeMs,
    "account/rateLimits/read",
    onWarning
  );
  if (response === undefined) {
    return { checkedAt: nowIso, windows: [], unavailable: { reason: "probeFailed" } };
  }
  const windows = usageWindowsFromRateLimits(response.rateLimits);
  if (windows.length === 0) {
    // An API-key account has no subscription window: `unsupported` CLEARS the
    // bars rather than keeping stale ones (§4.1).
    return { checkedAt: nowIso, windows: [], unavailable: { reason: "unsupported" } };
  }
  return { checkedAt: nowIso, windows };
}

async function readOptional<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  label: string,
  onWarning: CodexProbeInput["onWarning"]
): Promise<T | undefined> {
  try {
    return await withDeadline(work, { label: `codex ${label}`, timeoutMs });
  } catch (error) {
    onWarning?.(`codex probe: ${label} failed`, error instanceof Error ? error.message : error);
    return undefined;
  }
}

function titleCase(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value[0]!.toUpperCase() + value.slice(1);
}
