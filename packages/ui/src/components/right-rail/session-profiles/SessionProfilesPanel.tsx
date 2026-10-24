/**
 * The right rail's Agent Profiles panel (agent profiles spec §5.1, §5.2,
 * §5.6): the library, and — a card clicked — that profile's editor in its
 * place (never side by side; the back arrow returns).
 *
 * This is the container: the store (`lib/session-profiles`), which profile is
 * open (the store's, so it outlives a remount), the shown kind per profile
 * (memory), the dialogs (settings / new / rename, the delete confirms) and the
 * item editor. What it draws is `ProfileLibrary` and `ProfileEditorView`.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import { SESSION_PROFILE_WORKFLOW_USES_CHANGED, type SessionProfileDetail, type SessionProfileItem, type SessionProfileItemKind } from "@orquester/api";

import { useApi } from "../../../context/orquester-context";
import { useSessionProfileDetail, useSessionProfileList, useSessionProfilesState } from "../../../lib/session-profiles/hooks";
import { downloadBlob } from "../../../lib/files";
import { openChatsUsingProfile, profileDeleteChatsLine } from "../../../lib/session-profiles/chat-usage";
import { filterProfiles, PROFILE_KIND_LABELS } from "../../../lib/session-profiles/logic";
import {
  createSessionProfile,
  deleteSessionProfile,
  deleteSessionProfileItem,
  dismissSessionProfilesNotice,
  duplicateSessionProfile,
  loadProfileWorkflowUses,
  loadSessionProfile,
  loadSessionProfiles,
  openSessionProfile,
  setSessionProfileItemEnabled,
  setSessionProfilesNotice,
  updateSessionProfile,
  type ProfileWorkflowUsesResult
} from "../../../lib/session-profiles/store";
import { useAppStore } from "../../../store/app";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import type { RightRailPanelProps } from "../types";
import { ProfileEditorView, type ProfileEditorActions } from "./ProfileEditorView";
import type { ProfileImportActionHandlers } from "./ProfileImportActions";
import { exportFileName, SessionProfileImportDialog, type SessionProfileImportRequest } from "./ProfileImportDialog";
import { SessionProfileItemEditor, type SessionProfileEditorRequest } from "./ProfileItemEditor";
import { ProfileLibrary } from "./ProfileLibrary";
import { createRequestFromForm, ProfileSettingsDialog, updatePatchFromForm, type ProfileSettingsForm } from "./ProfileSettingsDialog";

/** How long a saved item stays outlined. */
const HIGHLIGHT_MS = 2_500;

/** The kind tab shown per profile, and the library's search: they outlive a remount. Memory only. */
const remembered: { kinds: Map<string, SessionProfileItemKind>; query: string } = { kinds: new Map(), query: "" };

type SettingsDialog = { mode: "create" } | { mode: "edit"; focusName: boolean } | null;

