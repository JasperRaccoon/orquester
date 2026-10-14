import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { PluginId, PluginInfo } from "@orquester/api";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/relative-time";
import { AdaptiveMenu, Button, ConfirmDialog, DropdownItem, DropdownLabel, Switch } from "../ui";
import { useAppStore } from "../../store/app";
import {
  FIRST_ENABLE_MESSAGE,
  defaultPluginScope,
  filterPlugins,
  pluginControls,
  pluginEnabledIn,
  pluginErrorText,
  pluginJobLabel,
  pluginSourceHref,
  pluginToggleDecision,
  selectedPlugin
} from "./plugins.logic";
import { Badge, EmptyState, InfoRow, Notice, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "./primitives";

/** The letters on each built-in plugin's icon tile. */
const PLUGIN_GLYPH: Record<PluginId, string> = { "ts-rust": "TS" };

/** The daemon's error text for a failed request, else the error's own. */
const errorText = (err: unknown): string => {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
};

type PluginAction = "toggle" | "check" | "rollback" | "remove";

/** A failed action, shown on the plugin it was for. */
interface ActionError {
  pluginId: PluginId;
  title: string;
  detail: string;
}

const ACTION_FAILED: Record<PluginAction, string> = {
  toggle: "Could not change the plugin for this workspace",
  check: "Could not start an update check",
  rollback: "Could not roll back",
  remove: "Could not remove the downloads"
};

const PluginTile: React.FC<{ plugin: PluginInfo; large?: boolean }> = ({ plugin, large }) => (
  <span
    aria-hidden
    className={cn(
      "flex shrink-0 items-center justify-center rounded-lg bg-info-soft/40 font-semibold tracking-tight text-info",
      large ? "h-12 w-12 text-base" : "h-9 w-9 text-xs",
      plugin.platform === "unsupported" && "bg-neutral-800 text-neutral-500"
    )}
  >
    {PLUGIN_GLYPH[plugin.id] ?? <Puzzle size={large ? 20 : 15} />}
  </span>
);

/**
 * Settings → Plugins (spec §6): the built-in plugins, each turned on per
 * workspace. The list and the detail panel act on the workspace in the scope
 * picker; the daemon owns the state, and every change comes back through
 * `plugins.changed`.
 */
export const PluginsSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const plugins = useAppStore((s) => s.plugins);
  const loadPlugins = useAppStore((s) => s.loadPlugins);
  const upsertPlugin = useAppStore((s) => s.upsertPlugin);
  const workspaceList = useAppStore((s) => s.workspaces);
  const activeWorkspace = useAppStore((s) => s.currentProject?.workspace ?? s.currentWorkspace);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pickedScope, setPickedScope] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<PluginId | null>(null);
  const [pending, setPending] = useState<{ pluginId: PluginId; action: PluginAction } | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [confirmEnable, setConfirmEnable] = useState<{ plugin: PluginInfo; workspace: string } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    loadPlugins().catch((err: unknown) => setLoadError(errorText(err)));
  }, [loadPlugins]);

  // On open, on a connection switch and after every reconnect: the broadcast
  // has no replay, so a change made while the stream was down is only seen by
  // reading the list again.
  useEffect(() => {
    if (api && connected) load();
  }, [api, connected, load]);

  const workspaces = useMemo(() => workspaceList.map((w) => w.name), [workspaceList]);
  const scope = defaultPluginScope(workspaces, activeWorkspace, pickedScope);
  const listed = useMemo(() => filterPlugins(plugins ?? [], query), [plugins, query]);
  const selected = selectedPlugin(listed, selectedId);

  const run = async (plugin: PluginInfo, action: PluginAction, request: () => Promise<PluginInfo | null | void>) => {
    setPending({ pluginId: plugin.id, action });
    setActionError(null);
    try {
      const next = await request();
      if (next) upsertPlugin(next);
    } catch (err) {
      setActionError({ pluginId: plugin.id, title: ACTION_FAILED[action], detail: errorText(err) });
    } finally {
      setPending(null);
    }
  };

  const setEnabled = (plugin: PluginInfo, workspace: string, enabled: boolean) => {
    if (!api) return;
    void run(plugin, "toggle", () => api.setPluginWorkspace(plugin.id, workspace, enabled));
  };

  const toggle = (plugin: PluginInfo, enabled: boolean) => {
    setSelectedId(plugin.id);
    const decision = pluginToggleDecision(plugin, scope, enabled);
    if (decision === "blocked" || scope === null) return;
    if (decision === "confirm") {
      setConfirmEnable({ plugin, workspace: scope });
      return;
    }
    setEnabled(plugin, scope, enabled);
  };

  const pendingFor = (plugin: PluginInfo) => (pending?.pluginId === plugin.id ? pending.action : null);

  return (
    <SettingsPage title="Plugins" description="Enable optional features for your Orquester workspaces." wide>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            aria-label="Search workspace plugins"
            placeholder="Search workspace plugins…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Clear first; a second Escape falls through to the modal and closes it.
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                e.nativeEvent.stopImmediatePropagation();
                setQuery("");
              }
            }}
            className={cn(
              "h-8 w-full rounded-md border border-neutral-800 bg-neutral-900 pl-8 pr-7 text-sm text-neutral-100",
              "placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none",
              "[&::-webkit-search-cancel-button]:hidden"
            )}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear plugin search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <ScopePicker workspaces={workspaces} scope={scope} onPick={setPickedScope} />
      </div>

      {workspaces.length === 0 && (
        <Notice tone="info" title="No workspaces yet">
          Plugins are turned on per workspace. Create a workspace to turn one on.
        </Notice>
      )}

      {loadError && (
        <Notice
          tone="danger"
          title="Could not load plugins"
          action={
            <Button size="sm" variant="outline" onClick={load}>
              <RefreshCw size={13} /> Retry
            </Button>
          }
        >
          {loadError}
        </Notice>
      )}

      {plugins === null ? (
        !loadError && (
          <SettingsCard>
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-neutral-500">
              <Loader2 size={14} className="animate-spin" /> Loading plugins…
            </div>
          </SettingsCard>
        )
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
          <SettingsCard>
            {listed.length === 0 ? (
              <EmptyState
                icon={<Puzzle size={18} />}
                title={plugins.length === 0 ? "No plugins" : `No plugins match “${query.trim()}”`}
                description={plugins.length === 0 ? "This server offers no built-in plugins." : undefined}
              />
            ) : (
              <ul aria-label="Plugins" className="divide-y divide-neutral-800/80">
                {listed.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    scope={scope}
                    selected={selected?.id === plugin.id}
                    pending={pendingFor(plugin)}
                    onSelect={() => setSelectedId(plugin.id)}
                    onToggle={(enabled) => toggle(plugin, enabled)}
                  />
                ))}
              </ul>
            )}
          </SettingsCard>

          {selected && (
            <PluginDetail
              plugin={selected}
              scope={scope}
              pending={pendingFor(selected)}
              error={actionError?.pluginId === selected.id ? actionError : null}
              onToggle={(enabled) => toggle(selected, enabled)}
              onCheck={() => api && void run(selected, "check", () => api.checkPluginUpdates(selected.id))}
              onRollback={() => api && void run(selected, "rollback", () => api.rollbackPlugin(selected.id))}
              onRemove={() => api && void run(selected, "remove", () => api.removePluginDownloads(selected.id))}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmEnable !== null}
        title={confirmEnable ? `Turn on ${confirmEnable.plugin.name}?` : ""}
        message={FIRST_ENABLE_MESSAGE}
        confirmLabel="Confirm"
        danger={false}
        onCancel={() => setConfirmEnable(null)}
        onConfirm={() => {
          if (confirmEnable) setEnabled(confirmEnable.plugin, confirmEnable.workspace, true);
          setConfirmEnable(null);
        }}
      />
    </SettingsPage>
  );
};

