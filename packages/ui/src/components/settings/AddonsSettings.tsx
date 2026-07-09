import React, { useCallback, useEffect, useState } from "react";
import { Download, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { TeamClaudeStatus } from "@orquester/api";
import { cn } from "../../lib/cn";
import { Button, Input, Switch } from "../ui";
import { useApi } from "../../context/orquester-context";

/** Very small markdown subset for the bundled TeamClaude README. */
const SimpleMarkdown: React.FC<{ source: string }> = ({ source }) => {
  const blocks = source.split(/\n{2,}/);
  return (
    <div className="space-y-2 text-xs leading-relaxed text-neutral-400">
      {blocks.map((block, i) => {
        const t = block.trim();
        if (!t) return null;
        if (t.startsWith("### ")) {
          return (
            <p key={i} className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
              {t.slice(4)}
            </p>
          );
        }
        if (t.startsWith("## ")) {
          return (
            <p key={i} className="pt-1 text-xs font-semibold text-neutral-200">
              {t.slice(3)}
            </p>
          );
        }
        if (t.startsWith("# ")) {
          return (
            <p key={i} className="text-sm font-medium text-neutral-100">
              {t.slice(2)}
            </p>
          );
        }
        if (t.startsWith("- ")) {
          return (
            <ul key={i} className="list-disc space-y-0.5 pl-4">
              {t.split("\n").map((line, j) => (
                <li key={j}>{line.replace(/^- /, "").replace(/\*\*(.+?)\*\*/g, "$1")}</li>
              ))}
            </ul>
          );
        }
        if (t.startsWith("```") || t.includes("`")) {
          return (
            <pre key={i} className="overflow-x-auto rounded bg-neutral-900/80 px-2 py-1.5 font-mono text-[11px] text-neutral-300">
              {t.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").replace(/`/g, "")}
            </pre>
          );
        }
        return (
          <p key={i}>
            {t.replace(/\*\*(.+?)\*\*/g, "$1").split("\n").map((line, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {line}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
};

export const TeamClaudeSettings: React.FC = () => {
  const api = useApi();
  const [status, setStatus] = useState<TeamClaudeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiName, setApiName] = useState("");
  const [importFrom, setImportFrom] = useState("");
  const [port, setPort] = useState("3456");
  const [threshold, setThreshold] = useState("0.98");
  const [showReadme, setShowReadme] = useState(true);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const s = await api.getTeamClaudeStatus();
      setStatus(s);
      setPort(String(s.port));
      setThreshold(String(s.switchThreshold));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load TeamClaude status");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while install/update is in flight.
  useEffect(() => {
    if (status?.installState !== "installing") return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [status?.installState, refresh]);

  const run = async (fn: () => Promise<TeamClaudeStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const s = await fn();
      setStatus(s);
      setPort(String(s.port));
      setThreshold(String(s.switchThreshold));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="flex items-center gap-2 px-3 py-4 text-sm text-neutral-500">
        <Loader2 size={14} className="animate-spin" /> Loading addons…
      </div>
    );
  }

  const installing = status.installState === "installing";
  const failed = status.installState === "error";
  const canConfig = status.installed && status.enabled;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-neutral-800">
        <div className="flex items-start gap-3 px-3 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-neutral-800 text-sm font-semibold text-amber-300">
            TC
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-neutral-100">TeamClaude</p>
              {status.version && (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {status.version}
                </span>
              )}
              {status.running && (
                <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  proxy running
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-neutral-500">
              Multi-account Claude proxy · {status.accounts.length} account
              {status.accounts.length === 1 ? "" : "s"}
            </p>
            {failed && status.installError && (
              <p className="mt-1 truncate text-[11px] text-red-400">Failed: {status.installError}</p>
            )}
            {status.lastError && (
              <p className="mt-1 text-[11px] text-amber-400">{status.lastError}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {status.installed ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installing || busy}
                  onClick={() => void run(() => api!.updateAddon("teamclaude").then(() => api!.getTeamClaudeStatus()))}
                >
                  {installing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Update
                </Button>
                <div className="flex items-center gap-2 text-xs text-neutral-400">
                  <span>Active</span>
                  <Switch
                    checked={status.enabled}
                    onChange={(v) => void run(() => api!.updateTeamClaude({ enabled: v }))}
                  />
                </div>
              </>
            ) : (
              <Button
                size="sm"
                disabled={installing || busy}
                onClick={() => void run(() => api!.installAddon("teamclaude").then(() => api!.getTeamClaudeStatus()))}
              >
                {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                Install
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-neutral-800 px-3 py-2">
          <button
            type="button"
            className="text-[11px] text-neutral-500 hover:text-neutral-300"
            onClick={() => setShowReadme((v) => !v)}
          >
            {showReadme ? "Hide instructions" : "Show instructions"}
          </button>
          {showReadme && (
            <div className="mt-2 max-h-56 overflow-y-auto rounded-md bg-neutral-950/50 p-2">
              <SimpleMarkdown source={status.readmeMarkdown} />
            </div>
          )}
        </div>

        {status.installed && (
          <fieldset
            disabled={!canConfig}
            className={cn("border-t border-neutral-800 px-3 py-3", !canConfig && "opacity-50")}
          >
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              Configuration {!status.enabled && "(enable Active to edit)"}
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs text-neutral-400">
                Port
                <Input
                  className="mt-1"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  disabled={!canConfig || busy}
                />
              </label>
              <label className="block text-xs text-neutral-400">
                Switch threshold (0–1)
                <Input
                  className="mt-1"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={!canConfig || busy}
                />
              </label>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={!canConfig || busy}
                onClick={() =>
                  void run(() =>
                    api!.updateTeamClaude({
                      port: Number(port) || 3456,
                      switchThreshold: Math.min(1, Math.max(0, Number(threshold) || 0.98))
                    })
                  )
                }
              >
                Save settings
              </Button>
            </div>

            <div className="mt-4 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Accounts</p>
              {status.accounts.length === 0 ? (
                <p className="text-xs text-neutral-600">No accounts yet. Import Claude Code creds or add an API key.</p>
              ) : (
                <div className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
                  {status.accounts.map((a) => (
                    <div key={a.name} className="flex items-center gap-2 px-2 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-neutral-100">{a.name}</p>
                        <p className="text-[11px] text-neutral-500">
                          {a.type ?? "oauth"}
                          {typeof a.priority === "number" ? ` · prio ${a.priority}` : ""}
                          {a.disabled ? " · disabled" : ""}
                          {!a.hasCredentials ? " · no credentials" : ""}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canConfig || busy}
                        onClick={() =>
                          void run(() => api!.toggleTeamClaudeAccount(a.name, !a.disabled))
                        }
                      >
                        {a.disabled ? "Enable" : "Disable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canConfig || busy}
                        onClick={() => {
                          if (!window.confirm(`Remove account “${a.name}”?`)) return;
                          void run(() => api!.removeTeamClaudeAccount(a.name));
                        }}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Import from Claude Code
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="Optional credentials.json path"
                  value={importFrom}
                  onChange={(e) => setImportFrom(e.target.value)}
                  disabled={!canConfig || busy}
                />
                <Button
                  size="sm"
                  disabled={!canConfig || busy}
                  onClick={() =>
                    void run(() =>
                      api!.importTeamClaude(importFrom.trim() ? { from: importFrom.trim() } : {})
                    )
                  }
                >
                  Import
                </Button>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Add Anthropic API key
              </p>
              <Input
                placeholder="sk-ant-…"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={!canConfig || busy}
              />
              <div className="flex gap-2">
                <Input
                  placeholder="Label (optional)"
                  value={apiName}
                  onChange={(e) => setApiName(e.target.value)}
                  disabled={!canConfig || busy}
                />
                <Button
                  size="sm"
                  disabled={!canConfig || busy || !apiKey.trim()}
                  onClick={() =>
                    void run(async () => {
                      const s = await api!.addTeamClaudeApiKey({
                        apiKey: apiKey.trim(),
                        name: apiName.trim() || undefined
                      });
                      setApiKey("");
                      setApiName("");
                      return s;
                    })
                  }
                >
                  Add key
                </Button>
              </div>
            </div>
          </fieldset>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};

export const AddonsSettings: React.FC = () => (
  <div className="space-y-3">
    <p className="text-xs text-neutral-500">
      Companion tools that enhance Orquester (not launched as tabs). Install, activate, and configure them here.
    </p>
    <TeamClaudeSettings />
  </div>
);
