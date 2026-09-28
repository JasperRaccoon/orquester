/**
 * The right rail's Agent profile panel (agent profile spec §7): each agent
 * CLI's global MCP servers, skills, plugins, marketplaces, hooks, commands and
 * instruction file — listed, turned on and off, copied between agents and
 * deleted here; created and edited in the editor (`AgentProfileEditorHost`,
 * opened through `editor-bridge.ts`).
 *
 * This is the container: the store (`lib/agent-profile`), which agent is
 * shown (`default-agent.ts`), the editor bridge, the confirms (a dialog
 * docked, the row itself on a phone) and the copy's name-collision question.
 * What it draws is `AgentProfilePanelView`. The kind filter outlives a
 * remount (module memory); the last picked agent is the store's (persisted).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import {
  AGENT_PROFILE_AGENT_LABELS,
  AGENT_PROFILE_CREATABLE_KINDS,
  PROFILE_ITEM_KIND_LABELS,
  type AgentProfileAgentId,
  type ProfileConflictPolicy,
  type ProfileItem,
  type ProfileItemKind
} from "@orquester/api";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";

import { useApi } from "../../../context/orquester-context";
import { providersStore } from "../../../lib/agent-chat/providers";
import { useAgentProfile } from "../../../lib/agent-profile/hooks";
import {
  agentProfileStore,
  copyAgentProfileItem,
  dismissAgentProfileNotice,
  lastAgentProfileAgent,
  loadAgentProfile,
  rememberAgentProfileAgent,
  removeAgentProfileItem,
  setAgentProfileItemEnabled,
  setAgentProfileNotice,
  trustAgentProfileItem
} from "../../../lib/agent-profile/store";
import { copyText } from "../../../lib/clipboard";
import { useAppStore } from "../../../store/app";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Modal } from "../../ui/modal";
import type { RightRailPanelProps } from "../types";
import { AgentProfilePanelView, type ProfileItemActions } from "./AgentProfilePanelView";
import { agentForRefId, defaultAgentProfileAgent } from "./default-agent";
import {
  openAgentProfileEditor,
  subscribeAgentProfileEditorSaved,
  type AgentProfileEditorRequest
} from "./editor-bridge";
import {
  agentProfileAgentOptions,
  agentProfileEmptyState,
  copyTargets,
  effectiveKindFilter,
  filterProfileItems,
  groupProfileItems,
  isAgentNotInstalled,
  profileKindChips,
  type ProfileKindFilter
} from "./list.logic";
import type { ProfileRowConfirm } from "./ProfileItemRow";

/** The kind filter outlives a remount (the rail closing, a phone's section). Memory only. */
const remembered: { kind: ProfileKindFilter } = { kind: "all" };

/** How long a saved item stays outlined. */
const HIGHLIGHT_MS = 2_500;

const NO_EDITOR_NOTICE = "The editor is not available in this window yet — reload to get it.";

/** The agent the visible chat tab talks to, or `null` (no chat on screen, or one this panel has no agent for). */
function useChatAgent(sessionId: string | null): AgentProfileAgentId | null {
  const refId = useAppStore((state) =>
    sessionId === null ? null : (state.sessions.find((session) => session.id === sessionId)?.refId ?? null)
  );
  const providers = useStore(providersStore, (state) => state.providers);
  return useMemo(
    () => agentForRefId(refId, providers, REGISTRY.agents as readonly RegistryEntryDef[]),
    [refId, providers]
  );
}

