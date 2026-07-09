import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Download, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
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

/** Animated collapsible block. Title size matches Accounts / Configuration / Instructions. */
const Section: React.FC<{
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, open, onToggle, badge, children }) => {
  const contentId = useId();
  return (
    <div className="border-t border-neutral-800">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-neutral-900/50"
        aria-expanded={open}
        aria-controls={contentId}
      >
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-neutral-500 transition-transform duration-200 ease-out",
            open ? "rotate-0" : "-rotate-90"
          )}
        />
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">{title}</span>
        {badge}
      </button>
      <div
        id={contentId}
        hidden={!open}
        aria-hidden={!open}
        className={cn("grid", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        {open && (
          <div className="min-h-0 overflow-hidden">
            <div className="px-3 pb-3">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
};

const finiteNumber = (value: string, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const TeamClaudeSettings: React.FC = () => {
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<TeamClaudeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyCount, setBusyCount] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [apiName, setApiName] = useState("");
  const [importFrom, setImportFrom] = useState("");
  const [dragging, setDragging] = useState(false);

  const [openInstructions, setOpenInstructions] = useState(false);
  const [openAccounts, setOpenAccounts] = useState(true);
  const [openConfig, setOpenConfig] = useState(true);

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
  const busy = busyCount > 0;

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
    setBusyCount((n) => n + 1);
    setError(null);
    try {
      applyStatus(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
      await refresh();
    } finally {
      setBusyCount((n) => Math.max(0, n - 1));
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
                    disabled={installing || busy}
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

        <Section
          title="Instructions (README)"
          open={openInstructions}
          onToggle={() => setOpenInstructions((v) => !v)}
        >
          <div className="max-h-64 overflow-y-auto rounded-md bg-neutral-950/50 p-2">
            <SimpleMarkdown source={status.readmeMarkdown} />
          </div>
        </Section>

        {status.installed && (
          <>
            <Section
              title="Accounts"
              open={openAccounts}
              onToggle={() => setOpenAccounts((v) => !v)}
              badge={
                !status.enabled ? (
                  <span className="text-[10px] font-normal normal-case tracking-normal text-neutral-600">
                    enable Active to edit
                  </span>
                ) : undefined
              }
            >
              <fieldset disabled={!canConfig} className={cn("space-y-4", !canConfig && "opacity-50")}>
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
                          className="shrink-0 whitespace-nowrap"
                          disabled={!canConfig || busy}
                          onClick={() => void run(() => api!.toggleTeamClaudeAccount(a.name, !a.disabled))}
                        >
                          {a.disabled ? "Enable" : "Disable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0"
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

                <div className="space-y-2">
                  <p className="text-xs font-medium text-neutral-300">Import from Claude Code</p>
                  <p className="text-[11px] text-neutral-600">
                    Upload a local <code className="text-neutral-400">credentials.json</code>, or import from a
                    path on the daemon host.
                  </p>
                  <div
                    className={cn(
                      "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-3 py-6 text-center transition-colors",
                      dragging ? "border-sky-500/60 bg-sky-500/10" : "border-neutral-700 bg-neutral-950/40",
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
                      void onPickFile(e.dataTransfer.files?.[0]);
                    }}
                  >
                    <Upload size={18} className="text-neutral-500" />
                    <p className="text-xs text-neutral-400">Drag & drop credentials.json here</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 whitespace-nowrap"
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
                  <div className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      placeholder="Or path on the daemon host (optional)"
                      value={importFrom}
                      onChange={(e) => setImportFrom(e.target.value)}
                      disabled={!canConfig || busy}
                    />
                    <Button
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
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

                <div className="space-y-2">
                  <p className="text-xs font-medium text-neutral-300">Add Anthropic API key</p>
                  <Input
                    placeholder="sk-ant-…"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={!canConfig || busy}
                  />
                  <div className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      placeholder="Label (optional)"
                      value={apiName}
                      onChange={(e) => setApiName(e.target.value)}
                      disabled={!canConfig || busy}
                    />
                    <Button
                      size="sm"
                      className="shrink-0 whitespace-nowrap"
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
            </Section>

            <Section
              title="Configuration"
              open={openConfig}
              onToggle={() => setOpenConfig((v) => !v)}
              badge={
                !status.enabled ? (
                  <span className="text-[10px] font-normal normal-case tracking-normal text-neutral-600">
                    enable Active to edit
                  </span>
                ) : undefined
              }
            >
              <fieldset disabled={!canConfig} className={cn("space-y-4", !canConfig && "opacity-50")}>
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
                    <Input
                      value={warmup}
                      onChange={(e) => setWarmup(e.target.value)}
                      disabled={!canConfig || busy}
                    />
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

                <div className="space-y-2 rounded-md border border-neutral-800 p-3">
                  <div className="flex items-center justify-between gap-3">
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
                      <Input
                        value={startConc}
                        onChange={(e) => setStartConc(e.target.value)}
                        disabled={!canConfig || busy || !stormEnabled}
                      />
                    </FieldLabel>
                    <FieldLabel label="Step concurrency">
                      <Input
                        value={stepConc}
                        onChange={(e) => setStepConc(e.target.value)}
                        disabled={!canConfig || busy || !stormEnabled}
                      />
                    </FieldLabel>
                    <FieldLabel label="Step ms">
                      <Input
                        value={stepMs}
                        onChange={(e) => setStepMs(e.target.value)}
                        disabled={!canConfig || busy || !stormEnabled}
                      />
                    </FieldLabel>
                    <FieldLabel label="Window ms">
                      <Input
                        value={windowMs}
                        onChange={(e) => setWindowMs(e.target.value)}
                        disabled={!canConfig || busy || !stormEnabled}
                      />
                    </FieldLabel>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    size="sm"
                    className="shrink-0 whitespace-nowrap"
                    disabled={!canConfig || busy}
                    onClick={() =>
                      void run(() =>
                        api!.updateTeamClaude({
                          port: Math.round(clamp(finiteNumber(port, 3456), 1, 65535)),
                          switchThreshold: clamp(finiteNumber(threshold, 0.98), 0, 1),
                          quotaProbeSeconds: Math.round(Math.max(0, finiteNumber(quotaProbe, 0))),
                          warmupSeconds: Math.round(Math.max(0, finiteNumber(warmup, 0))),
                          autoUpdate,
                          upstream: upstream.trim() || "https://api.anthropic.com",
                          stormRamp: {
                            enabled: stormEnabled,
                            startConc: Math.round(Math.max(1, finiteNumber(startConc, 1))),
                            stepConc: Math.round(Math.max(1, finiteNumber(stepConc, 1))),
                            stepMs: Math.round(Math.max(1, finiteNumber(stepMs, 250))),
                            windowMs: Math.round(Math.max(0, finiteNumber(windowMs, 30000)))
                          }
                        })
                      )
                    }
                  >
                    Save settings
                  </Button>
                </div>
              </fieldset>
            </Section>
          </>
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
