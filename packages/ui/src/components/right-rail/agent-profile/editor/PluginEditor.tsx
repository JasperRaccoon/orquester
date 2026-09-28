/**
 * "Install a plugin" (agent profile spec §7.4). Claude, Codex and Grok: pick
 * one of the agent's marketplaces, then a plugin from its catalogue (searchable,
 * the installed ones marked); with no marketplace yet it says so and offers to
 * add one. OpenCode: an npm package or a file path. Plugins are installed and
 * removed, never edited. Rules: `plugin.logic.ts`.
 *
 * Takes an optional `initial` state so a render check can draw every step.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { Search } from "lucide-react";

import type { AgentProfileSnapshot, MarketplacePluginEntry } from "@orquester/api";

import { cn } from "../../../../lib/cn";
import { useEditorEnv, useReportDirty, useTouch } from "./env";
import { EditorShell } from "./EditorShell";
import { isAbort, profileError } from "./errors";
import { Banner, Field, FOCUS_RING, SelectInput, SmallButton, TextInput, describedBy } from "./fields";
import { Progress } from "./ImportSources";
import { agentLabel, kindTitle } from "./layout.logic";
import {
  filterMarketplacePlugins,
  marketplaceNames,
  marketplacePluginDraft,
  OPENCODE_PLUGIN_EXAMPLES,
  pluginInstallMode,
  pluginSpecError,
  specPluginDraft
} from "./plugin.logic";
import { SubmitStatus, useProfileSubmit } from "./use-submit";

export const PluginEditor: React.FC<{ initial?: MarketplaceInstallInitial }> = ({ initial }) => {
  const { agent } = useEditorEnv();
  return pluginInstallMode(agent) === "spec" ? <SpecInstall /> : <MarketplaceInstall initial={initial} />;
};

// ---------------------------------------------------------------------------
// OpenCode: a spec
// ---------------------------------------------------------------------------

export const SpecInstall: React.FC<{ initialSpec?: string; showErrors?: boolean }> = ({ initialSpec = "", showErrors: forceErrors }) => {
  const { agent, api } = useEditorEnv();
  const ids = useId();
  const touch = useTouch();
  const [spec, setSpec] = useState(initialSpec);
  const [showErrors, setShowErrors] = useState(forceErrors ?? false);
  const submit = useProfileSubmit();
  const problem = pluginSpecError(spec);
  const message = showErrors ? problem : undefined;
  useReportDirty(spec.trim() !== "");

  const install = () => {
    if (problem) {
      setShowErrors(true);
      return;
    }
    const plugin = specPluginDraft(spec);
    void submit.run((onConflict) => api.createAgentProfileItem(agent, { draft: { kind: "plugin", plugin }, onConflict }));
  };

  return (
    <EditorShell
      title={kindTitle("create", "plugin")}
      status={<SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} />}
      primary={{ label: "Install", busyLabel: "Installing…", busy: submit.busy, onClick: install }}
    >
      <Field
        id={`${ids}-spec`}
        label="npm package or file path"
        required
        error={message}
        hint="OpenCode installs npm plugins itself at its next start; a .js/.ts file path is loaded as it is."
      >
        <TextInput
          id={`${ids}-spec`}
          mono
          value={spec}
          placeholder="opencode-wakatime"
          autoFocus={!touch}
          invalid={Boolean(message)}
          aria-required
          aria-describedby={describedBy(`${ids}-spec`, message, true)}
          onChange={(event) => {
            setSpec(event.target.value);
            submit.clear();
          }}
        />
      </Field>
      <div className="space-y-1.5">
        <p className="text-xs text-neutral-400">For example</p>
        <div className="flex flex-wrap gap-1.5">
          {OPENCODE_PLUGIN_EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setSpec(example)}
              className={cn(
                "max-w-full truncate rounded-md border border-neutral-700/80 px-2 font-mono text-[12px] text-neutral-300 hover:border-neutral-500 hover:text-neutral-100",
                FOCUS_RING,
                touch ? "h-10" : "h-6"
              )}
            >
              {example}
            </button>
          ))}
        </div>
      </div>
    </EditorShell>
  );
};

// ---------------------------------------------------------------------------
// Claude, Codex, Grok: a marketplace, then a plugin
// ---------------------------------------------------------------------------

type Load<T> = { status: "loading" } | { status: "error"; message: string } | { status: "loaded"; value: T };

export interface MarketplaceInstallInitial {
  snapshot?: Load<AgentProfileSnapshot>;
  marketplace?: string;
  plugins?: Load<MarketplacePluginEntry[]>;
  query?: string;
  selected?: string;
}

export const MarketplaceInstall: React.FC<{ initial?: MarketplaceInstallInitial }> = ({ initial }) => {
  const env = useEditorEnv();
  const { agent, api } = env;
  const ids = useId();
  const [snapshot, setSnapshot] = useState<Load<AgentProfileSnapshot>>(initial?.snapshot ?? { status: "loading" });
  const [marketplace, setMarketplace] = useState<string | null>(initial?.marketplace ?? null);
  const [plugins, setPlugins] = useState<Load<MarketplacePluginEntry[]>>(initial?.plugins ?? { status: "loading" });
  const [query, setQuery] = useState(initial?.query ?? "");
  const [selected, setSelected] = useState<string | null>(initial?.selected ?? null);
  const [attempt, setAttempt] = useState(0);
  const submit = useProfileSubmit();
  const presetSnapshot = useRef(initial?.snapshot !== undefined);
  const presetPlugins = useRef(initial?.plugins !== undefined);
  useReportDirty(false);

  useEffect(() => {
    if (presetSnapshot.current) {
      presetSnapshot.current = false;
      return;
    }
    const controller = new AbortController();
    setSnapshot({ status: "loading" });
    api.getAgentProfile(agent, controller.signal).then(
      (value) => {
        setSnapshot({ status: "loaded", value });
        setMarketplace((current) => current ?? marketplaceNames(value)[0] ?? null);
      },
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setSnapshot({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, agent, attempt]);

  useEffect(() => {
    if (presetPlugins.current) {
      presetPlugins.current = false;
      return;
    }
    if (marketplace === null) return;
    const controller = new AbortController();
    setPlugins({ status: "loading" });
    api.listAgentProfileMarketplacePlugins(agent, marketplace, controller.signal).then(
      (response) => setPlugins({ status: "loaded", value: response.plugins }),
      (error) => {
        if (!controller.signal.aborted && !isAbort(error)) setPlugins({ status: "error", message: profileError(error).message });
      }
    );
    return () => controller.abort();
  }, [api, agent, marketplace, attempt]);

  const names = snapshot.status === "loaded" ? marketplaceNames(snapshot.value) : [];
  const install = () => {
    if (!selected || !marketplace) return;
    const plugin = marketplacePluginDraft(selected, marketplace);
    void submit.run((onConflict) => api.createAgentProfileItem(agent, { draft: { kind: "plugin", plugin }, onConflict }));
  };
  const retry = () => setAttempt((n) => n + 1);

  let body: React.ReactNode;
  if (snapshot.status === "loading") {
    body = <Progress label={`Reading ${agentLabel(agent)}'s marketplaces…`} />;
  } else if (snapshot.status === "error") {
    body = (
      <Banner tone="error" title="Couldn't list the marketplaces" actions={<SmallButton onClick={retry}>Retry</SmallButton>}>
        {snapshot.message}
      </Banner>
    );
  } else if (names.length === 0) {
    body = (
      <Banner
        tone="info"
        title="No marketplaces yet"
        actions={<SmallButton tone="primary" onClick={() => env.switchKind("marketplace")}>Add a marketplace</SmallButton>}
      >
        {agentLabel(agent)} installs plugins from a marketplace — a repository that lists them. Add one first.
      </Banner>
    );
  } else {
    body = (
      <>
        <Field id={`${ids}-marketplace`} label="Marketplace">
          <SelectInput
            id={`${ids}-marketplace`}
            value={marketplace ?? ""}
            options={names.map((name) => ({ value: name, label: name }))}
            onChange={(value) => {
              setMarketplace(value);
              setSelected(null);
              submit.clear();
            }}
          />
        </Field>
        <PluginPicker
          idPrefix={`${ids}-plugin`}
          plugins={plugins}
          query={query}
          onQueryChange={setQuery}
          selected={selected}
          onSelect={(name) => {
            setSelected(name);
            submit.clear();
          }}
          onRetry={retry}
        />
      </>
    );
  }

  return (
    <EditorShell
      title={kindTitle("create", "plugin")}
      status={<SubmitStatus state={submit} onResolveConflict={submit.resolveConflict} onDismiss={submit.clear} />}
      secondary={names.length > 0 ? <SmallButton onClick={() => env.switchKind("marketplace")}>Add a marketplace</SmallButton> : undefined}
      primary={
        snapshot.status === "loaded" && names.length === 0
          ? null
          : {
              label: selected ? `Install ${selected}` : "Install",
              busyLabel: "Installing…",
              busy: submit.busy,
              disabled: selected === null,
              title: selected === null ? "Pick a plugin" : undefined,
              onClick: install
            }
      }
    >
      {body}
    </EditorShell>
  );
};

export const PluginPicker: React.FC<{
  idPrefix: string;
  plugins: Load<MarketplacePluginEntry[]>;
  query: string;
  onQueryChange: (query: string) => void;
  selected: string | null;
  onSelect: (name: string) => void;
  onRetry: () => void;
}> = ({ idPrefix, plugins, query, onQueryChange, selected, onSelect, onRetry }) => {
  const touch = useTouch();
  if (plugins.status === "loading") return <Progress label="Reading the catalogue…" />;
  if (plugins.status === "error") {
    return (
      <Banner tone="error" title="Couldn't read the catalogue" actions={<SmallButton onClick={onRetry}>Retry</SmallButton>}>
        {plugins.message}
      </Banner>
    );
  }
  const shown = filterMarketplacePlugins(plugins.value, query);
  return (
    <div className="min-w-0 space-y-2">
      <div className="relative">
        <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
        <TextInput
          id={`${idPrefix}-search`}
          type="search"
          aria-label="Search plugins"
          placeholder={`Search ${plugins.value.length} plugins`}
          value={query}
          className="pl-8"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              onQueryChange("");
            }
          }}
        />
      </div>
      {plugins.value.length === 0 ? (
        <Banner tone="info">This marketplace lists no plugins.</Banner>
      ) : shown.length === 0 ? (
        <p className="py-4 text-center text-xs text-neutral-500">No plugin matches "{query}".</p>
      ) : (
        <ul
          role="radiogroup"
          aria-label="Plugins"
          className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800"
        >
          {shown.map((plugin, index) => {
            const id = `${idPrefix}-${index}`;
            return (
              <li key={plugin.name}>
                <label
                  htmlFor={id}
                  className={cn(
                    "flex min-w-0 items-start gap-3 px-3",
                    touch ? "min-h-12 py-2.5" : "py-2",
                    plugin.installed ? "cursor-default opacity-60" : "cursor-pointer hover:bg-neutral-800/40",
                    selected === plugin.name && "bg-neutral-800/60"
                  )}
                >
                  <input
                    id={id}
                    type="radio"
                    name={`${idPrefix}-choice`}
                    disabled={plugin.installed}
                    checked={selected === plugin.name}
                    onChange={() => onSelect(plugin.name)}
                    className={cn("mt-0.5 shrink-0 accent-neutral-300", touch ? "h-5 w-5" : "h-4 w-4", FOCUS_RING)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-[13px] text-neutral-100" title={plugin.name}>
                        {plugin.name}
                      </span>
                      {plugin.version ? <span className="shrink-0 text-[11px] text-neutral-500">{plugin.version}</span> : null}
                      {plugin.installed ? (
                        <span className="shrink-0 rounded border border-neutral-700 px-1 text-[10px] text-neutral-400">Installed</span>
                      ) : null}
                    </span>
                    {plugin.description ? (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-neutral-400">{plugin.description}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