/** A clock for "edited 2h ago": once a minute is plenty. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

type Confirming = ({ itemId: string; item: ProfileItem } & ProfileRowConfirm) | null;

export const AgentProfilePanel: React.FC<RightRailPanelProps> = ({ sessionId, variant }) => {
  const api = useApi();
  const chatAgent = useChatAgent(sessionId);
  const overviewAgents = useStore(agentProfileStore, (state) => state.overview.agents);
  const entries = useStore(agentProfileStore, (state) => state.agents);
  const agents = useMemo(
    () =>
      agentProfileAgentOptions(overviewAgents, {
        claude: entries.claude.snapshot,
        codex: entries.codex.snapshot,
        grok: entries.grok.snapshot,
        opencode: entries.opencode.snapshot
      }),
    [overviewAgents, entries]
  );
  const installedOf = useCallback(
    (agent: AgentProfileAgentId) => agents.find((option) => option.id === agent)?.installed ?? null,
    [agents]
  );

  // Until the user picks, the panel follows the visible chat tab (spec §7.3).
  const [picked, setPicked] = useState<AgentProfileAgentId | null>(null);
  const agent =
    picked ?? defaultAgentProfileAgent({ chatAgent, remembered: lastAgentProfileAgent(), installed: installedOf });
  const view = useAgentProfile(agent);
  const { snapshot, status, error, errorCode } = view.entry;

  const [query, setQuery] = useState("");
  const [kindState, setKindState] = useState<ProfileKindFilter>(() => remembered.kind);
  const kind = effectiveKindFilter(agent, kindState);
  const [pendingDelete, setPendingDelete] = useState<ProfileItem | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [conflict, setConflict] = useState<{ item: ProfileItem; toAgent: AgentProfileAgentId } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const now = useMinuteClock();
  const sheet = variant === "sheet";

  const setKind = useCallback((next: ProfileKindFilter) => {
    remembered.kind = next;
    setKindState(next);
  }, []);

  const pick = useCallback((next: AgentProfileAgentId) => {
    setPicked(next);
    rememberAgentProfileAgent(next);
    setConfirming(null);
  }, []);

  const openEditor = useCallback((request: AgentProfileEditorRequest) => {
    if (!openAgentProfileEditor(request)) setAgentProfileNotice({ tone: "error", text: NO_EDITOR_NOTICE });
  }, []);

  // What the editor saved: its notes as the notice, and the item revealed —
  // the filter cleared so it shows, scrolled to and outlined for a moment.
  useEffect(
    () =>
      subscribeAgentProfileEditorSaved((saved) => {
        setAgentProfileNotice({
          tone: "ok",
          text: saved.notes.length > 0 ? saved.notes.join(" ") : "Saved — applies to new sessions."
        });
        void loadAgentProfile(api, saved.agent, { force: true });
        if (saved.agent !== agent) return;
        setQuery("");
        setKind("all");
        setHighlightId(saved.itemIds[0] ?? null);
      }),
    [agent, api, setKind]
  );

  useEffect(() => {
    if (highlightId === null) return undefined;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const items = useMemo(() => snapshot?.items ?? [], [snapshot]);
  const filtered = useMemo(() => filterProfileItems(items, { kind, query }), [items, kind, query]);
  const groups = useMemo(() => groupProfileItems(agent, filtered), [agent, filtered]);
  const chips = useMemo(() => profileKindChips(agent, items), [agent, items]);

  // Scroll the saved item into view once it is listed (it may arrive with the reload).
  useEffect(() => {
    if (highlightId === null) return;
    const list = listRef.current;
    if (list === null) return;
    for (const row of list.querySelectorAll<HTMLElement>("[data-profile-item]")) {
      if (row.getAttribute("data-profile-item") === highlightId) {
        row.scrollIntoView?.({ block: "nearest" });
        return;
      }
    }
  }, [highlightId, groups]);

  const notInstalled = isAgentNotInstalled({ snapshot, errorCode, overviewInstalled: installedOf(agent) });
  const empty = agentProfileEmptyState({
    agent,
    status,
    snapshot,
    error,
    notInstalled,
    kind,
    query,
    shown: filtered.length
  });

  const pendingIds = useMemo(() => {
    const prefix = `${agent}\n`;
    const ids = new Set<string>();
    for (const key of view.pending) if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    return ids;
  }, [agent, view.pending]);

  const copyTo = useCallback(
    async (item: ProfileItem, toAgent: AgentProfileAgentId, onConflict?: ProfileConflictPolicy) => {
      const result = await copyAgentProfileItem(api, agent, item, toAgent, onConflict);
      if (!result.ok && result.code === "ITEM_EXISTS" && onConflict === undefined) {
        // The name is taken there: Replace / Keep both / Cancel.
        if (sheet) setConfirming({ itemId: item.id, item, kind: "conflict", toAgent });
        else setConflict({ item, toAgent });
      }
    },
    [agent, api, sheet]
  );

  const confirmDelete = useCallback(() => {
    const target = sheet ? (confirming?.kind === "delete" ? confirming.item : null) : pendingDelete;
    setPendingDelete(null);
    setConfirming(null);
    if (target !== null) void removeAgentProfileItem(api, agent, target);
  }, [agent, api, confirming, pendingDelete, sheet]);

  const resolveConflict = useCallback(
    (policy: ProfileConflictPolicy) => {
      const target =
        sheet && confirming?.kind === "conflict"
          ? { item: confirming.item, toAgent: confirming.toAgent }
          : conflict;
      setConfirming(null);
      setConflict(null);
      if (target !== null) void copyTo(target.item, target.toAgent, policy);
    },
    [confirming, conflict, copyTo, sheet]
  );

  const actions = useMemo<ProfileItemActions>(
    () => ({
      toggle: (item, enabled) => void setAgentProfileItemEnabled(api, agent, item, enabled),
      edit: (item) => openEditor({ mode: "edit", agent, itemId: item.id }),
      copyTo: (item, toAgent) => void copyTo(item, toAgent),
      copyPath: (item) => {
        if (item.path === undefined) return;
        const path = item.path;
        void copyText(path).then(() => setAgentProfileNotice({ tone: "ok", text: `Copied ${path}` }));
      },
      remove: (item) => {
        if (sheet) setConfirming({ itemId: item.id, item, kind: "delete" });
        else setPendingDelete(item);
      },
      trust: (item) => void trustAgentProfileItem(api, agent, item),
      manageIn: pick,
      confirmRemove: confirmDelete,
      resolveConflict,
      cancelConfirm: () => setConfirming(null)
    }),
    [agent, api, confirmDelete, copyTo, openEditor, pick, resolveConflict, sheet]
  );

  const copyTargetsFor = useCallback(
    (item: ProfileItem) => copyTargets(item, agent, installedOf),
    [agent, installedOf]
  );

  const creatableKinds: readonly ProfileItemKind[] = AGENT_PROFILE_CREATABLE_KINDS[agent];

  return (
    <>
      <AgentProfilePanelView
        variant={variant}
        agent={agent}
        agents={agents}
        onAgentChange={pick}
        query={query}
        onQueryChange={setQuery}
        kind={kind}
        onKindChange={setKind}
        chips={chips}
        snapshot={snapshot}
        groups={groups}
        empty={empty}
        loadError={snapshot !== null ? error : null}
        onRetry={() => void loadAgentProfile(api, agent, { force: true })}
        notice={view.notice}
        onDismissNotice={dismissAgentProfileNotice}
        now={now}
        pendingIds={pendingIds}
        highlightId={highlightId}
        confirming={sheet && confirming !== null ? confirming : null}
        copyTargetsFor={copyTargetsFor}
        actions={actions}
        onOpenInstructions={() => openEditor({ mode: "instructions", agent })}
        creatableKinds={creatableKinds}
        onAdd={(itemKind) => openEditor({ mode: "create", agent, kind: itemKind })}
        listRef={listRef}
      />
      <ConfirmDialog
        open={!sheet && pendingDelete !== null}
        title={`Delete ${pendingDelete ? PROFILE_ITEM_KIND_LABELS[pendingDelete.kind].one.toLowerCase().replace(/^mcp/, "MCP") : "item"}`}
        message={
          <>
            Delete <span className="font-medium text-neutral-200">{pendingDelete?.name}</span> from{" "}
            {AGENT_PROFILE_AGENT_LABELS[agent]}? It is removed from the agent's own files for every account; a backup
            is kept.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
      <CopyConflictDialog
        open={!sheet && conflict !== null}
        name={conflict?.item.name ?? ""}
        target={conflict ? AGENT_PROFILE_AGENT_LABELS[conflict.toAgent] : ""}
        onResolve={resolveConflict}
        onCancel={() => setConflict(null)}
      />
    </>
  );
};

/** A copy's name is taken on the target agent: Replace, Keep both (the copy renamed), or Cancel. */
const CopyConflictDialog: React.FC<{
  open: boolean;
  name: string;
  target: string;
  onResolve: (policy: ProfileConflictPolicy) => void;
  onCancel: () => void;
}> = ({ open, name, target, onResolve, onCancel }) => (
  <Modal open={open} onClose={onCancel} className="max-w-sm">
    <div className="w-full p-5">
      <p className="mb-2 text-sm font-medium text-neutral-100">
        {target} already has {name}
      </p>
      <p className="text-sm text-neutral-400">
        Replace {target}'s <span className="text-neutral-200">{name}</span> with this one, or keep both — the copy then
        gets a new name.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={() => onResolve("keep-both")}>
          Keep both
        </Button>
        <Button size="sm" onClick={() => onResolve("replace")}>
          Replace
        </Button>
      </div>
    </div>
  </Modal>
);
