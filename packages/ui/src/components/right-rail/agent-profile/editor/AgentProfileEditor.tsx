/**
 * One opened agent-profile editor (agent profile spec §7.4, §7.5): decides
 * phone or desktop, provides the editor env, guards unsaved changes on
 * Cancel / Escape / the backdrop / Back, and picks the editor the request
 * names — a create by kind, an edit by the loaded item's kind, or the
 * instruction file. A save that lands tells the panel
 * (`notifyAgentProfileEditorSaved`) and closes.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProfileItemDetail, ProfileItemKind, ProfileMutationResponse } from "@orquester/api";

import { useApi } from "../../../../context/orquester-context";
import { useMediaQuery } from "../../../../hooks/use-media-query";
import { useAppStore } from "../../../../store/app";
import { notifyAgentProfileEditorSaved, type AgentProfileEditorRequest } from "../editor-bridge";
import { EditorEnvContext, useEditorEnv, type EditorEnv } from "./env";
import { EditorFrame } from "./EditorFrame";
import { EditorShell } from "./EditorShell";
import { isAbort, profileError } from "./errors";
import { Banner, SmallButton } from "./fields";
import { HookEditor } from "./HookEditor";
import { Progress } from "./ImportSources";
import { InstructionsEditor } from "./InstructionsEditor";
import { agentLabel, EDITOR_PHONE_QUERY, kindTitle, type EditorVariant } from "./layout.logic";
import { MarkdownCreateEditor, MarkdownEditEditor } from "./MarkdownEditor";
import { MarketplaceEditor } from "./MarketplaceEditor";
import { McpEditor } from "./McpEditor";
import { PluginEditor } from "./PluginEditor";

export const AgentProfileEditor: React.FC<{ request: AgentProfileEditorRequest; onClose: () => void }> = ({
  request,
  onClose
}) => {
  const api = useApi();
  const connected = useAppStore((state) => state.connectionStatus === "connected");
  const variant: EditorVariant = useMediaQuery(EDITOR_PHONE_QUERY) ? "phone" : "desktop";
  const [kind, setKind] = useState<ProfileItemKind | null>(request.mode === "create" ? request.kind : null);
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const requestClose = useCallback(() => {
    if (dirty.current) setConfirming(true);
    else closeRef.current();
  }, []);
  const finish = useCallback(
    (response: ProfileMutationResponse) => {
      notifyAgentProfileEditorSaved({ agent: request.agent, itemIds: response.itemIds, notes: response.notes });
      dirty.current = false;
      closeRef.current();
    },
    [request.agent]
  );
  const switchKind = useCallback((next: ProfileItemKind) => {
    dirty.current = false;
    setKind(next);
  }, []);

  const env = useMemo<EditorEnv>(
    () => ({ agent: request.agent, api, variant, connected, requestClose, finish, setDirty, switchKind }),
    [request.agent, api, variant, connected, requestClose, finish, setDirty, switchKind]
  );

  return (
    <EditorFrame
      open
      variant={variant}
      label={editorLabel(request, kind)}
      onRequestClose={requestClose}
      confirmingDiscard={confirming}
      onKeepEditing={() => setConfirming(false)}
      onDiscard={() => {
        setConfirming(false);
        dirty.current = false;
        closeRef.current();
      }}
    >
      <EditorEnvContext.Provider value={env}>
        <EditorBody request={request} kind={kind} />
      </EditorEnvContext.Provider>
    </EditorFrame>
  );
};

function editorLabel(request: AgentProfileEditorRequest, kind: ProfileItemKind | null): string {
  if (request.mode === "instructions") return "Instructions";
  if (request.mode === "edit") return "Edit item";
  return kindTitle("create", kind ?? request.kind);
}

/** What the request opens. Exported for the render checks. */
export const EditorBody: React.FC<{ request: AgentProfileEditorRequest; kind: ProfileItemKind | null }> = ({ request, kind }) => {
  if (request.mode === "instructions") return <InstructionsEditor />;
  if (request.mode === "edit") return <EditLoader itemId={request.itemId} />;
  return <CreateEditor kind={kind ?? request.kind} />;
};

export const CreateEditor: React.FC<{ kind: ProfileItemKind }> = ({ kind }) => {
  switch (kind) {
    case "mcp":
      return <McpEditor />;
    case "skill":
    case "command":
      return <MarkdownCreateEditor key={kind} kind={kind} />;
    case "hook":
      return <HookEditor />;
    case "plugin":
      return <PluginEditor />;
    case "marketplace":
      return <MarketplaceEditor />;
  }
};

