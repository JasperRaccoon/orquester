import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ExternalLink,
  Loader2,
  PenTool,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { PluginId, PluginInfo, TsCheckerEngine } from "@orquester/api";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/relative-time";
import { Button, ConfirmDialog, Switch } from "../ui";
import { useAppStore } from "../../store/app";
import {
  FIRST_ENABLE_MESSAGE,
  filterPlugins,
  pluginControls,
  pluginEngineChange,
  pluginEngineLabel,
  pluginEngineOptions,
  pluginErrorText,
  pluginJobLabel,
  pluginSourceHref,
  pluginToggleDecision,
  selectedPlugin
} from "./plugins.logic";
import { Badge, EmptyState, InfoRow, Notice, SettingRow, SettingsCard, SettingsPage, SettingsSection } from "./primitives";

/** What each built-in plugin's icon tile shows. */
const PLUGIN_GLYPH: Record<PluginId, React.ReactNode> = { "ts-rust": "TS", excalidraw: <PenTool size={15} /> };

/** The daemon's error text for a failed request, else the error's own. */
const errorText = (err: unknown): string => {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : "The request failed.";
};

type PluginAction = "toggle" | "engine" | "check" | "rollback" | "remove";

/** A failed action, shown on the plugin it was for. */
interface ActionError {
  pluginId: PluginId;
  title: string;
  detail: string;
}

const ACTION_FAILED: Record<PluginAction, string> = {
  toggle: "Could not change the plugin",
  engine: "Could not change the engine",
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
 * Settings → Plugins (spec §6): the built-in plugins, each turned on once for
 * the whole server. The daemon owns the state, and every change comes back
 * through `plugins.changed`.
 */
export const PluginsSettings: React.FC = () => {
  const api = useAppStore((s) => s.api);
  const connected = useAppStore((s) => s.connectionStatus === "connected");
  const plugins = useAppStore((s) => s.plugins);
  const loadPlugins = useAppStore((s) => s.loadPlugins);
  const upsertPlugin = useAppStore((s) => s.upsertPlugin);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<PluginId | null>(null);
  const [pending, setPending] = useState<{ pluginId: PluginId; action: PluginAction } | null>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);
  const [confirmEnable, setConfirmEnable] = useState<PluginInfo | null>(null);

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

  const listed = useMemo(() => filterPlugins(plugins ?? [], query), [plugins, query]);
  const selected = selectedPlugin(listed, selectedId);

  const run = async (plugin: PluginInfo, action: PluginAction, request: () => Promise<PluginInfo | null | void>) => {
    const requestedOn = useAppStore.getState().api;
    setPending({ pluginId: plugin.id, action });
    setActionError(null);
    try {
      const next = await request();
      // An answer from the previous connection's daemon is not this one's state.
      if (next && useAppStore.getState().api === requestedOn) upsertPlugin(next);
    } catch (err) {
      if (useAppStore.getState().api !== requestedOn) return;
      setActionError({ pluginId: plugin.id, title: ACTION_FAILED[action], detail: errorText(err) });
    } finally {
      setPending(null);
    }
  };

  const setEnabled = (plugin: PluginInfo, enabled: boolean) => {
    if (!api) return;
    void run(plugin, "toggle", () => api.setPluginEnabled(plugin.id, enabled));
  };

  const chooseEngine = (plugin: PluginInfo, engine: TsCheckerEngine) => {
    if (!api || !pluginEngineChange(plugin, engine, pending?.pluginId === plugin.id)) return;
    void run(plugin, "engine", () => api.setPluginEngine(plugin.id, engine));
  };

  const toggle = (plugin: PluginInfo, enabled: boolean) => {
    setSelectedId(plugin.id);
    const decision = pluginToggleDecision(plugin, enabled);
    if (decision === "blocked") return;
    if (decision === "confirm") {
      setConfirmEnable(plugin);
      return;
    }
    setEnabled(plugin, enabled);
  };

  const pendingFor = (plugin: PluginInfo) => (pending?.pluginId === plugin.id ? pending.action : null);

  return (
    <SettingsPage title="Plugins" description="Enable optional features for this Orquester server." wide>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input
            type="search"
            aria-label="Search plugins"
            placeholder="Search plugins…"
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
      </div>

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
              pending={pendingFor(selected)}
              error={actionError?.pluginId === selected.id ? actionError : null}
              onToggle={(enabled) => toggle(selected, enabled)}
              onEngine={(engine) => chooseEngine(selected, engine)}
              onCheck={() => api && void run(selected, "check", () => api.checkPluginUpdates(selected.id))}
              onRollback={() => api && void run(selected, "rollback", () => api.rollbackPlugin(selected.id))}
              onRemove={() => api && void run(selected, "remove", () => api.removePluginDownloads(selected.id))}
            />
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmEnable !== null}
        title={confirmEnable ? `Turn on ${confirmEnable.name}?` : ""}
        message={FIRST_ENABLE_MESSAGE}
        confirmLabel="Confirm"
        danger={false}
        onCancel={() => setConfirmEnable(null)}
        onConfirm={() => {
          if (confirmEnable) setEnabled(confirmEnable, true);
          setConfirmEnable(null);
        }}
      />
    </SettingsPage>
  );
};

