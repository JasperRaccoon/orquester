import { proxyLaunchModels, type AgentAccountsResponse, type AgentConversationSummary, type CliProxyStatus, type RegistryEntry, type RegistryResponse } from "@orquester/api";
import { agentChatRoutes, DEFAULT_RUNTIME_MODE, RUNTIME_MODES, type AdapterCapabilities, type AgentAdapterId, type ModelSelection, type ProviderModel, type RuntimeMode } from "@orquester/api/agent-chat";
import { proxyAccountFamily } from "../agent-chat/service.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { clipText, MAX_ECHO_CHARS, resultBytes } from "./result.ts";

export const EFFORT_OPTION_IDS: Record<AgentAdapterId, string> = { claude: "effort", codex: "effort", opencode: "variant", grok: "reasoningEffort" };
export interface AgentModelOptionView { id: string; label: string; type: "select" | "boolean"; description?: string; values?: { id: string; label: string; description?: string; isDefault?: boolean }[] }
export interface AgentModelView { slug: string; name: string; shortName?: string; isDefault: boolean; isLegacy?: boolean; providerLabel?: string; options: AgentModelOptionView[] }
export interface AgentAccountView { id: string; label: string; email: string | null; plan: string | null; needsReauth: boolean; isDefault: boolean }
/** `disabledReason` is the registry's own (e.g. "proxy down"), present only on a disabled agent the daemon knows the reason for. */
export interface AgentView { id: string; name: string; adapter: AgentAdapterId; enabled: boolean; disabledReason?: string; installed: boolean; version: string | null; status: string; message?: string; auth: { status: string; label?: string; email?: string };
  models: AgentModelView[]; effortOptionId: string; runtimeModes: readonly RuntimeMode[]; defaultRuntimeMode: RuntimeMode; supports: { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean; contextWindow: boolean }; accounts: AgentAccountView[]; defaultAccountId: string }

export function isProxyAgent(refId: string): boolean {
  return proxyAccountFamily(refId) !== null;
}

/**
 * The one proxy launcher whose launch names a model the proxy serves: claudex (the "+" menu's model chips). claudemix
 * is the Claude main loop through the proxy — it offers the Claude catalogue and a launch never names a proxy model
 * for it (`cliproxy.ts` `validateModel`: "the UI never sends a model for claudemix").
 */
export function launchesProxyModel(refId: string): boolean {
  return refId === "claudex";
}

/**
 * The agent a past conversation resumes with — the GUI's `chatLaunchRefId`: a proxy home's transcript belongs to the
 * launcher that owns that home (`proxyRefId`), any other row to the CLI that wrote it. `reachable` is false for a proxy
 * home that names no launcher: no agent can resume it, since plain `claude` reads another HOME. The one predicate
 * behind list_conversations' `resumable` and create_session's resume refusal.
 */
export function conversationLaunch(row: Pick<AgentConversationSummary, "agentRefId" | "home" | "proxyRefId">): { agent: string; reachable: boolean } {
  if (row.home !== "cliproxy") return { agent: row.agentRefId, reachable: true };
  return row.proxyRefId ? { agent: row.proxyRefId, reachable: true } : { agent: row.agentRefId, reachable: false };
}

/**
 * The capability flags list_agents and get_session both report. No snapshot, or an absent flag, reads false — and so
 * does a mistyped one (an older host's row): a flag counts only when it is really `true`.
 */
