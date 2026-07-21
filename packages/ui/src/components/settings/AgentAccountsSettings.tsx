import React, { useCallback, useRef, useState } from "react";
import { Trash2, Upload, Star } from "lucide-react";
import type { AgentAccount, AgentAccountAgent } from "@orquester/api";
import { Button, Input } from "../ui";
import { useApi } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";

export function AgentAccountsSettings() {
  const api = useApi();
  const accounts = useAppStore((s) => s.agentAccounts);
  const load = useAppStore((s) => s.loadAgentAccounts);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setErr(null);
      try {
        await fn();
        await load();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const importBlob = (content: string) =>
    run(() => api.importAgentAccount({ content, label: label.trim() || undefined }));

  const onPickFile = async (file?: File) => {
    if (!file) return;
    const text = await file.text();
    await importBlob(text);
    setLabel("");
  };

  const byAgent = (agent: AgentAccountAgent) => (accounts?.accounts ?? []).filter((a) => a.agent === agent);
  const isDefault = (a: AgentAccount) => accounts?.defaults[a.agent] === a.id;

  return (
    <div className="space-y-6">
      {err ? <p className="text-xs text-red-400">{err}</p> : null}
      {(["claude", "codex"] as const).map((agent) => (
        <section key={agent} className="space-y-2">
          <h3 className="text-sm font-medium capitalize">{agent} accounts</h3>
          <div className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
            {byAgent(agent).length === 0 ? (
              <p className="px-2 py-2 text-xs text-neutral-600">No accounts. Import a credentials file below.</p>
            ) : (
              byAgent(agent).map((a) => (
                <div key={a.id} className="flex items-center gap-2 px-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {a.label}
                      {a.needsReauth ? " · needs re-auth" : ""}
                    </p>
                    <p className="text-[11px] text-neutral-500">{a.email ?? a.plan ?? a.agent}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || isDefault(a)}
                    onClick={() => void run(() => api.setAgentAccountDefaults({ [agent]: a.id }))}
                  >
                    <Star size={13} className={isDefault(a) ? "fill-current" : ""} />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove “${a.label}”?`)) void run(() => api.removeAgentAccount(a.id));
                    }}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))
            )}
          </div>
        </section>
      ))}
      <div className="space-y-2">
        <p className="text-xs font-medium text-neutral-300">Import an account</p>
        <p className="text-[11px] text-neutral-600">
          Upload a Claude <code>.credentials.json</code> or Codex <code>auth.json</code>. Agent is auto-detected. Claude
          needs a label.
        </p>
        <Input
          placeholder="Label (required for Claude)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
        <div
          className="flex flex-col items-center gap-2 rounded-md border border-dashed border-neutral-700 px-3 py-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onPickFile(e.dataTransfer.files?.[0]);
          }}
        >
          <Upload size={18} className="text-neutral-500" />
          <p className="text-xs text-neutral-400">Drag &amp; drop, or</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
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
    </div>
  );
}
