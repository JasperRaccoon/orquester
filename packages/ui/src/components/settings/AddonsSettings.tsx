import React, { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
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
            <pre
              key={i}
              className="overflow-x-auto rounded bg-neutral-900/80 px-2 py-1.5 font-mono text-[11px] text-neutral-300"
            >
              {t.replace(/^```\w*\n?/, "").replace(/\n?```$/, "").replace(/`/g, "")}
            </pre>
          );
        }
        return (
          <p key={i}>
            {t
              .replace(/\*\*(.+?)\*\*/g, "$1")
              .split("\n")
              .map((line, j) => (
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

const FieldLabel: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children
}) => (
  <label className="block text-xs text-neutral-400">
    <span className="font-medium text-neutral-300">{label}</span>
    {hint && <span className="mt-0.5 block text-[11px] text-neutral-600">{hint}</span>}
    <div className="mt-1">{children}</div>
  </label>
);

export const TeamClaudeSettings: React.FC = () => {
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<TeamClaudeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [apiName, setApiName] = useState("");
  const [importFrom, setImportFrom] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showReadme, setShowReadme] = useState(false);

  // Form state
  const [port, setPort] = useState("3456");
  const [threshold, setThreshold] = useState("0.98");
  const [quotaProbe, setQuotaProbe] = useState("0");
  const [warmup, setWarmup] = useState("0");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [upstream, setUpstream] = useState("https://api.anthropic.com");
  const [stormEnabled, setStormEnabled] = useState(true);
  const [startConc, setStartConc] = useState("1");
  const [stepConc, setStepConc] = useState("1");
  const [stepMs, setStepMs] = useState("250");
  const [windowMs, setWindowMs] = useState("30000");
  const [sxMode, setSxMode] = useState<"always" | "429" | "off">("off");
  const [sxApiKey, setSxApiKey] = useState("");

  const applyStatus = (s: TeamClaudeStatus) => {
    setStatus(s);
    setPort(String(s.port));
    setThreshold(String(s.switchThreshold));
    setQuotaProbe(String(s.quotaProbeSeconds));
    setWarmup(String(s.warmupSeconds));
    setAutoUpdate(s.autoUpdate);
    setUpstream(s.upstream);
    setStormEnabled(s.stormRamp.enabled);
    setStartConc(String(s.stormRamp.startConc));
    setStepConc(String(s.stormRamp.stepConc));
    setStepMs(String(s.stormRamp.stepMs));
    setWindowMs(String(s.stormRamp.windowMs));
    setSxMode(s.sxMode);
  };

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const s = await api.getTeamClaudeStatus();
      applyStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load TeamClaude status");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (status?.installState !== "installing") return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [status?.installState, refresh]);

  const run = async (fn: () => Promise<TeamClaudeStatus>) => {
    setBusy(true);
    setError(null);
    try {
      applyStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const importContent = async (content: string) => {
    await run(() => api!.importTeamClaude({ content }));
  };

  const onPickFile = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      await importContent(text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read file");
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
          <img
            src={status.logoUrl}
            alt="KarpelesLab"
            className="h-10 w-10 shrink-0 rounded-md bg-neutral-800 object-cover"
            referrerPolicy="no-referrer"
          />
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
              {status.accounts.length === 1 ? "" : "s"} ·{" "}
              <a
                href="https://github.com/KarpelesLab/teamclaude"
                target="_blank"
                rel="noreferrer"
                className="text-neutral-400 underline-offset-2 hover:underline"
              >
                KarpelesLab/teamclaude
              </a>
            </p>
            {failed && status.installError && (
              <p className="mt-1 truncate text-[11px] text-red-400">Failed: {status.installError}</p>
            )}
            {status.lastError && <p className="mt-1 text-[11px] text-amber-400">{status.lastError}</p>}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {status.installed ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={installing || busy}
                  onClick={() =>
                    void run(() => api!.updateAddon("teamclaude").then(() => api!.getTeamClaudeStatus()))
                  }
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
                onClick={() =>
                  void run(() => api!.installAddon("teamclaude").then(() => api!.getTeamClaudeStatus()))
                }
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
            className={cn("space-y-5 border-t border-neutral-800 px-3 py-3", !canConfig && "opacity-50")}
          >
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
              Configuration {!status.enabled && "(enable Active to edit)"}
            </p>

            {/* Core */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <FieldLabel label="Port" hint="Local loopback proxy port (default 3456).">
                <Input value={port} onChange={(e) => setPort(e.target.value)} disabled={!canConfig || busy} />
              </FieldLabel>
              <FieldLabel label="Switch threshold" hint="Rotate at this quota fraction (0–1).">
                <Input
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={!canConfig || busy}
                />
              </FieldLabel>
              <FieldLabel label="Upstream" hint="Anthropic-compatible API base URL.">
                <Input
                  value={upstream}
                  onChange={(e) => setUpstream(e.target.value)}
                  disabled={!canConfig || busy}
                />
              </FieldLabel>
              <FieldLabel
                label="Quota probe (seconds)"
                hint="Refresh idle account quota without spending messages. 0 = off. Min 30 when on."
              >
                <Input
                  value={quotaProbe}
                  onChange={(e) => setQuotaProbe(e.target.value)}
                  disabled={!canConfig || busy}
                />
              </FieldLabel>
              <FieldLabel
                label="Keep-warm (seconds)"
                hint="Start idle accounts' 5h timers early (spends a little quota). 0 = off. Min 60 when on."
              >
                <Input value={warmup} onChange={(e) => setWarmup(e.target.value)} disabled={!canConfig || busy} />
              </FieldLabel>
              <div className="flex items-end pb-1">
                <div className="flex w-full items-center justify-between gap-3 rounded-md border border-neutral-800 px-3 py-2">
                  <div>
                    <p className="text-xs font-medium text-neutral-300">Auto-update</p>
                    <p className="text-[11px] text-neutral-600">Background npm self-update for TeamClaude.</p>
                  </div>
                  <Switch checked={autoUpdate} onChange={setAutoUpdate} disabled={!canConfig || busy} />
                </div>
              </div>
            </div>

            {/* Storm control */}
            <div className="space-y-2 rounded-md border border-neutral-800 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-neutral-200">Storm control (switchover ramp-up)</p>
                  <p className="text-[11px] text-neutral-600">
                    Pace requests onto a just-switched account so a herd doesn't instantly throttle it.
                  </p>
                </div>
                <Switch
                  checked={stormEnabled}
                  onChange={setStormEnabled}
                  disabled={!canConfig || busy}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <FieldLabel label="Start concurrency">
                  <Input value={startConc} onChange={(e) => setStartConc(e.target.value)} disabled={!canConfig || busy || !stormEnabled} />
                </FieldLabel>
                <FieldLabel label="Step concurrency">
                  <Input value={stepConc} onChange={(e) => setStepConc(e.target.value)} disabled={!canConfig || busy || !stormEnabled} />
                </FieldLabel>
                <FieldLabel label="Step ms">
                  <Input value={stepMs} onChange={(e) => setStepMs(e.target.value)} disabled={!canConfig || busy || !stormEnabled} />
                </FieldLabel>
                <FieldLabel label="Window ms">
                  <Input value={windowMs} onChange={(e) => setWindowMs(e.target.value)} disabled={!canConfig || busy || !stormEnabled} />
                </FieldLabel>
              </div>
            </div>

            {/* sx.org */}
            <div className="space-y-2 rounded-md border border-neutral-800 p-3">
              <p className="text-xs font-medium text-neutral-200">sx.org residential proxy (optional)</p>
              <p className="text-[11px] text-neutral-600">
                Work around IP-keyed 429s. TLS stays end-to-end with Anthropic. Key is write-only never returned.
                {status.sxKeyConfigured && (
                  <span className="ml-1 text-emerald-400">Key configured.</span>
                )}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldLabel label="Mode">
                  <select
                    className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
                    value={sxMode}
                    onChange={(e) => setSxMode(e.target.value as "always" | "429" | "off")}
                    disabled={!canConfig || busy}
                  >
                    <option value="off">Off</option>
                    <option value="429">On 429 only</option>
                    <option value="always">Always</option>
                  </select>
                </FieldLabel>
                <FieldLabel label="API key" hint="Leave blank to keep existing; type clear to remove.">
                  <Input
                    type="password"
                    placeholder={status.sxKeyConfigured ? "•••••••• (set)" : "sx.org API key"}
                    value={sxApiKey}
                    onChange={(e) => setSxApiKey(e.target.value)}
                    disabled={!canConfig || busy}
                  />
                </FieldLabel>
              </div>
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                disabled={!canConfig || busy}
                onClick={() =>
                  void run(() =>
                    api!.updateTeamClaude({
                      port: Number(port) || 3456,
                      switchThreshold: Math.min(1, Math.max(0, Number(threshold) || 0.98)),
                      quotaProbeSeconds: Math.max(0, Number(quotaProbe) || 0),
                      warmupSeconds: Math.max(0, Number(warmup) || 0),
                      autoUpdate,
                      upstream: upstream.trim() || "https://api.anthropic.com",
                      stormRamp: {
                        enabled: stormEnabled,
                        startConc: Math.max(1, Number(startConc) || 1),
                        stepConc: Math.max(1, Number(stepConc) || 1),
                        stepMs: Math.max(1, Number(stepMs) || 250),
                        windowMs: Math.max(0, Number(windowMs) || 30000)
                      },
                      sxMode,
                      ...(sxApiKey.trim() === "clear"
                        ? { sxApiKey: "" }
                        : sxApiKey.trim()
                          ? { sxApiKey: sxApiKey.trim() }
                          : {})
                    }).then((s) => {
                      setSxApiKey("");
                      return s;
                    })
                  )
                }
              >
                Save settings
              </Button>
            </div>

            {/* Accounts */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">Accounts</p>
              {status.accounts.length === 0 ? (
                <p className="text-xs text-neutral-600">
                  No accounts yet. Import Claude Code creds or add an API key.
                </p>
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
                        onClick={() => void run(() => api!.toggleTeamClaudeAccount(a.name, !a.disabled))}
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

            {/* Import */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Import from Claude Code
              </p>
              <p className="text-[11px] text-neutral-600">
                Import credentials on the daemon host path, or upload a local <code>credentials.json</code> from
                this machine.
              </p>
              <div
                className={cn(
                  "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-3 py-6 text-center transition-colors",
                  dragging
                    ? "border-sky-500/60 bg-sky-500/10"
                    : "border-neutral-700 bg-neutral-950/40",
                  (!canConfig || busy) && "pointer-events-none opacity-60"
                )}
                onDragEnter={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  void onPickFile(f);
                }}
              >
                <Upload size={18} className="text-neutral-500" />
                <p className="text-xs text-neutral-400">Drag & drop credentials.json here</p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canConfig || busy}
                    onClick={() => fileRef.current?.click()}
                  >
                    Choose file…
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      void onPickFile(f);
                    }}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Or path on the daemon host (optional)"
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
                  Import path
                </Button>
              </div>
            </div>

            {/* API key account */}
            <div className="space-y-2">
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