export function supportsFrom(caps: AdapterCapabilities | undefined): { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean } {
  return { planMode: caps?.showPlanModeToggle === true, rollback: caps?.supportsConversationRollback === true, compaction: isRecord(caps?.compaction), backgroundTasks: caps?.supportsBackgroundTasks === true };
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** One model option as list_agents shows it; null for one nobody could set — no id or label, or a select with no choice (no adapter emits one). */
function optionView(d: unknown): AgentModelOptionView | null {
  if (!isRecord(d) || !nonEmpty(d.id) || typeof d.label !== "string" || (d.type !== "select" && d.type !== "boolean")) return null;
  const o: AgentModelOptionView = { id: d.id, label: d.label, type: d.type };
  if (nonEmpty(d.description)) o.description = d.description;
  if (d.type === "boolean") return o;
  const values = (Array.isArray(d.options) ? d.options : []).filter((c): c is Raw => isRecord(c) && nonEmpty(c.id) && typeof c.label === "string")
    .map((c) => ({ id: c.id as string, label: c.label as string, ...(nonEmpty(c.description) ? { description: c.description } : {}), ...(c.isDefault === true ? { isDefault: true } : {}) }));
  if (!values.length) return null;
  o.values = values;
  return o;
}

function modelView(m: ProviderModel): AgentModelView {
  const v: AgentModelView = { slug: m.slug, name: m.name, isDefault: m.isDefault === true, options: [] };
  if (nonEmpty(m.shortName)) v.shortName = m.shortName;
  if (m.isLegacy === true) v.isLegacy = true;
  const descriptors: unknown = isRecord(m.capabilities) ? m.capabilities.optionDescriptors : undefined;
  for (const d of Array.isArray(descriptors) ? descriptors : []) {
    const o = optionView(d);
    if (o) v.options.push(o);
  }
  return v;
}

/** What loadAgents reads of a provider snapshot. */
interface ProviderRow { installed: boolean; version: string | null; status: string; message?: string; auth: AgentView["auth"]; models: ProviderModel[]; capabilities?: AdapterCapabilities }

/**
 * The provider rows of a `GET /api/agent/providers` body, keyed by adapter id. The snapshot type is the contract, but an
 * older host (or a cache it hydrated) can miss or mistype a field: each is checked, one that fails reads as absent or
 * unknown, and a row without an id is skipped — a catalogue read never throws on a degraded row. Both readers of that
 * body go through it, so they cannot drift apart: list_agents (`loadAgents`, below) and the view context behind every
 * session detail (`buildViewContext`, views.ts).
 */
export function providerRows(body: unknown): Map<string, ProviderRow> {
  const rows = new Map<string, ProviderRow>();
  const list: unknown = isRecord(body) ? body.providers : undefined;
  for (const p of Array.isArray(list) ? list : []) {
    if (!isRecord(p) || !nonEmpty(p.id)) continue;
    const auth = isRecord(p.auth) ? p.auth : {};
    rows.set(p.id, {
      installed: p.installed === true, version: nonEmpty(p.version) ? p.version : null, status: nonEmpty(p.status) ? p.status : "unknown",
      ...(nonEmpty(p.message) ? { message: p.message } : {}),
      auth: { status: nonEmpty(auth.status) ? auth.status : "unknown", ...(nonEmpty(auth.label) ? { label: auth.label } : {}), ...(nonEmpty(auth.email) ? { email: auth.email } : {}) },
      models: (Array.isArray(p.models) ? p.models : []).filter((m): m is ProviderModel => isRecord(m) && nonEmpty(m.slug) && typeof m.name === "string"),
      ...(isRecord(p.capabilities) ? { capabilities: p.capabilities as unknown as AdapterCapabilities } : {})
    });
  }
  return rows;
}

export async function loadAgents(api: DaemonApi, opts?: { includeLegacyModels?: boolean }): Promise<AgentView[]> {
  const registryRes = await api.request("GET", "/api/registry");
  if (registryRes.status >= 400) throw new ToolError("INTERNAL", "Could not read the agent registry.");
  const entries = ((registryRes.body as RegistryResponse).agents ?? []).filter((e): e is RegistryEntry & { chat: { adapter: AgentAdapterId } } => Boolean(e.chat?.adapter));
  const providersRes = await api.request("GET", agentChatRoutes.providers);
  const providers = providersRes.status < 400 ? providerRows(providersRes.body) : new Map<string, ProviderRow>();
  const accountsRes = await api.request("GET", "/api/agent-accounts");
  const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse) : { accounts: [], defaults: { claude: null, codex: null, grok: null } };
  // Every proxy launcher needs the proxy's seeded accounts; only one that launches a proxy model (claudex) needs its catalogue.
  let proxy: CliProxyStatus | null = null;
  let catalog: string[] = [];
  if (entries.some((e) => isProxyAgent(e.id))) {
    const statusRes = await api.request("GET", "/api/cliproxy");
    if (statusRes.status < 400) proxy = statusRes.body as CliProxyStatus;
  }
  if (entries.some((e) => launchesProxyModel(e.id))) {
    const catalogRes = await api.request("GET", "/api/cliproxy/models");
    if (catalogRes.status < 400) catalog = ((catalogRes.body as { models?: string[] }).models ?? []);
  }
  const seeded = new Set((proxy?.accounts ?? []).map((a) => a.id));
  return entries.map((entry) => {
    const adapter = entry.chat.adapter;
    const snapshot = providers.get(adapter);
    const family = (proxyAccountFamily(entry.id) ?? entry.id) as keyof AgentAccountsResponse["defaults"];
    const familyAccounts = accounts.accounts.filter((a) => a.agent === family).filter((a) => !isProxyAgent(entry.id) || seeded.has(a.id));
    const defaultAccountId = familyAccounts.some((a) => a.id === accounts.defaults[family]) ? (accounts.defaults[family] as string) : "system";
    let models: AgentModelView[];
    if (launchesProxyModel(entry.id)) {
      models = proxyLaunchModels(proxy, catalog).map((m) => ({ slug: m.id, name: m.id, isDefault: m.id === proxy?.defaultModel, options: [], ...(m.providerLabel ? { providerLabel: m.providerLabel } : {}) }));
      if (models.length && !models.some((m) => m.isDefault)) models[0]!.isDefault = true;
    } else {
      // The adapter's own catalogue — claudemix's too: its model is the Claude main loop's, only its account is the proxy's.
      models = (snapshot?.models ?? []).filter((m) => opts?.includeLegacyModels || m.isLegacy !== true).map(modelView);
    }
    const caps = snapshot?.capabilities;
    const view: AgentView = {
      id: entry.id, name: entry.name, adapter, enabled: entry.enabled, ...(!entry.enabled && nonEmpty(entry.disabledReason) ? { disabledReason: entry.disabledReason } : {}),
      installed: snapshot?.installed ?? false, version: entry.version ?? snapshot?.version ?? null,
      status: snapshot?.status ?? "unknown", auth: snapshot?.auth ?? { status: "unknown" },
      models, effortOptionId: EFFORT_OPTION_IDS[adapter], runtimeModes: RUNTIME_MODES, defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
      supports: { ...supportsFrom(caps), contextWindow: caps?.reportsContextWindow === true },
      accounts: [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: defaultAccountId === "system" }, ...familyAccounts.map((a) => ({ id: a.id, label: a.label, email: a.email, plan: a.plan, needsReauth: a.needsReauth, isDefault: a.id === defaultAccountId }))],
      defaultAccountId
    };
    if (snapshot?.message) view.message = snapshot.message;
    return view;
  });
}

