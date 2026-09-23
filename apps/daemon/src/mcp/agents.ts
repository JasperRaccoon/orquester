import { proxyLaunchModels, type AgentAccountsResponse, type CliProxyStatus, type RegistryEntry, type RegistryResponse } from "@orquester/api";
import { agentChatRoutes, DEFAULT_RUNTIME_MODE, RUNTIME_MODES, type AdapterCapabilities, type AgentAdapterId, type AgentProvidersResponse, type ModelSelection, type ProviderModel, type ProviderSnapshot, type RuntimeMode } from "@orquester/api/agent-chat";
import { proxyAccountFamily } from "../agent-chat/service.ts";
import type { DaemonApi } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";

export const EFFORT_OPTION_IDS: Record<AgentAdapterId, string> = { claude: "effort", codex: "effort", opencode: "variant", grok: "reasoningEffort" };
export interface AgentModelOptionView { id: string; label: string; type: "select" | "boolean"; description?: string; values?: { id: string; label: string; description?: string; isDefault?: boolean }[] }
export interface AgentModelView { slug: string; name: string; shortName?: string; isDefault: boolean; isLegacy?: boolean; providerLabel?: string; options: AgentModelOptionView[] }
export interface AgentAccountView { id: string; label: string; email: string | null; plan: string | null; needsReauth: boolean; isDefault: boolean }
export interface AgentView { id: string; name: string; adapter: AgentAdapterId; enabled: boolean; installed: boolean; version: string | null; status: string; message?: string; auth: { status: string; label?: string; email?: string };
  models: AgentModelView[]; effortOptionId: string; runtimeModes: readonly RuntimeMode[]; defaultRuntimeMode: RuntimeMode; supports: { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean; contextWindow: boolean }; accounts: AgentAccountView[]; defaultAccountId: string }

export function isProxyAgent(refId: string): boolean {
  return proxyAccountFamily(refId) !== null;
}

/** The capability flags list_agents and get_session both report. No snapshot, or an absent flag, reads false. */
export function supportsFrom(caps: AdapterCapabilities | undefined): { planMode: boolean; rollback: boolean; compaction: boolean; backgroundTasks: boolean } {
  return { planMode: caps?.showPlanModeToggle ?? false, rollback: caps?.supportsConversationRollback ?? false, compaction: caps?.compaction !== undefined, backgroundTasks: caps?.supportsBackgroundTasks ?? false };
}

function modelView(m: ProviderModel): AgentModelView {
  const v: AgentModelView = { slug: m.slug, name: m.name, isDefault: m.isDefault === true, options: [] };
  if (m.shortName) v.shortName = m.shortName;
  if (m.isLegacy) v.isLegacy = true;
  for (const d of m.capabilities?.optionDescriptors ?? []) {
    const o: AgentModelOptionView = { id: d.id, label: d.label, type: d.type };
    if (d.description) o.description = d.description;
    if (d.type === "select") o.values = d.options.map((c) => ({ id: c.id, label: c.label, ...(c.description ? { description: c.description } : {}), ...(c.isDefault ? { isDefault: true } : {}) }));
    v.options.push(o);
  }
  return v;
}

export async function loadAgents(api: DaemonApi, opts?: { includeLegacyModels?: boolean }): Promise<AgentView[]> {
  const registryRes = await api.request("GET", "/api/registry");
  if (registryRes.status >= 400) throw new ToolError("INTERNAL", "Could not read the agent registry.");
  const entries = ((registryRes.body as RegistryResponse).agents ?? []).filter((e): e is RegistryEntry & { chat: { adapter: AgentAdapterId } } => Boolean(e.chat?.adapter));
  const providersRes = await api.request("GET", agentChatRoutes.providers);
  const providers = new Map<string, ProviderSnapshot>();
  if (providersRes.status < 400) for (const p of (providersRes.body as AgentProvidersResponse).providers ?? []) providers.set(p.id, p);
  const accountsRes = await api.request("GET", "/api/agent-accounts");
  const accounts = accountsRes.status < 400 ? (accountsRes.body as AgentAccountsResponse) : { accounts: [], defaults: { claude: null, codex: null, grok: null } };
  const needsProxy = entries.some((e) => isProxyAgent(e.id));
  let proxy: CliProxyStatus | null = null;
  let catalog: string[] = [];
  if (needsProxy) {
    const statusRes = await api.request("GET", "/api/cliproxy");
    if (statusRes.status < 400) proxy = statusRes.body as CliProxyStatus;
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
    if (isProxyAgent(entry.id)) {
      models = proxyLaunchModels(proxy, catalog).map((m) => ({ slug: m.id, name: m.id, isDefault: m.id === proxy?.defaultModel, options: [], ...(m.providerLabel ? { providerLabel: m.providerLabel } : {}) }));
      if (models.length && !models.some((m) => m.isDefault)) models[0]!.isDefault = true;
    } else {
      models = (snapshot?.models ?? []).filter((m) => opts?.includeLegacyModels || !m.isLegacy).map(modelView);
    }
    const caps = snapshot?.capabilities;
    const view: AgentView = {
      id: entry.id, name: entry.name, adapter, enabled: entry.enabled, installed: snapshot?.installed ?? false, version: entry.version ?? snapshot?.version ?? null,
      status: snapshot?.status ?? "unknown", auth: snapshot ? { status: snapshot.auth.status, ...(snapshot.auth.label ? { label: snapshot.auth.label } : {}), ...(snapshot.auth.email ? { email: snapshot.auth.email } : {}) } : { status: "unknown" },
      models, effortOptionId: EFFORT_OPTION_IDS[adapter], runtimeModes: RUNTIME_MODES, defaultRuntimeMode: DEFAULT_RUNTIME_MODE,
      supports: { ...supportsFrom(caps), contextWindow: caps?.reportsContextWindow ?? false },
      accounts: [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: defaultAccountId === "system" }, ...familyAccounts.map((a) => ({ id: a.id, label: a.label, email: a.email, plan: a.plan, needsReauth: a.needsReauth, isDefault: a.id === defaultAccountId }))],
      defaultAccountId
    };
    if (snapshot?.message) view.message = snapshot.message;
    return view;
  });
}

export function findAgent(agents: readonly AgentView[], refId: string): AgentView {
  const agent = agents.find((a) => a.id === refId);
  if (!agent) throw new ToolError("INVALID_ARGUMENT", `Unknown agent "${refId}". Valid agents: ${agents.map((a) => a.id).join(", ")}.`);
  return agent;
}

export interface ResolvedSelection { model: string; options: { id: string; value: string | boolean }[] }

export function resolveModelSelection(agent: AgentView, input: { model?: string; options?: Record<string, string | boolean>; current?: ModelSelection }): ResolvedSelection {
  // `||`, not `??`: an empty model is "none" (the daemon's spelling of "the provider's own default"), so it never wins.
  const model = input.model || input.current?.model || agent.models.find((m) => m.isDefault)?.slug || agent.models[0]?.slug;
  if (!model) throw new ToolError("INVALID_ARGUMENT", `Still loading ${agent.id}'s models — retry in a moment (list_agents).`);
  const modelView = agent.models.find((m) => m.slug === model);
  if (agent.models.length && !modelView) {
    throw new ToolError("INVALID_ARGUMENT", `Unknown model "${model}" for ${agent.id}. Valid models: ${agent.models.slice(0, 40).map((m) => m.slug).join(", ")}${agent.models.length > 40 ? ", …" : ""}.`);
  }
  const descriptors = modelView?.options ?? [];
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
    if (!d) { merged.set(id, rawValue); continue; }
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
