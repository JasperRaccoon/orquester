import React from "react";
import { FolderTree, GitBranch, Globe, ListTodo, Plus } from "lucide-react";
import { SYSTEM_ACCOUNT_ID, type RegistryEntry } from "@orquester/api";
import { CURATED_PROXY_MODEL_IDS, XAI_OAUTH_MODELS, resolveXaiModel } from "@orquester/config";
import { CHROMIUM_FAMILY_IDS } from "@orquester/registry";
import {
  AdaptiveMenu,
  DropdownEmpty,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  IconButton
} from "../ui";
import { getRegistryIcon } from "../../icons";
import { useRegistry } from "../../hooks";
import { useAppStore, useCurrentContext } from "../../store/app";
import { cn } from "../../lib/cn";
import { shortAccountLabel } from "../../lib/account-label";

/**
 * The proxy launchers pin *which provider family* their account chips come from:
 * routing through the managed proxy is by model name, so `claudex` picks a
 * seeded **Codex** account (its GPT/Kimi escape hatch) and `claudemix` picks a
 * seeded **Claude** account (the Fable main loop). The launcher's own id never
 * matches a managed account (`a.agent` is only `"claude"`/`"codex"`), so without
 * this remap the chips would never appear (spec §2/§5).
 */
const PROXY_ACCOUNT_FAMILY: Record<string, "claude" | "codex"> = {
  claudemix: "claude",
  claudex: "codex"
};

/** Model chips for `claudex`: the curated picks, not the raw catalog dump. */
const DEFAULT_PROXY_MODELS: string[] = [...CURATED_PROXY_MODEL_IDS];

/** Provider label for the xAI OAuth models — the linked account IS the "key". */
const XAI_PROVIDER_LABEL = "Grok account";

const isProxyLauncher = (id: string): boolean => id in PROXY_ACCOUNT_FAMILY;

/** The daemon strips this routing prefix before resolving a router model, so the
 *  UI must too (a stale per-account pick can still carry one). */
