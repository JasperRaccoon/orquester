import React, { useCallback, useId, useRef, useState } from "react";
import { AlertTriangle, Check, FileUp, Loader2, Star, Trash2 } from "lucide-react";
import type { AgentAccount, AgentAccountAgent } from "@orquester/api";
import { Button, ConfirmDialog, Input } from "../ui";
import { getRegistryIcon } from "../../icons";
import { cn } from "../../lib/cn";
import { useApi } from "../../context/orquester-context";
import { ApiError } from "../../lib/api-client";
import { useAppStore } from "../../store/app";
import { GrokDeviceLink } from "./GrokDeviceLink";
import { Badge, EmptyState, FormField, Notice, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const AGENTS: { id: AgentAccountAgent; name: string }[] = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
  { id: "grok", name: "Grok" }
];

const agentName = (agent: AgentAccountAgent) => AGENTS.find((a) => a.id === agent)?.name ?? agent;

const formatDate = (iso: string): string | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toLocaleDateString(undefined, { dateStyle: "medium" });
};

export function AgentAccountsSettings() {
  const api = useApi();
  const accounts = useAppStore((s) => s.agentAccounts);
  const load = useAppStore((s) => s.loadAgentAccounts);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [imported, setImported] = useState<AgentAccount | null>(null);
  const [label, setLabel] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [removing, setRemoving] = useState<AgentAccount | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const labelId = useId();

  /** Run a mutation, then reload the list; resolves false when it failed. */
  const run = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setErr(null);
      setImported(null);
      try {
        await fn();
        await load();
        return true;
      } catch (e) {
        // The daemon's own reason ("still in use by …"), not the request line.
        setErr(e instanceof ApiError ? (e.serverMessage ?? e.message) : e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  const onPickFile = async (file?: File) => {
    if (!file) return;
    const content = await file.text();
    let added: AgentAccount | null = null;
    const ok = await run(async () => {
      added = await api.importAgentAccount({ content, label: label.trim() || undefined });
    });
    // Keep the label on failure (typically Claude's "label required" or a
    // wrong file) so the retry does not need it retyped.
    if (ok) {
      setLabel("");
      setImported(added);
    }
  };

  const byAgent = (agent: AgentAccountAgent) => (accounts?.accounts ?? []).filter((a) => a.agent === agent);
  const isDefault = (a: AgentAccount) => accounts?.defaults[a.agent] === a.id;

  const confirmRemove = () => {
    const target = removing;
    setRemoving(null);
    if (target) void run(() => api.removeAgentAccount(target.id));
  };

  return (
    <SettingsPage
      title="Accounts"
      description="Managed Claude, Codex and Grok logins stored on this server. New sessions use each agent's default account unless you pick another."
    >
      {err && (
        <Notice
          tone="danger"
          action={
            <Button size="sm" variant="ghost" onClick={() => setErr(null)}>
              Dismiss
            </Button>
          }
        >
          {err}
        </Notice>
      )}

      {AGENTS.map(({ id: agent, name }) => {
        const list = byAgent(agent);
        const hasDefault = list.some(isDefault);
        return (
          <SettingsSection
            key={agent}
            title={name}
            description={
              list.length > 0 && !hasDefault
                ? `No default — new ${name} sessions use the server's own login until you make one the default.`
                : undefined
            }
            actions={list.length > 0 ? <Badge>{list.length}</Badge> : undefined}
          >
            {list.length === 0 ? (
              <EmptyState
                className="py-6"
                icon={getRegistryIcon("agent", agent, 18)}
                title={`No ${name} accounts`}
                description={
                  agent === "grok"
                    ? "Link one with a device code below, or import a Grok auth.json."
                    : `Import a ${agent === "claude" ? ".credentials.json" : "auth.json"} under “Add an account”.`
                }
              />
            ) : (
              list.map((a) => (
                <AccountRow
                  key={a.id}
                  account={a}
                  isDefault={isDefault(a)}
                  busy={busy}
                  onMakeDefault={() => void run(() => api.setAgentAccountDefaults({ [agent]: a.id }))}
                  onRemove={() => setRemoving(a)}
                />
              ))
            )}
            {/* Grok's second acquisition path: a device-code login (no
                equivalent exists for Claude/Codex). */}
            {agent === "grok" ? <GrokDeviceLink /> : null}
          </SettingsSection>
        );
      })}

      <SettingsSection
        title="Add an account"
        description="Import a login from its credentials file. The agent is detected from the file."
      >
        <div className="space-y-4 p-4">
          <FormField
            label="Label"
            htmlFor={labelId}
            hint="Required for Claude (its credentials carry no email). Codex and Grok default to the account's email."
          >
            <Input
              id={labelId}
              placeholder="e.g. Work, Personal"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              disabled={busy}
            />
          </FormField>

          <div
            className={cn(
              "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-7 text-center transition-colors",
              dragOver ? "border-info bg-info-soft/15" : "border-neutral-700 bg-neutral-950/30"
            )}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }}
            onDragLeave={(e) => {
              // Leaving into a child still counts as over the zone.
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void onPickFile(e.dataTransfer.files?.[0]);
            }}
          >
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full",
                dragOver ? "bg-info-soft/40 text-info" : "bg-neutral-800/80 text-neutral-500"
              )}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <FileUp size={16} />}
            </span>
            <p className="text-sm text-neutral-300">
              {busy ? "Importing…" : dragOver ? "Drop to import" : "Drop a credentials file here"}
            </p>
            <p className="max-w-sm text-[11px] leading-relaxed text-neutral-500">
              Claude <code className="font-mono">~/.claude/.credentials.json</code>, Codex{" "}
              <code className="font-mono">~/.codex/auth.json</code> or Grok{" "}
              <code className="font-mono">~/.grok/auth.json</code>
            </p>
            <Button size="sm" variant="outline" className="mt-1" disabled={busy} onClick={() => fileRef.current?.click()}>
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

          {imported && (
            <Notice tone="ok">
              Added “{imported.label}” to {agentName(imported.agent)}
              {isDefault(imported) ? " as its default account." : "."}
            </Notice>
          )}
        </div>
      </SettingsSection>

      <ConfirmDialog
        open={removing !== null}
        title="Remove account?"
        confirmLabel="Remove"
        message={
          removing && (
            <div className="space-y-2">
              <p>
                The stored login for “{removing.label}” is deleted from this server. Sessions can no longer launch
                with it.
              </p>
              {isDefault(removing) && (
                <p className="text-neutral-500">
                  It is the {agentName(removing.agent)} default; new {agentName(removing.agent)} sessions will use
                  the server's own login until you pick another default.
                </p>
              )}
            </div>
          )
        }
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </SettingsPage>
  );
}