export const SessionProfilesPanel: React.FC<RightRailPanelProps> = ({ variant }) => {
  const api = useApi();
  const sheet = variant === "sheet";
  const list = useSessionProfileList();
  const { openProfileId, notice, pending } = useSessionProfilesState();
  const entry = useSessionProfileDetail(openProfileId);
  const profile = entry.detail;
  const openSettingsPage = useAppStore((state) => state.openSettings);
  // §5.6: the delete confirmation says how many open chats use the profile.
  const sessions = useAppStore((state) => state.sessions);

  const [query, setQueryState] = useState(remembered.query);
  const setQuery = useCallback((next: string) => {
    remembered.query = next;
    setQueryState(next);
  }, []);
  const [kinds, setKinds] = useState<ReadonlyMap<string, SessionProfileItemKind>>(() => new Map(remembered.kinds));
  const [settings, setSettings] = useState<SettingsDialog>(null);
  const [deletingProfile, setDeletingProfile] = useState(false);
  // The delete guard (spec 2026-10-18 §5.5): the workflows using the profile, read when the
  // confirmation opens (null: still reading); their ids ride the delete as `expectWorkflowUses`.
  const [deleteUses, setDeleteUses] = useState<ProfileWorkflowUsesResult | null>(null);
  const profileIdToDelete = deletingProfile ? (profile?.id ?? null) : null;
  const [usesRead, setUsesRead] = useState(0);
  useEffect(() => {
    if (profileIdToDelete === null) return undefined;
    let live = true;
    setDeleteUses(null);
    void loadProfileWorkflowUses(api, profileIdToDelete).then((result) => {
      if (live) setDeleteUses(result);
    });
    return () => {
      live = false;
    };
  }, [api, profileIdToDelete, usesRead]);
  const [deletingItem, setDeletingItem] = useState<SessionProfileItem | null>(null);
  const [editor, setEditor] = useState<{ key: number; request: SessionProfileEditorRequest } | null>(null);
  const [importing, setImporting] = useState<{ key: number; request: SessionProfileImportRequest } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    if (highlightId === null) return undefined;
    const timer = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const kind: SessionProfileItemKind = (openProfileId !== null ? kinds.get(openProfileId) : undefined) ?? "mcp";
  const pickKind = useCallback(
    (next: SessionProfileItemKind) => {
      if (openProfileId === null) return;
      remembered.kinds.set(openProfileId, next);
      setKinds(new Map(remembered.kinds));
    },
    [openProfileId]
  );

  const shown = useMemo(() => filterProfiles(list.profiles ?? [], query), [list.profiles, query]);
  const summary = list.profiles?.find((candidate) => candidate.id === openProfileId) ?? null;

  const openEditor = useCallback((request: SessionProfileEditorRequest) => {
    setEditor((current) => ({ key: (current?.key ?? 0) + 1, request }));
  }, []);
  const openImport = useCallback((request: SessionProfileImportRequest) => {
    setImporting((current) => ({ key: (current?.key ?? 0) + 1, request }));
  }, []);

  const importActions = useMemo<ProfileImportActionHandlers>(
    () => ({
      importFromGlobal: (target, itemKind) => openImport({ mode: "global", profileId: target.id, kind: itemKind }),
      importFromGit: (target, itemKind) => openImport({ mode: "git", profileId: target.id, kind: itemKind }),
      importFromZip: (target, itemKind) => openImport({ mode: "zip", profileId: target.id, kind: itemKind }),
      copyFromProfile: (target, itemKind) => openImport({ mode: "copy", profileId: target.id, kind: itemKind }),
      addPlugin: (target) => openImport({ mode: "plugin", profileId: target.id })
    }),
    [openImport]
  );

  const submitSettings = useCallback(
    async (form: ProfileSettingsForm, base: SessionProfileDetail | null): Promise<string | null> => {
      if (settings?.mode === "create") {
        const result = await createSessionProfile(api, createRequestFromForm(form));
        if (!result.ok) return result.error;
        setSettings(null);
        if (result.profile !== null) openSessionProfile(result.profile.id);
        else void loadSessionProfiles(api, { force: true });
        return null;
      }
      if (profile === null) return "The profile is not loaded.";
      // Against what the form was filled from: a field changed elsewhere meanwhile is left alone.
      const patch = updatePatchFromForm(base ?? profile, form);
      if (Object.keys(patch).length === 0) {
        setSettings(null);
        return null;
      }
      const result = await updateSessionProfile(api, profile.id, patch);
      if (!result.ok) {
        // The store said it in the panel's notice too; the dialog keeps the form.
        dismissSessionProfilesNotice();
        return result.code === "PROFILE_CONFLICT"
          ? "This profile was changed elsewhere and has been reloaded — reopen the settings to edit it again."
          : result.error;
      }
      setSettings(null);
      return null;
    },
    [api, profile, settings]
  );

  const actions = useMemo<ProfileEditorActions>(
    () => ({
      back: () => openSessionProfile(null),
      openSettings: () => setSettings({ mode: "edit", focusName: false }),
      rename: () => setSettings({ mode: "edit", focusName: true }),
      duplicate: () => {
        if (openProfileId === null) return;
        void duplicateSessionProfile(api, openProfileId).then((result) => {
          if (result.ok && result.profile !== null) {
            openSessionProfile(result.profile.id);
            setSessionProfilesNotice({ tone: "ok", text: `Duplicated as ${result.profile.name}.` });
          }
        });
      },
      exportProfile: () => {
        if (openProfileId === null) return;
        const name = profile?.name ?? summary?.name ?? "profile";
        void api.exportSessionProfile(openProfileId).then(
          (bytes) => {
            downloadBlob(exportFileName(name), new Blob([bytes], { type: "application/zip" }));
            setSessionProfilesNotice({ tone: "ok", text: `Exported ${name}. MCP secret values are not in the file.` });
          },
          (error: unknown) =>
            setSessionProfilesNotice({ tone: "error", text: `Export failed: ${error instanceof Error ? error.message : String(error)}` })
        );
      },
      remove: () => {
        setDeleteUses(null);
        setDeletingProfile(true);
      },
      openInstructions: () => {
        if (openProfileId !== null) openEditor({ mode: "instructions", profileId: openProfileId });
      },
      add: (itemKind) => {
        if (openProfileId !== null) openEditor({ mode: "create", profileId: openProfileId, kind: itemKind });
      },
      toggle: (item, enabled) => {
        if (openProfileId !== null) void setSessionProfileItemEnabled(api, openProfileId, item, enabled);
      },
      edit: (item) => {
        if (openProfileId !== null) openEditor({ mode: "edit", profileId: openProfileId, itemId: item.id });
      },
      removeItem: (item) => setDeletingItem(item),
      retry: () => {
        if (openProfileId !== null) void loadSessionProfile(api, openProfileId, { force: true });
      },
      dismissNotice: dismissSessionProfilesNotice
    }),
    [api, openEditor, openProfileId, profile?.name, summary?.name]
  );

  return (
    <>
      {openProfileId === null ? (
        <ProfileLibrary
          sheet={sheet}
          profiles={list.profiles}
          shown={shown}
          errors={list.errors}
          loadError={list.error}
          query={query}
          onQueryChange={setQuery}
          notice={notice}
          onDismissNotice={dismissSessionProfilesNotice}
          onNew={() => setSettings({ mode: "create" })}
          onImportFile={() => openImport({ mode: "import-profile" })}
          onOpen={(id) => openSessionProfile(id)}
          onOpenAgentConfig={() => openSettingsPage("agent-config")}
          onRetry={() => void loadSessionProfiles(api, { force: true })}
        />
      ) : (
        <ProfileEditorView
          sheet={sheet}
          profile={profile}
          fallback={summary ? { name: summary.name, ...(summary.icon !== undefined ? { icon: summary.icon } : {}) } : null}
          loadError={entry.error}
          kind={kind}
          onKindChange={pickKind}
          pendingIds={pending}
          highlightId={highlightId}
          notice={notice}
          actions={actions}
          importActions={importActions}
        />
      )}

      <ProfileSettingsDialog
        open={settings !== null}
        mode={settings?.mode ?? "edit"}
        profile={settings?.mode === "edit" ? profile : null}
        focusName={settings?.mode === "edit" && settings.focusName}
        sheet={sheet}
        onCancel={() => setSettings(null)}
        onSubmit={submitSettings}
      />

      <ConfirmDialog
        open={deletingProfile && profile !== null}
        title="Delete profile"
        message={
          <>
            Delete <span className="font-medium text-neutral-200">{profile?.name}</span> and everything in it?{" "}
            {profileDeleteChatsLine(profile !== null ? openChatsUsingProfile(sessions, profile.id) : 0)}
            <ProfileDeleteWorkflows uses={deleteUses} />
          </>
        }
        confirmLabel={deleteUses?.ok === true && deleteUses.workflows.length > 0 ? "Delete anyway" : "Delete"}
        confirmDisabled={deleteUses === null}
        onCancel={() => setDeletingProfile(false)}
        onConfirm={() => {
          const target = profile;
          const uses = deleteUses;
          if (target === null || uses === null) return;
          // Known uses ride the delete: should they change before it lands, the daemon refuses and
          // the confirmation comes back with the new list. Unknown ones (or a failed read) are not
          // a precondition anyone could meet: the user confirmed without the list.
          const expectWorkflowUses = uses.ok && !uses.unknown ? uses.workflows.map((use) => use.workflowId) : undefined;
          setDeletingProfile(false);
          void deleteSessionProfile(api, target.id, expectWorkflowUses !== undefined ? { expectWorkflowUses } : {}).then((result) => {
            if (!result.ok && result.code === SESSION_PROFILE_WORKFLOW_USES_CHANGED) {
              setDeleteUses(null);
              setUsesRead((n) => n + 1);
              setDeletingProfile(true);
            }
          });
        }}
      />

      <ConfirmDialog
        open={deletingItem !== null}
        title={`Delete ${deletingItem ? PROFILE_KIND_LABELS[deletingItem.kind].one : "item"}`}
        message={
          <>
            Delete <span className="font-medium text-neutral-200">{deletingItem?.name}</span> from {profile?.name ?? "this profile"}?
            New chats with the profile no longer load it.
          </>
        }
        confirmLabel="Delete"
        onCancel={() => setDeletingItem(null)}
        onConfirm={() => {
          const item = deletingItem;
          setDeletingItem(null);
          if (item !== null && openProfileId !== null) void deleteSessionProfileItem(api, openProfileId, item);
        }}
      />

      {importing !== null ? (
        <SessionProfileImportDialog
          key={importing.key}
          request={importing.request}
          profileName={profile?.name ?? summary?.name ?? "Profile"}
          onClose={() => setImporting((current) => (current?.key === importing.key ? null : current))}
          onImported={(itemIds) => {
            const first = itemIds[0];
            if (first === undefined) return;
            const added = profile?.items.find((item) => item.id === first) ?? null;
            if (added !== null) pickKind(added.kind);
            setHighlightId(first);
          }}
        />
      ) : null}

      {editor !== null ? (
        <SessionProfileItemEditor
          key={editor.key}
          request={editor.request}
          profileName={profile?.name ?? summary?.name ?? "Profile"}
          onClose={() => setEditor((current) => (current?.key === editor.key ? null : current))}
          onSaved={(itemId) => {
            if (itemId === null) return;
            const saved = profile?.items.find((item) => item.id === itemId) ?? null;
            if (saved !== null) pickKind(saved.kind);
            else if (editor.request.mode === "create") pickKind(editor.request.kind);
            setHighlightId(itemId);
          }}
        />
      ) : null}
    </>
  );
};

