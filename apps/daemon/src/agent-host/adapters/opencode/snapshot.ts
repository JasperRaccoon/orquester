/**
 * Agent host — the OpenCode provider snapshot (spec §4.1, §4.6.1–§4.6.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/OpenCodeProvider.ts`
 * (`flattenOpenCodeModels`, `openCodeCapabilitiesForModel`, the auth
 * inference and the command/skill mapping).
 *
 * **Models and auth come from the same call** (§4.1 "one call, not two"):
 * `GET /provider` returns `{all, default, connected}`, login state is
 * `connected.length > 0` — there is no `opencode auth list` — and the slug is
 * `"${provider.id}/${model.id}"`.
 *
 * Two reality corrections from the captures:
 * - **`model.variants` is an object whose values name the effort** the variant
 *   maps to, so the "Reasoning" select is built from real data, and `minimal`
 *   exists on newer models and is absent from T3's synthesised list
 *   (fixtures README observation 22).
 * - **The catalogue is enormous** — 4.3 MB for `/provider`, 242 KB `/command`,
 *   230 KB `/skill` on this host — which is why §3.2's "refresh on a slow
 *   interval, serialised, never per request" is a hard requirement and not a
 *   nicety. `GET /config` and `/config/providers` carry live credentials and
 *   are deliberately never read here.
 */

import type {
  AdapterCapabilities,
  ProviderAuth,
  ProviderModel,
  ProviderOptionDescriptor,
  ProviderSnapshot,
  Skill,
  SlashCommand,
  WorkspaceSnapshot
} from "@orquester/api/agent-chat";

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import type { OpenCodeClient } from "./http.ts";
import {
  openCodeRoutes,
  type OpenCodeAgentRow,
  type OpenCodeCommandRow,
  type OpenCodeModelRow,
  type OpenCodeSkillRow,
  type ProviderListResponse
} from "./routes.ts";
import { MINIMUM_OPENCODE_VERSION, tooOldMessage } from "./semver.ts";

/** Registry ids this adapter serves. */
export const OPENCODE_REF_IDS: readonly string[] = ["opencode"];

/** §4.1: OpenCode reports no context window, has no plan-mode toggle. */
export const OPENCODE_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  supportsConversationRollback: true,
  showPlanModeToggle: false,
  reportsContextWindow: false,
  compaction: { type: "native" }
};

/**
 * §4.6.3: the host features with no CLI equivalent on this surface.
 *
 * `/compact` only. **`/effort` is CLIENT-ONLY** (§4.6.5(a)) — the composer
 * owns that row and gates it on the selected model actually exposing a
 * reasoning descriptor. Synthesising it here too produced a *second*,
 * provider-flavoured `/effort` in the menu whose selection inserted the literal
 * text `/effort ` and forwarded it to a CLI that does not implement it; it also
 * advertised the command on a not-installed or too-old snapshot, which carries
 * no models and therefore no descriptor at all.
 */
export const SYNTHESISED_COMMANDS: readonly SlashCommand[] = [
  { name: "compact", description: "Compact this conversation's context" }
];

export interface OpenCodeInventory {
  providers: ProviderListResponse;
  agents: OpenCodeAgentRow[];
  commands: OpenCodeCommandRow[];
  skills: OpenCodeSkillRow[];
}

/**
 * Four reads off one server. Sequential rather than concurrent: T3's CLI
 * fallback had to serialise because concurrent runs hit the same SQLite file
 * and failed "database is locked", and on the HTTP path serialising also keeps
 * ~5 MB of catalogue from landing in one heap spike (observation 22).
 */
export async function loadOpenCodeInventory(client: OpenCodeClient): Promise<OpenCodeInventory> {
  const providers = await client
    .get<ProviderListResponse>(openCodeRoutes.providers, {
      timeoutMs: AGENT_HOST_DEADLINES.authProbeMs
    })
    .catch((): ProviderListResponse => ({ all: [], connected: [] }));
  const agents = await client
    .get<OpenCodeAgentRow[]>(openCodeRoutes.agents, { timeoutMs: AGENT_HOST_DEADLINES.probeMs })
    .catch(() => [] as OpenCodeAgentRow[]);
  const commands = await client
    .get<OpenCodeCommandRow[]>(openCodeRoutes.commands, { timeoutMs: AGENT_HOST_DEADLINES.probeMs })
    .catch(() => [] as OpenCodeCommandRow[]);
  const skills = await client
    .get<OpenCodeSkillRow[]>(openCodeRoutes.skills, { timeoutMs: AGENT_HOST_DEADLINES.probeMs })
    .catch(() => [] as OpenCodeSkillRow[]);
  return {
    providers: {
      all: Array.isArray(providers?.all) ? providers.all : [],
      connected: Array.isArray(providers?.connected) ? providers.connected : [],
      ...(providers?.default !== undefined ? { default: providers.default } : {})
    },
    agents: Array.isArray(agents) ? agents : [],
    commands: Array.isArray(commands) ? commands : [],
    skills: Array.isArray(skills) ? skills : []
  };
}