/** A model as list_agents lists it: whole, or — shed to fit the result — without its options, marked `optionsOmitted`. */
export type ListedModelView = AgentModelView | (Omit<AgentModelView, "options"> & { optionsOmitted: true });
/** An agent as list_agents lists it: when models were left out to fit, `modelsTruncated` and the catalogue's `modelCount`. */
export type ListedAgentView = Omit<AgentView, "models"> & { models: ListedModelView[]; modelsTruncated?: true; modelCount?: number };

const withoutOptions = ({ options: _options, ...model }: AgentModelView): ListedModelView => ({ ...model, optionsOmitted: true });

/**
 * The agents within `budget` bytes of `{agents}` JSON — list_agents' result, as ok() measures it. Every agent is listed,
 * its header (everything but `models`) whole. Its default model stays whole too: the one flagged default (OpenCode can
 * flag two: both), else the first — what a launch that names none gets (`resolveModelSelection`, the GUI's
 * `resolveLaunchModel`). Over budget,
 * the rest is shed in two passes, each walking the catalogues largest first (by bytes) and each catalogue from its END,
 * so the oldest-listed models go last: (a) the options of every other model, which is then marked `optionsOmitted` — a
 * model with no options has nothing to shed and is never marked; (b) only once no catalogue has any options left to
 * shed, whole models, the agent then carrying `modelsTruncated` and `modelCount`. Each stops the moment the result
 * fits. Pure, and linear: every model is measured once in each of its two forms, and the rest is arithmetic —
 * `JSON.stringify` is compositional, so an agent's bytes are its header's plus its models' plus the commas between.
 * Never applied by loadAgents: create_session and update_session always read the whole catalogue.
 */