export type DetailLoad =
  | { status: "loading" }
  | { status: "error"; message: string; code: string | null }
  | { status: "loaded"; detail: ProfileItemDetail; seq: number };

/** Edit: read the item's editable detail first, then open its kind's editor on it. */
export const EditLoader: React.FC<{ itemId: string; initial?: DetailLoad }> = ({ itemId, initial }) => {
  const { agent, api } = useEditorEnv();
  const [load, setLoad] = useState<DetailLoad>(initial ?? { status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const preset = useRef(initial !== undefined);

  useEffect(() => {
    if (preset.current) {
      preset.current = false;
      return;
    }
    const controller = new AbortController();
    setLoad({ status: "loading" });
    api.getAgentProfileItem(agent, itemId, controller.signal).then(
      (detail) => setLoad({ status: "loaded", detail, seq: attempt }),
      (error) => {
        if (controller.signal.aborted || isAbort(error)) return;
        const info = profileError(error);
        setLoad({ status: "error", message: info.message, code: info.code });
      }
    );
    return () => controller.abort();
  }, [api, agent, itemId, attempt]);

  // "Changed on disk" → Reload: read it again and start the form over from the disk.
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  if (load.status !== "loaded") {
    return (
      <EditorShell title="Edit" primary={null} cancelLabel="Close">
        {load.status === "loading" ? (
          <Progress label="Reading the item…" />
        ) : (
          <Banner
            tone="error"
            title={load.code === "ITEM_NOT_FOUND" ? "It is gone" : "Couldn't read it"}
            actions={load.code === "ITEM_NOT_FOUND" ? undefined : <SmallButton onClick={reload}>Retry</SmallButton>}
          >
            {load.message}
          </Banner>
        )}
      </EditorShell>
    );
  }
  return <DetailEditor key={load.seq} detail={load.detail} onReload={reload} />;
};

export const DetailEditor: React.FC<{ detail: ProfileItemDetail; onReload: () => void }> = ({ detail, onReload }) => {
  if (!detail.item.editable) return <ReadOnlyDetail detail={detail} />;
  switch (detail.kind) {
    case "mcp":
      return <McpEditor detail={detail} onReload={onReload} />;
    case "skill":
    case "command":
      return <MarkdownEditEditor detail={detail} onReload={onReload} />;
    case "hook":
      return <HookEditor detail={detail} onReload={onReload} />;
    default:
      return <ReadOnlyDetail detail={detail} />;
  }
};

/** Plugins and marketplaces are installed and removed, never edited; locked and inherited items belong elsewhere. */
export const ReadOnlyDetail: React.FC<{ detail: ProfileItemDetail }> = ({ detail }) => {
  const rows: [string, string][] = [["Source", detail.item.source.label]];
  if (detail.kind === "plugin") {
    const { plugin } = detail;
    if (plugin.marketplace) rows.push(["Marketplace", plugin.marketplace]);
    if (plugin.version) rows.push(["Version", plugin.version]);
    if (plugin.description) rows.push(["Description", plugin.description]);
    const provides = Object.entries(plugin.provides ?? {})
      .filter(([, count]) => (count ?? 0) > 0)
      .map(([what, count]) => `${count} ${what}`);
    if (provides.length > 0) rows.push(["Provides", provides.join(", ")]);
  } else if (detail.kind === "marketplace") {
    const { source } = detail.marketplace;
    rows.push([
      "From",
      source.type === "github"
        ? `github.com/${source.repo}${source.ref ? ` @ ${source.ref}` : ""}`
        : source.type === "git"
          ? `${source.url}${source.ref ? ` @ ${source.ref}` : ""}`
          : source.path
    ]);
    if (detail.marketplace.pluginCount !== undefined) rows.push(["Plugins", String(detail.marketplace.pluginCount)]);
  }
  if (detail.item.path) rows.push(["Path", detail.item.path]);
  const why = detail.item.locked
    ? "Orquester or the CLI owns this item; it cannot be changed here."
    : detail.kind === "plugin" || detail.kind === "marketplace"
      ? "Installed as a whole: remove it and install again to change it."
      : detail.item.source.ownerAgent
        ? `Edit it from ${agentLabel(detail.item.source.ownerAgent)}'s profile.`
        : "This item is not editable here.";
  return (
    <EditorShell title={detail.item.name} primary={null} cancelLabel="Close">
      <Banner tone="info">{why}</Banner>
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-neutral-500">{label}</dt>
            <dd className="min-w-0 break-words text-neutral-200">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </EditorShell>
  );
};