function titleCaseSlug(value: string): string {
  const segments: string[] = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

/** *T3: `OpenCodeProvider.ts:155-168`.* */
export function inferDefaultVariant(
  providerID: string,
  variants: readonly string[]
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

export function primaryAgents(agents: readonly OpenCodeAgentRow[]): OpenCodeAgentRow[] {
  return agents.filter(
    (agent) => agent.hidden !== true && (agent.mode === "primary" || agent.mode === "all")
  );
}

function inferDefaultAgent(agents: readonly OpenCodeAgentRow[]): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name;
}

/**
 * Effort for OpenCode is the **`variant` field**, not a reasoning parameter: a
 * select labelled "Reasoning" passed as `variant` on both submit paths. **No
 * `reasoningEffort`/`thinking` field is ever sent** (§4.5). A second select
 * exposes the primary `agent` list.
 */
export function openCodeCapabilitiesForModel(input: {
  providerID: string;
  model: OpenCodeModelRow;
  agents: readonly OpenCodeAgentRow[];
}): { optionDescriptors: ProviderOptionDescriptor[] } {
  const declared = Object.keys(input.model.variants ?? {});
  // A model that advertises no variants still gets a Reasoning selector, so
  // the composer behaves the same everywhere. `minimal` is deliberately NOT in
  // the synthesised set: it only exists where the model declares it.
  const variantValues = declared.length > 0 ? declared : ["low", "medium", "high", "xhigh"];
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions = variantValues.map((value) => {
    const effort = input.model.variants?.[value]?.reasoning?.effort;
    return {
      id: value,
      label: titleCaseSlug(value),
      ...(effort !== undefined && effort !== value
        ? { description: `Reasoning effort: ${effort}` }
        : {}),
      ...(defaultVariant === value ? { isDefault: true as const } : {})
    };
  });

  const agents = primaryAgents(input.agents);
  const defaultAgent = inferDefaultAgent(agents);
  const agentOptions = agents.map((agent) => ({
    id: agent.name,
    label: titleCaseSlug(agent.name),
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    ...(defaultAgent === agent.name ? { isDefault: true as const } : {})
  }));

  const optionDescriptors: ProviderOptionDescriptor[] = [];
  if (variantOptions.length > 0) {
    optionDescriptors.push({
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: variantOptions,
      ...(defaultVariant !== undefined ? { currentValue: defaultVariant } : {})
    });
  }
  if (agentOptions.length > 0) {
    optionDescriptors.push({
      id: "agent",
      label: "Agent",
      type: "select",
      options: agentOptions,
      ...(defaultAgent !== undefined ? { currentValue: defaultAgent } : {})
    });
  }
  return { optionDescriptors };
}

/** Providers not in `connected` are skipped: they cannot serve a turn. */
export function flattenOpenCodeModels(inventory: OpenCodeInventory): ProviderModel[] {
  const connected = new Set(inventory.providers.connected);
  const defaults = inventory.providers.default ?? {};
  const models: ProviderModel[] = [];
  for (const provider of inventory.providers.all) {
    if (!connected.has(provider.id)) {
      continue;
    }
    for (const model of Object.values(provider.models ?? {})) {
      if (model === undefined || typeof model.id !== "string") {
        continue;
      }
      const name = model.name?.trim();
      if (name === undefined || name.length === 0) {
        continue;
      }
      const subProvider = provider.name?.trim();
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider !== undefined && subProvider.length > 0 ? { subProvider } : {}),
        ...(defaults[provider.id] === model.id ? { isDefault: true } : {}),
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: inventory.agents
        })
      });
    }
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Commands whose `source` is `skill` are dropped — they reappear as skills and
 * §4.6.7 removes the duplicate. `hints` was present on every row in 1.18.5 but
 * is guarded anyway: it is one optional field away from throwing.
 */