/** "Scope: <workspace>" — the workspace the toggles act on. */
const ScopePicker: React.FC<{
  workspaces: string[];
  scope: string | null;
  onPick: (workspace: string) => void;
}> = ({ workspaces, scope, onPick }) => {
  const trigger = (
    <span
      className={cn(
        "flex h-8 max-w-64 items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 text-sm",
        scope === null ? "text-neutral-500" : "text-neutral-200"
      )}
    >
      <span className="text-neutral-500">Scope:</span>
      <span className="truncate">{scope ?? "no workspace"}</span>
      <ChevronDown size={13} className="shrink-0 text-neutral-500" />
    </span>
  );
  if (workspaces.length === 0) {
    return trigger;
  }
  return (
    <AdaptiveMenu trigger={trigger} align="right" width="w-56" title="Scope">
      <DropdownLabel>Workspace</DropdownLabel>
      {workspaces.map((name) => (
        <DropdownItem
          key={name}
          icon={name === scope ? <Check size={14} /> : <span className="h-2 w-2" />}
          onClick={() => onPick(name)}
        >
          {name}
        </DropdownItem>
      ))}
    </AdaptiveMenu>
  );
};

/** One list entry: identity, status badge, the toggle for the scope; clicking selects it. */
const PluginRow: React.FC<{
  plugin: PluginInfo;
  scope: string | null;
  selected: boolean;
  pending: PluginAction | null;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}> = ({ plugin, scope, selected, pending, onSelect, onToggle }) => {
  const controls = pluginControls(plugin, scope, pending !== null);
  return (
    <li
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-3 transition-colors",
        selected ? "bg-neutral-800/60" : "hover:bg-neutral-800/30"
      )}
    >
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        aria-label={`Show ${plugin.name}`}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
      >
        <PluginTile plugin={plugin} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-neutral-100">{plugin.name}</span>
            {plugin.platform === "unsupported" ? (
              <Badge>Unavailable</Badge>
            ) : plugin.job === "installing" ? (
              <Badge tone="info" icon={<Loader2 size={10} className="animate-spin" />}>
                Installing…
              </Badge>
            ) : (
              plugin.current && <Badge tone="ok">Installed</Badge>
            )}
          </span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-neutral-500">
            {plugin.description}
          </span>
        </span>
      </button>
      {pending === "toggle" && <Loader2 size={13} className="shrink-0 animate-spin text-neutral-500" />}
      <Switch
        label={scope ? `Enable ${plugin.name} for ${scope}` : `Enable ${plugin.name}`}
        checked={pluginEnabledIn(plugin, scope)}
        disabled={!controls.toggle}
        onChange={onToggle}
      />
      <ChevronRight size={15} aria-hidden className="shrink-0 text-neutral-600" />
    </li>
  );
};