/** One list entry: identity, status badge, the toggle; clicking selects it. */
const PluginRow: React.FC<{
  plugin: PluginInfo;
  selected: boolean;
  pending: PluginAction | null;
  onSelect: () => void;
  onToggle: (enabled: boolean) => void;
}> = ({ plugin, selected, pending, onSelect, onToggle }) => {
  const controls = pluginControls(plugin, pending !== null);
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
            ) : !plugin.updates ? (
              <Badge>Built in</Badge>
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
        label={`Enable ${plugin.name}`}
        checked={plugin.enabled}
        disabled={!controls.toggle}
        onChange={onToggle}
      />
      <ChevronRight size={15} aria-hidden className="shrink-0 text-neutral-600" />
    </li>
  );
};

/** The selected plugin: what it is, its installed version and jobs, and its settings. */
const PluginDetail: React.FC<{
  plugin: PluginInfo;
  pending: PluginAction | null;
  error: ActionError | null;
  onToggle: (enabled: boolean) => void;
  onEngine: (engine: TsCheckerEngine) => void;
  onCheck: () => void;
  onRollback: () => void;
  onRemove: () => void;
}> = ({ plugin, pending, error, onToggle, onEngine, onCheck, onRollback, onRemove }) => {
  const controls = pluginControls(plugin, pending !== null);
  const engineOptions = pluginEngineOptions(plugin, pending !== null);
  const engineLabel = pluginEngineLabel(plugin);
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

      {plugin.updates && (
        <SettingsSection title="Status">
          <InfoRow
            label="Version"
            value={
              plugin.current ? (
                <span className="font-mono text-xs">
                  {engineLabel && <span className="font-sans text-neutral-400">{engineLabel} </span>}
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
              title={plugin.enabled ? "Turn the plugin off first." : undefined}
              onClick={onRemove}
            >
              {spinner("remove") ?? <Trash2 size={13} />} Remove downloads
            </Button>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Settings">
        <SettingRow
          label="Enable on this server"
          description={
            plugin.updates
              ? "Turn this plugin on for every workspace and project. The server downloads it and keeps it up to date."
              : "Turn this plugin on for every workspace and project. It ships with Orquester, so there is nothing to download."
          }
        >
          {pending === "toggle" && <Loader2 size={13} className="animate-spin text-neutral-500" />}
          <Switch
            label={`Enable ${plugin.name}`}
            checked={plugin.enabled}
            disabled={!controls.toggle}
            onChange={onToggle}
          />
        </SettingRow>
        {engineOptions.length > 0 && (
          <SettingRow
            label="Engine"
            description="The TypeScript 7 port that runs in place of tsc. Only one is used at a time; switching downloads it if needed."
            stacked
          >
            <div role="radiogroup" aria-label="Engine" className="grid gap-2 sm:grid-cols-2">
              {engineOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={option.selected}
                  disabled={option.disabled}
                  title={option.hint ?? undefined}
                  onClick={() => onEngine(option.id)}
                  className={cn(
                    "flex min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                    option.selected
                      ? "border-info/60 bg-info-soft/20"
                      : "border-neutral-800 bg-neutral-900 enabled:hover:border-neutral-600",
                    option.disabled && !option.selected && "cursor-not-allowed opacity-60"
                  )}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
                    {option.label}
                    {pending === "engine" && option.selected && <Loader2 size={12} className="animate-spin text-neutral-500" />}
                  </span>
                  <span className="text-xs leading-relaxed text-neutral-500">{option.description}</span>
                  {option.hint && <span className="text-xs leading-relaxed text-warn">{option.hint}</span>}
                </button>
              ))}
            </div>
          </SettingRow>
        )}
      </SettingsSection>
    </div>
  );
};