const stripAccountPrefix = (model: string): string => model.replace(/^acc[0-9a-fA-F]+\//, "");

/** Short chip label for a backing model, e.g. `gpt-5.6-sol` → `sol`, `kimi-k3` → `kimi`. */
const shortModelLabel = (model: string): string => {
  const lower = model.toLowerCase();
  if (lower.includes("kimi")) return "kimi";
  const parts = model.split(/[/-]/).filter(Boolean);
  return parts[parts.length - 1] ?? model;
};

/**
 * One installed-agent row in the "+" menu. Clicking the row launches the agent
 * under the account (and, for `claudex`, the model) selected below. When the
 * agent has ≥1 managed account for its family it renders a row of account chips
 * (System + managed accounts); `claudex` additionally renders a model-chip row.
 * Both choices are remembered per launcher id (client-local) so opening several
 * tabs doesn't re-prompt. "System" carries the SYSTEM_ACCOUNT_ID sentinel (not an
 * omitted value) so it forces the host identity over any per-agent default.
 *
 * Proxy launchers whose backing proxy is enabled-but-down render
 * **visible-but-disabled** (greyed, non-clickable, with the daemon's
 * `disabledReason`) so the outage is discoverable (spec §2); when the proxy is
 * off (user-disabled) they are hidden entirely. Non-proxy disabled agents are
 * filtered out upstream as before.
 */
const AgentRow: React.FC<{ agent: RegistryEntry }> = ({ agent }) => {
  const openTab = useAppStore((s) => s.openTab);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const preferred = useAppStore((s) => s.preferredAccountByAgent[agent.id]);
  const setPreferredAccount = useAppStore((s) => s.setPreferredAccount);
  const preferredModel = useAppStore((s) => s.preferredModelByAgent[agent.id]);
  const setPreferredModel = useAppStore((s) => s.setPreferredModel);
  const cliproxy = useAppStore((s) => s.cliproxy);
  const cliproxyModels = useAppStore((s) => s.cliproxyModels);

  // A proxy launcher draws its accounts from the mapped provider family; every
  // other agent draws from its own id (the pre-proxy behaviour).
  const family = PROXY_ACCOUNT_FAMILY[agent.id];
  const accountKey = family ?? agent.id;
  // Proxy launchers may only pin accounts whose credentials are SEEDED into the
  // proxy: an unseeded pin emits an acc<hex>/ routing prefix no auth file
  // serves, and the session 502s at runtime ("unknown provider for model").
  const seededIds = new Set((cliproxy?.accounts ?? []).map((a) => a.id));
  const managed = (agentAccounts?.accounts ?? [])
    .filter((a) => a.agent === accountKey)
    .filter((a) => !family || seededIds.has(a.id));

  const options = [
    { id: SYSTEM_ACCOUNT_ID, label: "System" },
    ...managed.map((a) => ({ id: a.id, label: shortAccountLabel(a.label) }))
  ];
  const fallback = agentAccounts?.defaults[accountKey as "claude" | "codex"] ?? SYSTEM_ACCOUNT_ID;
  const wanted = preferred ?? fallback;
  const selectedAccount = options.some((o) => o.id === wanted) ? wanted : SYSTEM_ACCOUNT_ID;

  // Model chips are a `claudex`-only affordance (claudemix's model is fixed to
  // the Claude main loop; its choice is the account instead).
  const showModels = agent.id === "claudex";
  // Models served by a KEYED router provider — or by the linked xAI account —
  // are keyless: the account chip has no effect on them. Derived from live status
  // (both the full name and the alias route), replacing the old hardcoded
  // kimi/OpenRouter regex.
  const keylessInfo = React.useMemo(() => {
    const labelByModel = new Map<string, string>(); // model id (name or alias) → provider label
    const displayIds: string[] = []; // what the chips offer: alias when there is one
    // `?? []` — a stale bundle's persisted status may predate routerProviders.
    for (const p of cliproxy?.routerProviders ?? []) {
      // Only a keyed provider is rendered into the proxy's config.yaml; an
      // unkeyed one serves nothing, so it must not contribute chips.
      if (p.keyState === "none") continue;
      for (const m of p.models) {
        labelByModel.set(m.name, p.label);
        if (m.alias) labelByModel.set(m.alias, p.label);
        displayIds.push(m.alias ?? m.name);
      }
    }
    // The Grok models exist while an xAI credential exists — `expired` included,
    // matching the daemon's files-present gate (the expiry stamp is
    // informational; the proxy refreshes on next use, and the launcher stays
    // coupled). `?.` guards a daemon/bundle pairing that predates the field
    // (persisted-shape rule).
    if (cliproxy?.xai?.state === "linked" || cliproxy?.xai?.state === "expired") {
      for (const m of XAI_OAUTH_MODELS) {
        labelByModel.set(m.id, XAI_PROVIDER_LABEL);
        displayIds.push(m.id);
      }
    }
    return { labelByModel, displayIds };
  }, [cliproxy]);

  // The live catalog enumerates EVERYTHING the proxy serves (every seeded
  // account's models + acc-prefixed duplicates) — as a picker that's noise.
  // Offer the curated picks plus the router-served ones the catalog confirms;
  // all of them if none confirm (catalog empty/stale), so the chips never
  // vanish entirely.
  const catalogModels = cliproxyModels?.models ?? [];
  const pickIds = React.useMemo(
    () => [...new Set([...DEFAULT_PROXY_MODELS, ...keylessInfo.displayIds])],
    [keylessInfo]
  );
  const available = catalogModels.length ? pickIds.filter((m) => catalogModels.includes(m)) : pickIds;
  const baseModels = available.length ? available : pickIds;
  const selectedModel = preferredModel ?? cliproxy?.defaultModel ?? baseModels[0];
  const modelOptions = React.useMemo(() => {
    const set = new Set(baseModels);
    // Never drop a persisted pick even if the catalog no longer lists it — show
    // it (stale) rather than silently falling back to another model (spec §2).
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [baseModels, selectedModel]);

  // A router- or Grok-served model is keyless → its account chip has no effect;
  // dim the row AND drop the account on launch so a stale pick can't reattach a
  // prefix.
  const keylessLabel = selectedModel
    ? keylessInfo.labelByModel.get(stripAccountPrefix(selectedModel))
    : undefined;
  const accountDimmed = showModels && Boolean(keylessLabel);
  const dimReason = !accountDimmed
    ? undefined
    : selectedModel && resolveXaiModel(selectedModel)
      ? `${selectedModel} uses Grok account — account is ignored`
      : `${selectedModel} routes through ${keylessLabel} (keyless) — account is ignored`;

  // A deliberately-off proxy (user disabled it, or status not loaded yet) hides
  // its launchers entirely — advertising an escape hatch the user turned off is
  // noise. Only an *enabled-but-unhealthy* proxy renders visible-but-disabled
  // (greyed, with the daemon's reason) so the outage is discoverable (spec §2).
  if (!agent.enabled) {
    if (!cliproxy || cliproxy.state === "off") return null;
    return (
      <div
        className="mb-0.5 flex w-full cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-500"
        title={agent.disabledReason ?? "Unavailable"}
      >
        <span className="flex h-4 w-4 items-center justify-center opacity-60">
          {getRegistryIcon("agent", agent.id, 14)}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {agent.name}
          {agent.disabledReason ? (
            <span className="ml-1 text-[11px] text-neutral-600">— {agent.disabledReason}</span>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <>
      <DropdownItem
        icon={
          <span className="flex h-4 w-4 items-center justify-center">
            {getRegistryIcon("agent", agent.id, 14)}
          </span>
        }
        onClick={() =>
          void openTab(
            "agent",
            agent.id,
            agent.name,
            // A keyless router pick carries the System sentinel (no account) so
            // the daemon never stamps a per-account routing prefix on it.
            accountDimmed ? SYSTEM_ACCOUNT_ID : selectedAccount,
            showModels ? selectedModel : undefined
          )
        }
      >
        {agent.name}
      </DropdownItem>
      {showModels ? (
        <div
          className="mb-1.5 ml-8 mr-2 flex flex-wrap gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          {modelOptions.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPreferredModel(agent.id, m)}
              className={cn(
                "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors",
                m === selectedModel
                  ? "bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/40"
                  : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
              )}
              title={m}
            >
              {m}
            </button>
          ))}
        </div>
      ) : null}
      {managed.length > 0 ? (
        <div
          className={cn(
            "mb-1.5 ml-8 mr-2 flex flex-wrap gap-1 transition-opacity",
            accountDimmed && "pointer-events-none opacity-40"
          )}
          title={dimReason}
          onClick={(event) => event.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setPreferredAccount(agent.id, o.id)}
              className={cn(
                "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors",
                o.id === selectedAccount
                  ? "bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/40"
                  : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
              )}
              title={o.label}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
};

/**
 * The "+" new-tab button. In a project it lists detected shells and INSTALLED
 * agents (manage installs in Settings → Agents / Harnesses) plus built-in tools
 * and to-do lists; in a workspace context it offers only to-do lists. Choosing
 * an entry opens a tab in the current context.
 */
export const NewTabMenu: React.FC = () => {
  const openTab = useAppStore((s) => s.openTab);
  const openFileBrowser = useAppStore((s) => s.openFileBrowser);
  const openGit = useAppStore((s) => s.openGit);
  const openBrowser = useAppStore((s) => s.openBrowser);
  const api = useAppStore((s) => s.api);
  const ctx = useCurrentContext();
  const todos = useAppStore((s) => s.todos);
  const createTodo = useAppStore((s) => s.createTodo);
  const openTodo = useAppStore((s) => s.openTodo);
  const registry = useRegistry();

  const shells = registry.shells.filter((s) => s.enabled);
  // Enabled agents show normally; a *disabled proxy launcher* stays visible
  // (greyed, with a reason) so the GPT/Kimi escape hatch is discoverable even
  // when its proxy is down (spec §2). Other disabled agents remain hidden.
  const agents = registry.agents.filter((a) => a.enabled || isProxyLauncher(a.id));
  // Browser tabs need BOTH chromium detected on the host AND a transport that can
  // stream frames. The desktop unix socket has no browserChannel, so a browser
  // record would open a dead blank tab — gate the entry on the channel too.
  const browserHasChannel = !!api?.browserChannel();
  // Only Chromium-family entries count: firefox/system-browser can be enabled
  // on a host the daemon's puppeteer-core resolver would still 409 on.
  const browserHostReady = registry.browsers.some((b) => b.enabled && CHROMIUM_FAMILY_IDS.has(b.id));

  const trigger = (
    <IconButton label="New tab" className="app-no-drag">
      <Plus size={16} />
    </IconButton>
  );

  if (ctx?.kind === "workspace") {
    const workspaceTodos = todos.filter((t) => t.scope === "workspace" && t.refKey === ctx.key);
    return (
      <AdaptiveMenu title="New tab" trigger={trigger} width="w-60">
        <DropdownLabel>To-do lists</DropdownLabel>
        <DropdownItem icon={<ListTodo size={14} />} onClick={() => void createTodo("workspace", ctx.key)}>
          New to-do list
        </DropdownItem>
        {workspaceTodos.map((rec) => (
          <DropdownItem key={rec.id} icon={<ListTodo size={14} />} onClick={() => openTodo(rec)}>
            {rec.name}
          </DropdownItem>
        ))}
      </AdaptiveMenu>
    );
  }

  const projectTodos = ctx ? todos.filter((t) => t.scope === "project" && t.refKey === ctx.key) : [];

  return (
    <AdaptiveMenu title="New tab" trigger={trigger} width="w-60">
      <DropdownLabel>Shells</DropdownLabel>
      {shells.length === 0 && <DropdownEmpty>No shells detected</DropdownEmpty>}
      {shells.map((shell) => (
        <DropdownItem
          key={shell.id}
          icon={getRegistryIcon("shell", shell.id, 14)}
          onClick={() => void openTab("shell", shell.id, shell.name)}
        >
          {shell.name}
        </DropdownItem>
      ))}

      <DropdownSeparator />

      <DropdownLabel>Tools</DropdownLabel>
      <DropdownItem icon={<FolderTree size={14} />} onClick={() => openFileBrowser()}>
        File Browser
      </DropdownItem>
      <DropdownItem icon={<GitBranch size={14} />} onClick={() => openGit()}>
        Git
      </DropdownItem>
      {browserHasChannel && browserHostReady ? (
        <DropdownItem icon={<Globe size={14} />} onClick={() => void openBrowser()}>
          Browser
        </DropdownItem>
      ) : !browserHasChannel ? (
        <DropdownEmpty>Browser — needs a remote (HTTP) connection</DropdownEmpty>
      ) : (
        <DropdownEmpty>Browser — install chromium on the host</DropdownEmpty>
      )}
      <DropdownItem
        icon={<ListTodo size={14} />}
        onClick={() => ctx && void createTodo("project", ctx.key, "to-dos")}
      >
        New to-do list
      </DropdownItem>
      {projectTodos.map((rec) => (
        <DropdownItem key={rec.id} icon={<ListTodo size={14} />} onClick={() => openTodo(rec)}>
          {rec.name}
        </DropdownItem>
      ))}

      <DropdownSeparator />

      <DropdownLabel>Agents</DropdownLabel>
      {agents.length === 0 && <DropdownEmpty>No agents installed</DropdownEmpty>}
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </AdaptiveMenu>
  );
};
