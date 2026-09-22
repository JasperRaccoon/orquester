import React from "react";
import {
  ChevronDown,
  ChevronRight,
  FolderTree,
  GitBranch,
  Globe,
  History,
  ListTodo,
  LoaderCircle,
  Plus,
  SlidersHorizontal
} from "lucide-react";
import {
  proxyLaunchModels,
  RUNTIME_MODES,
  SYSTEM_ACCOUNT_ID,
  type CreateAgentChatSessionFields,
  type RegistryEntry
} from "@orquester/api";
import { resolveXaiModel } from "@orquester/config";
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
import { relativeTime } from "../../lib/relative-time";
import { launchWithNotice } from "../../lib/launch-notice";
import { resumeAccountId } from "../../lib/resume-account";
import {
  canOpenChat,
  chatLaunchRefId,
  isChatResumableConversation
} from "../../lib/session-kind";
import {
  RUNTIME_MODE_HINTS,
  RUNTIME_MODE_LABELS,
  runtimeModeForAgent
} from "../../lib/chat-prefs";
// The launch chips and the composer's §3.4 account chip decide the same thing
// — which family a launcher's accounts come from — so they share one map.
import { isProxyLauncher, PROXY_ACCOUNT_FAMILY } from "../../lib/agent-chat/account-switch";
import { useProviderSnapshot } from "../../lib/agent-chat/hooks";
import { launchModelList, resolveLaunchModel } from "../../lib/launch-models";

/** Past conversations listed inline per agent before the "…and N more" cutoff. */
const MAX_INLINE_CONVERSATIONS = 10;

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
 * Inline "resume a past conversation" section for one agent row.
 *
 * Deliberately an inline expand rather than a hover flyout: the "+" menu renders
 * as a bottom sheet on mobile, where a nested submenu has nowhere to go, and the
 * row already expands inline for its account/model chips — so one pattern serves
 * both viewports. The (slow-ish) scan is only kicked off when the section is
 * actually opened, and the store caches it per project for the other agents'
 * sections.
 */