/** The selected plugin: what it is, its installed version and jobs, and its settings for the scope. */
const PluginDetail: React.FC<{
  plugin: PluginInfo;
  scope: string | null;
  pending: PluginAction | null;
  error: ActionError | null;
  onToggle: (enabled: boolean) => void;
  onCheck: () => void;
  onRollback: () => void;
  onRemove: () => void;
}> = ({ plugin, scope, pending, error, onToggle, onCheck, onRollback, onRemove }) => {
  const controls = pluginControls(plugin, scope, pending !== null);
  const jobLabel = pluginJobLabel(plugin.job);
  const sourceHref = pluginSourceHref(plugin.source.url);
  const unsupported = plugin.platform === "unsupported";
  const spinner = (action: PluginAction) =>
    pending === action ? <Loader2 size={13} className="animate-spin" /> : null;

  return (
    <div className="space-y-6">
      <SettingsCard>
        <div className="flex gap-4 px-4 py-4">
          <PluginTile plugin={plugin} large />
          <div className="min-w-0 space-y-1">
            <h3 className="text-base font-semibold text-neutral-100">{plugin.name}</h3>
            <p className="text-sm leading-relaxed text-neutral-400">{plugin.description}</p>
          </div>
        </div>
        <InfoRow
          label="Source"
          value={
            sourceHref ? (
              <a
                href={sourceHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
              >
                {plugin.source.label}
                <ExternalLink size={11} />
              </a>
            ) : (
              plugin.source.label
            )
          }
        />
        <InfoRow label="Provider" value={plugin.provider} />
      </SettingsCard>

      {unsupported && (
        <Notice tone="warn" title="Unavailable on this server">
          There is no build of this plugin for the server's operating system and processor, so it can't be turned
          on there.
        </Notice>
      )}

      {error && (
        <Notice tone="danger" title={error.title}>
          {error.detail}
        </Notice>
      )}

      <SettingsSection title="Status">
        <InfoRow
          label="Version"
          value={
            plugin.current ? (
              <span className="font-mono text-xs">
                v{plugin.current.version}
                {relativeTime(plugin.current.installedAt) && (
                  <span className="font-sans text-neutral-500"> · installed {relativeTime(plugin.current.installedAt)}</span>
                )}
              </span>
            ) : (
              "Not installed"
            )
          }
        />
        <InfoRow
          label="Updates"
          value={
            plugin.lastCheckAt && relativeTime(plugin.lastCheckAt)
              ? `Checked ${relativeTime(plugin.lastCheckAt)}`
              : "Never checked"
          }
        />
        {plugin.skippedVersion && (
          <InfoRow label="Skipped" value={<span className="font-mono text-xs">v{plugin.skippedVersion}</span>} />
        )}
        {jobLabel && (
          <div role="status" className="flex items-center gap-2 px-4 py-2.5 text-sm text-info">
            <Loader2 size={13} className="animate-spin" /> {jobLabel}
          </div>
        )}
        {plugin.lastError && (
          <div className="px-4 py-3">
            <Notice tone="warn" title={`The last update failed ${relativeTime(plugin.lastError.at)}`.trim()}>
              <span className="break-words">{pluginErrorText(plugin.lastError)}</span>
            </Notice>
          </div>
        )}
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Button size="sm" variant="outline" disabled={!controls.checkForUpdates} onClick={onCheck}>
            {spinner("check") ?? <RefreshCw size={13} />} Check for updates
          </Button>
          {controls.showRollback && plugin.previous && (
            <Button size="sm" variant="outline" disabled={!controls.rollback} onClick={onRollback}>
              {spinner("rollback") ?? <RotateCcw size={13} />} Roll back to v{plugin.previous.version}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!controls.removeDownloads}
            title={
              plugin.enabledWorkspaces.length > 0 ? "Turn the plugin off in every workspace first." : undefined
            }
            onClick={onRemove}
          >
            {spinner("remove") ?? <Trash2 size={13} />} Remove downloads
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Settings">
        <SettingRow
          label="Enable for this workspace"
          description={
            scope ? (
              <>
                Allow this plugin to be used in the <span className="text-neutral-300">{scope}</span> workspace.
              </>
            ) : (
              "Create a workspace to turn this plugin on."
            )
          }
        >
          {pending === "toggle" && <Loader2 size={13} className="animate-spin text-neutral-500" />}
          <Switch
            label={scope ? `Enable ${plugin.name} for ${scope}` : `Enable ${plugin.name}`}
            checked={pluginEnabledIn(plugin, scope)}
            disabled={!controls.toggle}
            onChange={onToggle}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
};