export function fitAgentViews(agents: readonly AgentView[], budget: number): ListedAgentView[] {
  const commas = (count: number): number => Math.max(0, count - 1);
  const plans = agents.map((agent) => {
    const flagged = agent.models.some((m) => m.isDefault);
    const whole = agent.models.map((m) => resultBytes(m));
    return {
      agent, whole, bare: agent.models.map((m) => resultBytes(withoutOptions(m))),
      spared: agent.models.map((m, i) => (flagged ? m.isDefault : i === 0)),
      /** Each model's form, and its bytes in that form (0 once dropped). */
      form: agent.models.map((): "whole" | "bare" | "dropped" => "whole"), size: [...whole],
      header: resultBytes({ ...agent, models: [] }), truncated: false
    };
  });
  const catalogue = (p: (typeof plans)[number]): number => p.size.reduce((sum, n) => sum + n, 0);
  let total = resultBytes({ agents: [] }) + commas(plans.length) + plans.reduce((sum, p) => sum + p.header + catalogue(p) + commas(p.agent.models.length), 0);
  if (total <= budget) return [...agents];
  const largestFirst = (): typeof plans => plans.map((p) => ({ p, bytes: catalogue(p) })).sort((a, b) => b.bytes - a.bytes).map(({ p }) => p);
  // (a) Options, largest catalogue first, each from its end.
  for (const p of largestFirst()) {
    for (let i = p.agent.models.length - 1; i >= 0 && total > budget; i -= 1) {
      if (p.spared[i] || !p.agent.models[i]!.options.length) continue;
      total -= p.whole[i]! - p.bare[i]!;
      p.form[i] = "bare";
      p.size[i] = p.bare[i]!;
    }
  }
  // (b) Whole models, the same way. The spared model always stays, so a dropped one always takes a comma with it.
  for (const p of total > budget ? largestFirst() : []) {
    for (let i = p.agent.models.length - 1; i >= 0 && total > budget; i -= 1) {
      if (p.spared[i]) continue;
      if (!p.truncated) {
        p.truncated = true;
        total += resultBytes({ ...p.agent, models: [], modelsTruncated: true, modelCount: p.agent.models.length }) - p.header;
      }
      total -= p.size[i]! + 1;
      p.form[i] = "dropped";
      p.size[i] = 0;
    }
  }
  return plans.map((p) => {
    if (p.form.every((f) => f === "whole")) return p.agent;
    const models = p.agent.models.flatMap((m, i): ListedModelView[] => (p.form[i] === "dropped" ? [] : [p.form[i] === "bare" ? withoutOptions(m) : m]));
    return { ...p.agent, models, ...(p.truncated ? { modelsTruncated: true as const, modelCount: p.agent.models.length } : {}) };
  });
}

/** Valid values as every refusal lists them: up to 40, then "…"; "none" when there are none. */
export function nameList(names: readonly string[]): string {
  return names.length ? `${names.slice(0, 40).join(", ")}${names.length > 40 ? ", …" : ""}` : "none";
}

export function findAgent(agents: readonly AgentView[], refId: string): AgentView {
  const agent = agents.find((a) => a.id === refId);
  if (!agent) throw new ToolError("INVALID_ARGUMENT", `Unknown agent "${refId}". Valid agents: ${nameList(agents.map((a) => a.id))}.`);
  return agent;
}

/** The refusal of a model an agent's catalogue does not list, as every tool words it: the caller's slug, capped, and the valid ones. */
const unknownModel = (agent: AgentView, slug: string): ToolError =>
  new ToolError("INVALID_ARGUMENT", `Unknown model "${clipText(slug, MAX_ECHO_CHARS)}" for ${agent.id}. Valid models: ${nameList(agent.models.map((m) => m.slug))}.`);