const ResumeSection: React.FC<{
  agent: RegistryEntry;
  projectPath: string;
  /** The exact account/model the row's own click would launch with — a resume
   *  must run under the same identity, or the agent looks for the conversation
   *  in the wrong home and finds nothing. */
  accountId?: string;
  model?: string;
  /** The row's own launch block; the picked conversation becomes its cursor. */
  chat: CreateAgentChatSessionFields;
}> = ({ agent, projectPath, accountId, model, chat }) => {
  const loadAgentConversations = useAppStore((s) => s.loadAgentConversations);
  const cached = useAppStore((s) => s.agentConversationsByProject[projectPath]);
  const openTab = useAppStore((s) => s.openTab);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (expanded) {
      void loadAgentConversations(projectPath);
    }
  }, [expanded, projectPath, loadAgentConversations]);

  // `undefined` (key absent) is "not fetched yet"; `[]` is "fetched, none".
  // Chat resumes under the conversation's own HOME instead of going through the
  // launcher's `resumeArgs`, so the claudex/claudemix proxy-home rows the
  // terminal path had to hide (`isResumableConversation`) are offered here for
  // the first time (§5.3) — under the launcher that owns that home.
  const mine = cached?.filter(
    (c) => chatLaunchRefId(c) === agent.id && isChatResumableConversation(c)
  );
  const shown = mine?.slice(0, MAX_INLINE_CONVERSATIONS) ?? [];
  const hidden = (mine?.length ?? 0) - shown.length;

  return (
    <>
      <div className="mb-1 ml-8 mr-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <History size={11} />
          Resume a conversation
        </button>
      </div>
      {expanded && (
        <div className="mb-1.5 ml-6 mr-1">
          {cached === undefined && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-neutral-600">
              <LoaderCircle size={12} className="animate-spin" /> Loading…
            </div>
          )}
          {cached !== undefined && shown.length === 0 && (
            <DropdownEmpty>No past conversations</DropdownEmpty>
          )}
          {shown.map((conversation) => (
            <DropdownItem
              key={conversation.id}
              className="text-[12px]"
              title={`${conversation.title}${
                conversation.preview ? `\n${conversation.preview}` : ""
              }`}
              onClick={() =>
                launchWithNotice(
                  openTab({
                    kind: "agent-chat",
                    refId: agent.id,
                    // Seeded from the conversation the user picked, so the tab
                    // reads as the thread it continues rather than "Claude Code".
                    title: conversation.title || agent.name,
                    // account-attributed rows force their home (only it sees
                    // the transcript); system rows honor the selected chip —
                    // every managed home symlinks back to the system history.
                    accountId: resumeAccountId(conversation, accountId),
                    model,
                    chat: {
                      ...chat,
                      accountId: resumeAccountId(conversation, accountId),
                      resume: {
                        home: conversation.home ?? "system",
                        conversationId: conversation.id
                      }
                    }
                  }),
                  agent.name
                )
              }
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                <span className="shrink-0 text-[10px] text-neutral-600">
                  {relativeTime(conversation.updatedAt)}
                </span>
              </span>
            </DropdownItem>
          ))}
          {hidden > 0 && (
            <div className="px-2 py-1 text-[11px] text-neutral-600">…and {hidden} more</div>
          )}
        </div>
      )}
    </>
  );
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
const AgentRow: React.FC<{ agent: RegistryEntry; projectPath?: string }> = ({
  agent,
  projectPath
}) => {
  const openTab = useAppStore((s) => s.openTab);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const preferred = useAppStore((s) => s.preferredAccountByAgent[agent.id]);
  const setPreferredAccount = useAppStore((s) => s.setPreferredAccount);
  const preferredModel = useAppStore((s) => s.preferredModelByAgent[agent.id]);
  const setPreferredModel = useAppStore((s) => s.setPreferredModel);
  const launchSelectionFor = useAppStore((s) => s.launchSelectionFor);
  const setNotice = useAppStore((s) => s.setNotice);
  const chatPrefs = useAppStore((s) => s.chatPrefs);
  const setPreferredRuntimeMode = useAppStore((s) => s.setPreferredRuntimeMode);
  const cliproxy = useAppStore((s) => s.cliproxy);
  const cliproxyModels = useAppStore((s) => s.cliproxyModels);
  // The adapter's live catalog, once the host has published one. `null` until
  // then, which is exactly the state a fresh daemon is in — the row degrades to
  // "launch with the provider's own default model" rather than blocking.
  const providerSnapshot = useProviderSnapshot(agent.id);

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
  const fallback = agentAccounts?.defaults[accountKey as "claude" | "codex" | "grok"] ?? SYSTEM_ACCOUNT_ID;
  const wanted = preferred ?? fallback;
  const selectedAccount = options.some((o) => o.id === wanted) ? wanted : SYSTEM_ACCOUNT_ID;

  // Model chips are a `claudex`-only affordance (claudemix's model is fixed to
  // the Claude main loop; its choice is the account instead).
  const showModels = agent.id === "claudex";
  // The chips are the shared proxy launch catalogue (`proxyLaunchModels`, the
  // same list the MCP reports): the curated picks plus the keyed-router and
  // linked-xAI models, narrowed to what the live catalog confirms — the raw
  // catalog enumerates every seeded account's models and acc-prefixed
  // duplicates, which is noise as a picker — or all of them when none confirm,
  // so the chips never vanish entirely.
  const baseModels = React.useMemo(
    () => proxyLaunchModels(cliproxy, cliproxyModels?.models ?? []).map((m) => m.id),
    [cliproxy, cliproxyModels]
  );
  // Models served by a KEYED router provider — or by the linked xAI account —
  // are keyless: the account chip has no effect on them. Built from the same
  // derivation, but catalog-independent (a pick the catalog does not confirm
  // still dims) and knowing a router model by its full name as well as its
  // alias, since both route.
  const labelByModel = React.useMemo(() => {
    const labels = new Map<string, string>(); // model id (name or alias) → provider label
    for (const m of proxyLaunchModels(cliproxy, [])) {
      if (m.providerLabel) labels.set(m.id, m.providerLabel);
    }
    // The launch list names an aliased model by its alias; add its full name.
    // `?? []` — a stale bundle's persisted status may predate routerProviders.
    for (const p of cliproxy?.routerProviders ?? []) {
      for (const m of p.models) {
        const label = m.alias ? labels.get(m.alias) : undefined;
        if (label) labels.set(m.name, label);
      }
    }
    return labels;
  }, [cliproxy]);
  // Every non-proxy agent gets its models from the adapter's own catalog once
  // the host has published a snapshot; the proxy launchers keep the curated
  // cliproxy list, which is a different thing entirely (what the proxy serves).
  const catalogModelsForAgent = React.useMemo(
    () => (providerSnapshot?.models ?? []).filter((m) => !m.isLegacy),
    [providerSnapshot]
  );
  // The selection. For a proxy launcher the curated list still rules; for every
  // other agent the catalogue resolves it, and it is NEVER empty when a
  // catalogue exists — the host rejects a blank model at thread creation.
  const selectedModel = showModels
    ? (preferredModel ?? cliproxy?.defaultModel ?? baseModels[0])
    : (resolveLaunchModel({
        snapshot: catalogModelsForAgent.length ? { models: catalogModelsForAgent } : null,
        preferred: preferredModel
      }) ?? undefined);
  // A catalogue of 378 models is not a picker: show a short, stable subset and
  // put the rest behind a search rather than rendering the whole wall.
  const [modelQuery, setModelQuery] = React.useState("");
  const catalogList = React.useMemo(
    () =>
      launchModelList({
        models: catalogModelsForAgent,
        selected: selectedModel ?? null,
        query: modelQuery
      }),
    [catalogModelsForAgent, selectedModel, modelQuery]
  );
  const proxyModelOptions = React.useMemo(() => {
    const set = new Set(baseModels);
    // Never drop a persisted pick even if the catalog no longer lists it — show
    // it (stale) rather than silently falling back to another model (spec §2).
    if (selectedModel) set.add(selectedModel);
    return [...set];
  }, [baseModels, selectedModel]);
  // Chips are offered wherever there is more than one thing to pick: the
  // curated proxy list, or an adapter catalog the host has published.
  const showModelChips = showModels || catalogModelsForAgent.length > 1;
  const runtimeMode = runtimeModeForAgent(chatPrefs, agent.id);
  // The launch options are folded away by default (T3's "+" is one row per
  // agent; its pickers live in the composer). One muted line says what a
  // click will launch with — account · mode · model — and opens the pickers
  // for the one thing the composer cannot change afterwards, the account.
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const selectedModelLabel = selectedModel
    ? (catalogModelsForAgent.find((m) => m.slug === selectedModel)?.shortName ??
      catalogModelsForAgent.find((m) => m.slug === selectedModel)?.name ??
      selectedModel)
    : null;

  // A router- or Grok-served model is keyless → its account chip has no effect;
  // dim the row AND drop the account on launch so a stale pick can't reattach a
  // prefix.
  const keylessLabel = selectedModel
    ? labelByModel.get(stripAccountPrefix(selectedModel))
    : undefined;
  const accountDimmed = showModels && Boolean(keylessLabel);
  const dimReason = !accountDimmed
    ? undefined
    : selectedModel && resolveXaiModel(selectedModel)
      ? `${selectedModel} uses Grok account — account is ignored`
      : `${selectedModel} routes through ${keylessLabel} (keyless) — account is ignored`;

  // The §6.1 launch block, shared by the row's own click and its resume rows so
  // a resumed thread starts under exactly the settings the row advertises. A
  // keyless router pick carries the System sentinel (no account) so the daemon
  // never stamps a per-account routing prefix on it.
  const launchAccountId = accountDimmed ? SYSTEM_ACCOUNT_ID : selectedAccount;
  //
  // `modelSelection.model` is REQUIRED by the host — a blank is refused at
  // thread creation — so a row with no resolvable model does not post a launch
  // it knows will fail; `launchModel` being null is what disables it.
  const launchModel = selectedModel ?? null;
  const chatFields: CreateAgentChatSessionFields | null = launchModel
    ? {
        accountId: launchAccountId,
        modelSelection: launchSelectionFor(agent.id, launchModel),
        runtimeMode
      }
    : null;

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
        onClick={() => {
          if (!chatFields) {
            // The catalogue has not arrived, so there is no model to name and
            // the host would refuse the create. Say that instead of firing a
            // request that comes back as "modelSelection.model is required".
            setNotice({
              title: agent.name,
              message: "Still loading this agent's models — try again in a moment."
            });
            return;
          }
          launchWithNotice(
            // Agent tabs are chat only (§1): the terminal launch path for agents
            // is gone, and a row without an adapter is never rendered.
            openTab({
              kind: "agent-chat",
              refId: agent.id,
              title: agent.name,
              accountId: launchAccountId,
              model: showModels ? selectedModel : undefined,
              chat: chatFields
            }),
            agent.name
          );
        }}
      >
        {agent.name}
      </DropdownItem>
      <button
        type="button"
        aria-expanded={optionsOpen}
        onClick={(event) => {
          event.stopPropagation();
          setOptionsOpen((open) => !open);
        }}
        className="mb-1 ml-8 mr-2 flex max-w-[calc(100%-2.5rem)] items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] text-neutral-500 transition-colors hover:bg-neutral-800/60 hover:text-neutral-300"
        title={optionsOpen ? "Hide launch options" : "Launch options"}
      >
        <SlidersHorizontal size={11} className="shrink-0" aria-hidden />
        <span className="min-w-0 truncate">
          {[
            managed.length > 0
              ? (options.find((o) => o.id === launchAccountId)?.label ?? "System")
              : null,
            RUNTIME_MODE_LABELS[runtimeMode],
            selectedModelLabel
          ]
            .filter((part): part is string => Boolean(part))
            .join(" · ")}
        </span>
        <ChevronDown
          size={11}
          className={cn("shrink-0 transition-transform", optionsOpen && "rotate-180")}
          aria-hidden
        />
      </button>
      {optionsOpen && showModelChips ? (
        <div
          className="mb-1.5 ml-8 mr-2 flex flex-col gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          {/* A catalogue is not a picker: OpenCode reports 378 models, and
              rendering them inline made this menu a multi-screen wall that
              every open paid for. Search appears only once there is more than
              a screenful to search. */}
          {!showModels && catalogList.searchable ? (
            <input
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Search models…"
              aria-label={`Search ${agent.name} models`}
              className="h-6 w-full rounded bg-neutral-900 px-1.5 text-[11px] text-neutral-200 outline-none ring-1 ring-neutral-700 placeholder:text-neutral-600 focus:ring-neutral-500"
            />
          ) : null}
          <div className="flex flex-wrap gap-1">
            {(showModels
              ? proxyModelOptions.map((slug) => ({ slug, label: slug, provider: null }))
              : catalogList.shown
            ).map((choice) => (
              <button
                key={choice.slug}
                type="button"
                onClick={() => setPreferredModel(agent.id, choice.slug)}
                className={cn(
                  "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors",
                  choice.slug === selectedModel
                    ? "bg-warn-500/15 text-warn-300 ring-1 ring-warn-500/40"
                    : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
                )}
                // The friendly name reads on the chip; the slug is what the
                // launch actually sends, so it stays available on hover.
                title={choice.provider ? `${choice.slug} · ${choice.provider}` : choice.slug}
              >
                {choice.label}
              </button>
            ))}
            {!showModels && catalogList.hidden > 0 ? (
              <span className="px-1 py-0.5 text-[11px] text-neutral-600">
                …and {catalogList.hidden} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {/* Permission mode (§4.4). Every provider expresses it as launch
          configuration, so it is picked BEFORE the session exists; changing it
          later restarts the session, which the composer's own chip owns. */}
      {optionsOpen ? (
      <div
        className="mb-1.5 ml-8 mr-2 flex flex-wrap gap-1"
        onClick={(event) => event.stopPropagation()}
      >
        {RUNTIME_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setPreferredRuntimeMode(agent.id, mode)}
            className={cn(
              "max-w-full truncate rounded px-1.5 py-0.5 text-[11px] transition-colors",
              mode === runtimeMode
                ? mode === "full-access"
                  ? "bg-danger-500/15 text-danger-300 ring-1 ring-danger-500/40"
                  : "bg-neutral-700 text-neutral-100 ring-1 ring-neutral-500"
                : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
            )}
            title={RUNTIME_MODE_HINTS[mode]}
          >
            {RUNTIME_MODE_LABELS[mode]}
          </button>
        ))}
      </div>
      ) : null}
      {optionsOpen && managed.length > 0 ? (
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
                  ? "bg-info-500/15 text-info-300 ring-1 ring-info-500/40"
                  : "bg-neutral-800 text-neutral-400 ring-1 ring-transparent hover:bg-neutral-700 hover:text-neutral-200"
              )}
              title={o.label}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {/* Last, below the chips it inherits: resume is a second action on the row,
          not something that changes how the row itself launches. Offered inside
          a project (conversations are scoped to one); the per-agent gate is now
          "this entry has an adapter", which the row's own existence already
          guarantees — chat resumes under the conversation's HOME rather than
          through the launcher's `resumeArgs` (§5.3). */}
      {/* No resolvable model means no launch block, so the resume rows have
          nothing to start either — hidden rather than offered and refused. */}
      {projectPath && chatFields ? (
        <ResumeSection
          agent={agent}
          projectPath={projectPath}
          accountId={launchAccountId}
          model={showModels ? selectedModel : undefined}
          chat={chatFields}
        />
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
  // …and only entries an adapter can actually drive: agent tabs are chat only
  // now (§1), so a catalog row with no `chat` block (the detect-only `deepseek`)
  // has no launch path left and must not be offered one (§5.3).
  const agents = registry.agents
    .filter((a) => canOpenChat(a.id))
    .filter((a) => a.enabled || isProxyLauncher(a.id));
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
          onClick={() =>
            launchWithNotice(
              openTab({ kind: "shell", refId: shell.id, title: shell.name }),
              shell.name
            )
          }
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
        <AgentRow
          key={agent.id}
          agent={agent}
          projectPath={ctx?.kind === "project" ? ctx.project.path : undefined}
        />
      ))}
    </AdaptiveMenu>
  );
};