const AccountRow: React.FC<{
  account: AgentAccount;
  isDefault: boolean;
  busy: boolean;
  onMakeDefault: () => void;
  onRemove: () => void;
}> = ({ account: a, isDefault, busy, onMakeDefault, onRemove }) => {
  const added = formatDate(a.importedAt);
  const details = [a.email, a.plan, added && `Added ${added}`].filter(Boolean).join(" · ");
  return (
    <SettingRow
      icon={getRegistryIcon("agent", a.agent, 15)}
      label={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-medium text-neutral-100">{a.label}</span>
          {isDefault && (
            <Badge tone="ok" icon={<Check size={10} />}>
              Default
            </Badge>
          )}
          {a.needsReauth && (
            <Badge tone="warn" icon={<AlertTriangle size={10} />} title="The stored login stopped refreshing">
              Needs re-auth
            </Badge>
          )}
        </span>
      }
      description={
        <>
          {details && <span className="block truncate">{details}</span>}
          {a.needsReauth && (
            <span className="block text-warn">
              Sign in again, import the fresh credentials file, then remove this one.
            </span>
          )}
        </>
      }
    >
      {!isDefault && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={onMakeDefault}>
          <Star size={13} /> Make default
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        disabled={busy}
        aria-label={`Remove ${a.label}`}
        title="Remove account"
        className="text-neutral-500 hover:text-danger"
        onClick={onRemove}
      >
        <Trash2 size={14} />
      </Button>
    </SettingRow>
  );
};