export function toSlashCommands(rows: readonly OpenCodeCommandRow[]): SlashCommand[] {
  const commands: SlashCommand[] = [...SYNTHESISED_COMMANDS];
  const names = new Set(commands.map((command) => command.name));
  for (const row of rows) {
    const name = row.name?.trim();
    if (name === undefined || name.length === 0 || names.has(name) || row.source === "skill") {
      continue;
    }
    names.add(name);
    const description = row.description?.trim();
    const hint = (Array.isArray(row.hints) ? row.hints : []).join(" ").trim();
    commands.push({
      name,
      ...(description !== undefined && description.length > 0 ? { description } : {}),
      ...(hint.length > 0 ? { input: { hint } } : {})
    });
  }
  return commands;
}

export function toSkills(rows: readonly OpenCodeSkillRow[]): Skill[] {
  const skills: Skill[] = [];
  for (const row of rows) {
    const name = row.name?.trim();
    const path = row.location?.trim();
    if (name === undefined || name.length === 0 || path === undefined || path.length === 0) {
      continue;
    }
    const description = row.description?.trim();
    skills.push({
      name,
      path,
      enabled: true,
      ...(description !== undefined && description.length > 0
        ? { description, shortDescription: description }
        : {})
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export function inferAuth(inventory: OpenCodeInventory): ProviderAuth {
  const count = inventory.providers.connected.length;
  return count > 0
    ? { status: "authenticated", type: "opencode", label: `${count} connected` }
    : { status: "unknown", type: "opencode" };
}

export function describeInventory(inventory: OpenCodeInventory): string {
  const count = inventory.providers.connected.length;
  return count > 0
    ? `${count} upstream provider${count === 1 ? "" : "s"} connected through OpenCode.`
    : "OpenCode is available, but it did not report any connected upstream providers.";
}

/**
 * The snapshot for a CLI that is present but below the §4.1 minimum, or one
 * that could not be probed at all. **Version gates refuse rather than
 * degrade** (§10): the required version is in the message.
 */
export function unusableSnapshot(input: {
  installed: boolean;
  version: string | null;
  checkedAt: string;
  message?: string;
  status?: ProviderSnapshot["status"];
}): ProviderSnapshot {
  return {
    id: "opencode",
    refIds: [...OPENCODE_REF_IDS],
    installed: input.installed,
    version: input.version,
    status: input.status ?? (input.installed ? "error" : "unknown"),
    message:
      input.message ??
      (input.installed
        ? tooOldMessage(input.version)
        : `OpenCode is not installed. Orquester requires v${MINIMUM_OPENCODE_VERSION} or newer.`),
    auth: { status: "unknown" },
    checkedAt: input.checkedAt,
    models: [],
    slashCommands: [...SYNTHESISED_COMMANDS],
    skills: [],
    capabilities: OPENCODE_CAPABILITIES
  };
}

export function buildSnapshot(input: {
  version: string;
  checkedAt: string;
  inventory: OpenCodeInventory;
  workspaceSnapshots?: WorkspaceSnapshot[];
}): ProviderSnapshot {
  const connected = input.inventory.providers.connected.length;
  return {
    id: "opencode",
    refIds: [...OPENCODE_REF_IDS],
    installed: true,
    version: input.version,
    status: connected > 0 ? "ready" : "degraded",
    message: describeInventory(input.inventory),
    auth: inferAuth(input.inventory),
    checkedAt: input.checkedAt,
    models: flattenOpenCodeModels(input.inventory),
    slashCommands: toSlashCommands(input.inventory.commands),
    skills: toSkills(input.inventory.skills),
    ...(input.workspaceSnapshots !== undefined && input.workspaceSnapshots.length > 0
      ? { workspaceSnapshots: input.workspaceSnapshots }
      : {}),
    capabilities: OPENCODE_CAPABILITIES
  };
}

/**
 * §4.6.4: a probe that comes back **empty never blanks** a non-empty cached
 * list. Applied to both arrays, for the machine snapshot and every workspace
 * overlay.
 */
export function keepNonEmpty<T>(next: readonly T[], previous: readonly T[] | undefined): T[] {
  if (next.length > 0 || previous === undefined) {
    return [...next];
  }
  return [...previous];
}

/** At most 16 cwds are retained per provider, oldest evicted (§4.6.4). */
export const MAX_WORKSPACE_SNAPSHOTS = 16;

export function retainWorkspaceSnapshots(
  snapshots: Map<string, WorkspaceSnapshot>
): WorkspaceSnapshot[] {
  const entries = [...snapshots.entries()];
  while (entries.length > MAX_WORKSPACE_SNAPSHOTS) {
    const oldest = entries.shift();
    if (oldest !== undefined) {
      snapshots.delete(oldest[0]);
    }
  }
  return entries.map(([, snapshot]) => snapshot);
}