/** The agent's model `slug` — list_agents {agent, model}; refused when unknown, and while the catalogue is still being probed. */
export function findModel(agent: AgentView, slug: string): AgentModelView {
  const model = agent.models.find((m) => m.slug === slug);
  if (model) return model;
  if (!agent.models.length) throw new ToolError("INVALID_ARGUMENT", `Still loading ${agent.id}'s models — retry in a moment.`);
  throw unknownModel(agent, slug);
}

export interface ResolvedSelection { model: string; options: { id: string; value: string | boolean }[] }

export function resolveModelSelection(agent: AgentView, input: { model?: string; options?: Record<string, string | boolean>; current?: ModelSelection }): ResolvedSelection {
  // `||`, not `??`: an empty model is "none" (the daemon's spelling of "the provider's own default"), so it never wins.
  const model = input.model || input.current?.model || agent.models.find((m) => m.isDefault)?.slug || agent.models[0]?.slug;
  if (!model) throw new ToolError("INVALID_ARGUMENT", `Still loading ${agent.id}'s models — retry in a moment (list_agents).`);
  const modelView = agent.models.find((m) => m.slug === model);
  if (agent.models.length && !modelView) throw unknownModel(agent, model);
  const descriptors = modelView?.options ?? [];
  // A listed model without option descriptors takes none: the GUI offers it no chips (claudex's proxy models, Claude's
  // haiku). Only a catalogue still being probed passes options through unchecked, for the host to judge.
  if (modelView && !descriptors.length && Object.keys(input.options ?? {}).length) throw new ToolError("INVALID_ARGUMENT", `${model} takes no options.`);
  const known = new Set(descriptors.map((d) => d.id));
  const merged = new Map<string, string | boolean>();
  for (const o of input.current?.options ?? []) {
    // Same model: everything survives. New model: only an option it advertises, with a value it accepts.
    const d = descriptors.find((x) => x.id === o.id);
    const accepted = d !== undefined && (d.type === "boolean" ? typeof o.value === "boolean" : (d.values ?? []).some((v) => v.id === o.value));
    if (input.current?.model === model || accepted) merged.set(o.id, o.value);
  }
  for (const [rawId, rawValue] of Object.entries(input.options ?? {})) {
    const id = rawId === "effort" && !known.has("effort") ? agent.effortOptionId : rawId;
    const d = descriptors.find((x) => x.id === id);
    if (descriptors.length && !d) throw new ToolError("INVALID_ARGUMENT", `Unknown option "${rawId}" for model ${model}. Valid options: ${descriptors.map((x) => x.id).join(", ")}.`);
    if (!d) { merged.set(id, rawValue); continue; } // nothing to check against: only a catalogue still being probed
    if (d.type === "boolean") {
      if (typeof rawValue !== "boolean") throw new ToolError("INVALID_ARGUMENT", `Option "${rawId}" takes a boolean.`);
      merged.set(id, rawValue);
    } else {
      const wanted = String(rawValue);
      const choice = d.values?.find((v) => v.id === wanted) ?? d.values?.find((v) => v.label.toLowerCase() === wanted.toLowerCase());
      if (!choice) throw new ToolError("INVALID_ARGUMENT", `Option "${rawId}" must be one of: ${(d.values ?? []).map((v) => v.id).join(", ")}.`);
      merged.set(id, choice.id);
    }
  }
  return { model, options: [...merged.entries()].map(([id, value]) => ({ id, value })) };
}

export function validateAccountId(agent: AgentView, accountId: string | undefined): string | undefined {
  if (accountId === undefined) return undefined;
  if (accountId === "system") return "system";
  if (agent.accounts.some((a) => a.id === accountId)) return accountId;
  const valid = agent.accounts.map((a) => a.id).join(", ");
  const hint = isProxyAgent(agent.id) ? ` (${agent.id} accepts only accounts seeded into the model proxy)` : "";
  throw new ToolError("INVALID_ARGUMENT", `Account "${accountId}" is not usable with ${agent.id}${hint}. Valid: ${valid}.`);
}