/** The delete confirmation's workflows line: which workflows' agent blocks launch with the profile. */
const ProfileDeleteWorkflows: React.FC<{ uses: ProfileWorkflowUsesResult | null }> = ({ uses }) => {
  if (uses === null) {
    return (
      <span className="mt-2 block" data-profile-delete-workflows="loading">
        Checking which workflows use it…
      </span>
    );
  }
  if (!uses.ok) {
    return (
      <span className="mt-2 block text-warn" data-profile-delete-workflows="error">
        Could not check which workflows use it ({uses.error}). Workflows that do will fail until another profile is picked.
      </span>
    );
  }
  if (uses.workflows.length === 0) {
    return uses.unknown ? (
      <span className="mt-2 block text-warn" data-profile-delete-workflows="unknown">
        Orquester cannot tell which workflows use it. Workflows that do will fail until another profile is picked.
      </span>
    ) : (
      <span className="mt-2 block" data-profile-delete-workflows="none">
        No workflow uses it.
      </span>
    );
  }
  const count = uses.workflows.length;
  return (
    <span className="mt-2 block text-warn" data-profile-delete-workflows="used">
      {count === 1 ? "1 workflow launches" : `${count} workflows launch`} agents with it; {count === 1 ? "its runs fail" : "their runs fail"} until
      another profile is picked{uses.unknown ? " (there may be more)" : ""}:
      <span className="mt-1 block">
        {uses.workflows.map((use) => (
          <span key={use.workflowId} className="block font-medium text-neutral-200" data-profile-delete-workflow={use.workflowId}>
            {use.name}
            {use.workspace ? <span className="font-normal text-neutral-500"> · {use.workspace}</span> : null}
          </span>
        ))}
      </span>
    </span>
  );
};
