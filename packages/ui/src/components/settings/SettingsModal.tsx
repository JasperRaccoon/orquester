import React, { useEffect, useState } from "react";
import {
  AppWindow,
  Bell,
  Boxes,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Gauge,
  Github,
  KeyRound,
  Loader2,
  Plus,
  Puzzle,
  RefreshCw,
  Server,
  Trash2,
  X
} from "lucide-react";
import type { DaemonConfig } from "@orquester/config";
import { cn } from "../../lib/cn";
import { disablePush, enablePush, getSubscription, pushSupported } from "../../lib/push";
import { Button, Input, Modal, ModalCloseButton, Switch } from "../ui";
import { getRegistryIcon } from "../../icons";
import { useIsDesktop, useRegistry } from "../../hooks";
import { useApi, useOrquester } from "../../context/orquester-context";
import { useAppStore } from "../../store/app";
import { AddonsSettings } from "./AddonsSettings";

type Section = "app" | "agents" | "addons" | "usage" | "github" | "daemon";

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "app", label: "App", icon: <AppWindow size={16} />, desc: "Titlebar, runtime, active server" },
  { id: "usage", label: "Usage", icon: <Gauge size={16} />, desc: "Top-bar usage widget for Claude Code & Codex" },
  { id: "agents", label: "Agents", icon: <Boxes size={16} />, desc: "Install, update and view harness versions" },
  { id: "addons", label: "Addons", icon: <Puzzle size={16} />, desc: "Companion tools (TeamClaude multi-account proxy)" },
  { id: "github", label: "GitHub", icon: <Github size={16} />, desc: "Connect accounts and per-workspace git identities" },
  { id: "daemon", label: "Daemon", icon: <Server size={16} />, desc: "Workspaces dir, external HTTP access" }
];

const renderSection = (id: Section) =>
  id === "app" ? (
    <AppSettings />
  ) : id === "agents" ? (
    <AgentsSettings />
  ) : id === "addons" ? (
    <AddonsSettings />
  ) : id === "usage" ? (
    <UsageSettings />
  ) : id === "github" ? (
    <GitHubSettings />
  ) : (
    <DaemonSettings />
  );
const labelOf = (id: Section) => SECTIONS.find((s) => s.id === id)?.label ?? "";

export const SettingsModal: React.FC = () => {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const isDesktop = useIsDesktop();
  const [section, setSection] = useState<Section | null>(null);

  // Reset to the category list each time it closes (mobile shows list first).
  useEffect(() => {
    if (!open) {
      setSection(null);
    }
  }, [open]);

  const close = () => setOpen(false);

  // --- Desktop: persistent side nav + content ---
  if (isDesktop) {
    const current = section ?? "app";
    return (
      <Modal open={open} onClose={close} className="h-[90vh] max-w-6xl">
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-neutral-800 bg-neutral-950/40 p-2">
          <p className="px-2 pb-2 pt-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            Settings
          </p>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                current === s.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-400 hover:bg-neutral-800/60"
              )}
            >
              <span className="text-neutral-500">{s.icon}</span>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
            <span className="text-sm font-medium text-neutral-100">{labelOf(current)}</span>
            <ModalCloseButton onClose={close} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{renderSection(current)}</div>
        </div>
      </Modal>
    );
  }

  // --- Mobile: category list → detail with a back button ---
  return (
    <Modal open={open} onClose={close} className="h-[88vh]">
      <div className="flex w-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
          {section ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setSection(null)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800"
            >
              <ChevronLeft size={18} />
            </button>
          ) : (
            <span className="px-2" />
          )}
          <span className="flex-1 text-sm font-medium text-neutral-100">
            {section ? labelOf(section) : "Settings"}
          </span>
          <ModalCloseButton onClose={close} />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {section === null ? (
            <div className="p-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSection(s.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-neutral-800/60"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-md bg-neutral-800 text-neutral-300">
                    {s.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-neutral-100">{s.label}</span>
                    <span className="block truncate text-xs text-neutral-500">{s.desc}</span>
                  </span>
                  <ChevronRight size={16} className="text-neutral-600" />
                </button>
              ))}
            </div>
          ) : (
            <div className="p-4">{renderSection(section)}</div>
          )}
        </div>
      </div>
    </Modal>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children
}) => (
  <div className="flex items-center justify-between gap-4 py-2">
    <div className="min-w-0">
      <p className="text-sm text-neutral-200">{label}</p>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

type AgentFilter = "all" | "installed" | "available";

const AgentsSettings: React.FC = () => {
  const registry = useRegistry();
  const installAgent = useAppStore((s) => s.installAgent);
  const updateAgent = useAppStore((s) => s.updateAgent);
  const [filter, setFilter] = useState<AgentFilter>("all");

  const agents = registry.agents.filter((a) =>
    filter === "installed" ? a.enabled : filter === "available" ? !a.enabled : true
  );

  const filters: { id: AgentFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "installed", label: "Installed" },
    { id: "available", label: "Available" }
  ];

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-lg bg-neutral-800/60 p-0.5 text-xs">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-md px-3 py-1 transition-colors",
              filter === f.id ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {agents.length === 0 && (
          <p className="px-3 py-4 text-sm text-neutral-600">No agents in this view.</p>
        )}
        {agents.map((agent) => {
          const busy = agent.installState === "installing";
          const failed = agent.installState === "error";
          return (
            <div key={agent.id} className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-400">
                {getRegistryIcon("agent", agent.id, 18)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-100">{agent.name}</p>
                <p className="truncate text-xs text-neutral-500">
                  {busy
                    ? agent.enabled
                      ? "Updating…"
                      : "Installing…"
                    : failed
                      ? `Failed${agent.installError ? `: ${firstLine(agent.installError)}` : ""}`
                      : agent.enabled
                        ? agent.version ?? "installed"
                        : "Not installed"}
                </p>
              </div>
              <div className="shrink-0">
                {busy ? (
                  <span className="flex items-center gap-1.5 text-xs text-neutral-400">
                    <Loader2 size={13} className="animate-spin" />
                    {agent.enabled ? "Updating…" : "Installing…"}
                  </span>
                ) : failed ? (
                  <Button size="sm" variant="outline" onClick={() => void installAgent(agent.id)}>
                    <RefreshCw size={13} /> Retry
                  </Button>
                ) : agent.enabled ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!agent.updateCmd}
                    onClick={() => void updateAgent(agent.id)}
                  >
                    <RefreshCw size={13} /> Update
                  </Button>
                ) : (
                  <Button size="sm" disabled={!agent.installCmd} onClick={() => void installAgent(agent.id)}>
                    <Download size={13} /> Install
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "";

const GitHubSettings: React.FC = () => {
  const accounts = useAppStore((s) => s.accounts);
  const loadAccounts = useAppStore((s) => s.loadAccounts);
  const addAccount = useAppStore((s) => s.addAccount);
  const removeAccount = useAppStore((s) => s.removeAccount);
  const testAccount = useAppStore((s) => s.testAccount);
  const setAccountToken = useAppStore((s) => s.setAccountToken);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-account test state, keyed by id.
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  // Per-account "enable repo access" token entry: which row is open + its value.
  const [repoTokenFor, setRepoTokenFor] = useState<string | null>(null);
  const [repoToken, setRepoToken] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);

  // Accounts load on connect; refresh on open in case another client changed them.
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const connect = async () => {
    if (!label.trim() || !token.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addAccount({ label, token });
      setAdding(false);
      setLabel("");
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the account.");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "busy" }));
    const result = await testAccount(id);
    setTests((t) => ({
      ...t,
      [id]: { ok: result.ok, text: result.ok ? `Connected as ${result.login}` : result.message ?? "Failed" }
    }));
  };

  const openRepoToken = (id: string) => {
    setRepoTokenFor(id);
    setRepoToken("");
    setRepoError(null);
  };

  const cancelRepoToken = () => {
    setRepoTokenFor(null);
    setRepoToken("");
    setRepoError(null);
  };

  const saveRepoToken = async (id: string) => {
    if (!repoToken.trim()) {
      return;
    }
    setRepoBusy(true);
    setRepoError(null);
    try {
      // The token is only sent — never read back. setAccountToken refetches
      // accounts so `repoAccess` flips on success.
      await setAccountToken(id, repoToken);
      cancelRepoToken();
    } catch (err) {
      setRepoError(err instanceof Error ? err.message : "Could not enable repo access.");
    } finally {
      setRepoBusy(false);
    }
  };

  const disconnect = async (id: string) => {
    setError(null);
    try {
      await removeAccount(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {accounts.length === 0 && (
          <p className="px-3 py-4 text-sm text-neutral-600">No accounts connected.</p>
        )}
        {accounts.map((account) => {
          const test = tests[account.id];
          const editingToken = repoTokenFor === account.id;
          return (
            <div key={account.id} className="group px-3 py-2.5">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-400">
                  <Github size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-100">
                    {account.label}
                    <span className="ml-1.5 text-neutral-500">@{account.githubLogin}</span>
                  </p>
                  <p className="truncate text-xs text-neutral-500">{account.gitEmail}</p>
                  <p className="truncate text-xs">
                    {account.repoAccess ? (
                      <span className="text-emerald-400">
                        <Check size={11} className="mr-1 inline" />
                        Repo access enabled
                      </span>
                    ) : (
                      <span className="text-neutral-500">Repo access off</span>
                    )}
                  </p>
                  {test && test !== "busy" && (
                    <p className={cn("truncate text-xs", test.ok ? "text-emerald-400" : "text-red-400")}>
                      {test.ok ? <Check size={11} className="mr-1 inline" /> : <X size={11} className="mr-1 inline" />}
                      {test.text}
                    </p>
                  )}
                </div>
                {!account.repoAccess && !editingToken && (
                  <Button size="sm" variant="outline" onClick={() => openRepoToken(account.id)}>
                    <KeyRound size={13} /> Enable repo access
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={test === "busy"} onClick={() => void runTest(account.id)}>
                  {test === "busy" ? <Loader2 size={13} className="animate-spin" /> : null} Test
                </Button>
                <button
                  type="button"
                  aria-label="Disconnect account"
                  className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                  onClick={() => void disconnect(account.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {editingToken && (
                <div className="ml-11 mt-2 space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-3">
                  <Input
                    autoFocus
                    type="password"
                    placeholder="GitHub PAT (repo, read:org)"
                    value={repoToken}
                    onChange={(e) => setRepoToken(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveRepoToken(account.id)}
                  />
                  <p className="text-xs text-neutral-500">
                    Stored securely on the daemon to list and create repositories. It is never
                    displayed again and never used on a clone command line.
                  </p>
                  {repoError && <p className="text-xs text-red-400">{repoError}</p>}
                  <div className="flex gap-2">
                    <Button size="sm" disabled={repoBusy || !repoToken.trim()} onClick={() => void saveRepoToken(account.id)}>
                      {repoBusy ? <Loader2 size={13} className="animate-spin" /> : null} Save token
                    </Button>
                    <Button size="sm" variant="outline" disabled={repoBusy} onClick={cancelRepoToken}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-neutral-800 p-3">
          <Input placeholder="Label (e.g. work)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input
            type="password"
            placeholder="GitHub PAT (write:public_key, user:email, read:user, repo, read:org)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            The token uploads an SSH key and reads your identity. With the <code>repo</code> and{" "}
            <code>read:org</code> scopes it is also stored securely on the daemon to list and create
            repositories. It is never displayed again.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void connect()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} Connect
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add account…
        </Button>
      )}
    </div>
  );
};

const UsageSettings: React.FC = () => {
  const prefs = useAppStore((s) => s.appConfig.usage);
  const usage = useAppStore((s) => s.usage);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const registry = useRegistry();

  const setUsage = (patch: Partial<typeof prefs>) => void updateAppConfig({ usage: { ...prefs, ...patch } });

  const agentHint = (id: "claude" | "codex") => {
    const installed = registry.agents.some((a) => a.id === id && a.enabled);
    if (!installed) return "Not installed";
    const found = usage?.agents.find((a) => a.id === id);
    if (!found) return "Not logged in";
    if (found.stale) return found.plan ? `Logged in · ${found.plan} — updating…` : "Logged in — updating…";
    return found.plan ? `Logged in · ${found.plan}` : "Logged in";
  };

  const CHIP_OPTIONS: { value: typeof prefs.chip; label: string }[] = [
    { value: "busiest", label: "Busiest" },
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" }
  ];

  const VIEW_OPTIONS: { value: NonNullable<typeof prefs.view>; label: string }[] = [
    { value: "aggregate", label: "Aggregated" },
    { value: "accounts", label: "Per account" }
  ];

  return (
    <div className="divide-y divide-neutral-800">
      <Field label="Show usage in the top bar" hint="A compact quota chip that opens a details panel.">
        <Switch checked={prefs.enabled} onChange={(v) => setUsage({ enabled: v })} />
      </Field>
      <Field label="Claude Code" hint={agentHint("claude")}>
        <Switch
          checked={prefs.agents.claude ?? true}
          onChange={(v) => setUsage({ agents: { ...prefs.agents, claude: v } })}
        />
      </Field>
      <Field label="Codex" hint={agentHint("codex")}>
        <Switch
          checked={prefs.agents.codex ?? true}
          onChange={(v) => setUsage({ agents: { ...prefs.agents, codex: v } })}
        />
      </Field>
      <Field label="Chip shows" hint="Which agent drives the collapsed chip.">
        <div className="flex gap-1">
          {CHIP_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setUsage({ chip: o.value })}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                prefs.chip === o.value
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
      <Field
        label="Claude multi-account view"
        hint="When TeamClaude is active, show pooled quota or each account’s bars."
      >
        <div className="flex gap-1">
          {VIEW_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => setUsage({ view: o.value })}
              className={cn(
                "rounded-md px-2 py-1 text-xs",
                (prefs.view ?? "aggregate") === o.value
                  ? "bg-neutral-700 text-neutral-100"
                  : "text-neutral-400 hover:bg-neutral-800"
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
};

const AppSettings: React.FC = () => {
  const { runtime } = useOrquester();
  const appConfig = useAppStore((s) => s.appConfig);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const active = connections.find((c) => c.id === activeId);
  const [reloading, setReloading] = useState(false);

  // Force the web client to pull the freshly deployed bundle. Pull-to-refresh is
  // disabled app-wide (it was reloading the SPA on terminal scroll), so an
  // installed PWA left open has no gesture to refresh itself. Nudge the service
  // worker to re-check for a new version, then reload — navigations are
  // network-first and assets are content-hashed, so this lands on the latest.
  const reloadApp = async () => {
    setReloading(true);
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
    } catch {
      /* SW unsupported/blocked — the reload below still refreshes the shell */
    }
    window.location.reload();
  };

  return (
    <div className="divide-y divide-neutral-800">
      <Field label="Custom titlebar" hint="Frameless window with in-app window controls.">
        <Switch
          checked={appConfig.useTitlebar}
          onChange={(checked) => void updateAppConfig({ useTitlebar: checked })}
        />
      </Field>
      <Field
        label="Confirm before closing a session"
        hint="Ask before closing an agent or terminal tab, since it ends the running session."
      >
        <Switch
          checked={appConfig.confirmCloseSession}
          onChange={(checked) => void updateAppConfig({ confirmCloseSession: checked })}
        />
      </Field>
      {runtime === "desktop" && (
        <Field
          label="Run in background"
          hint="Closing the window keeps the daemon running in the tray."
        >
          <Switch
            checked={appConfig.runInBackground}
            onChange={(checked) => void updateAppConfig({ runInBackground: checked })}
          />
        </Field>
      )}
      {runtime === "web" && pushSupported() && <PushNotificationsField />}
      {runtime === "web" && (
        <Field
          label="Reload app"
          hint="Fetch the latest version. Use this if the app looks out of date after an update."
        >
          <Button size="sm" variant="outline" disabled={reloading} onClick={() => void reloadApp()}>
            {reloading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Reload
          </Button>
        </Field>
      )}
      <Field label="Runtime">
        <span className="text-sm text-neutral-400">{runtime}</span>
      </Field>
      <Field label="Active server">
        <span className="text-sm text-neutral-400">{active?.name ?? "—"}</span>
      </Field>
    </div>
  );
};

/**
 * Web-push opt-in. Rendered by {@link AppSettings} only when
 * `runtime === "web" && pushSupported()`, so the desktop never mounts it. The
 * switch reflects the live `PushSubscription` presence (the single global
 * notification preference), loaded async on mount.
 */
const PushNotificationsField: React.FC = () => {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [denied, setDenied] = useState(
    typeof Notification !== "undefined" && Notification.permission === "denied"
  );
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Load the live subscription state on mount.
  useEffect(() => {
    let active = true;
    getSubscription()
      .then((sub) => {
        if (active) setEnabled(!!sub);
      })
      .catch(() => {
        /* leave disabled */
      });
    return () => {
      active = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    setHint(null);
    // Optimistic; revert on failure.
    setEnabled(next);
    try {
      if (next) {
        await enablePush(api);
        setDenied(false);
      } else {
        await disablePush(api);
      }
    } catch (err) {
      setEnabled(!next);
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        setDenied(true);
      }
      setHint(err instanceof Error ? err.message : "Could not update notifications.");
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setHint(null);
    try {
      const res = await api.pushTest();
      setHint(
        res.sent > 0
          ? `Test sent to ${res.sent} device${res.sent === 1 ? "" : "s"}.`
          : "No devices subscribed."
      );
    } catch (err) {
      setHint(err instanceof Error ? err.message : "Could not send a test notification.");
    } finally {
      setTesting(false);
    }
  };

  const hintText = denied
    ? "Notifications are blocked. Allow them in your browser's site settings to enable."
    : hint ?? "Get a push when an agent session needs your attention.";

  return (
    <>
      <Field label="Push notifications" hint={hintText}>
        <Switch
          checked={enabled && !denied}
          disabled={busy || denied}
          onChange={(v) => void toggle(v)}
        />
      </Field>
      {enabled && !denied && (
        <div className="flex justify-end py-2">
          <Button size="sm" variant="outline" disabled={testing} onClick={() => void sendTest()}>
            {testing ? <Loader2 size={13} className="animate-spin" /> : <Bell size={13} />} Send test
          </Button>
        </div>
      )}
    </>
  );
};

const DaemonSettings: React.FC = () => {
  const api = useApi();
  const connections = useAppStore((s) => s.connections);
  const activeId = useAppStore((s) => s.activeConnectionId);
  const isLocal = connections.find((c) => c.id === activeId)?.kind === "local";

  const [workspacesDir, setWorkspacesDir] = useState("");
  const [httpEnabled, setHttpEnabled] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getDaemonConfig()
      .then((config: DaemonConfig) => {
        if (!active) return;
        setWorkspacesDir(config.workspacesDir);
        setHttpEnabled(config.transports.http.enabled);
        setHost(config.transports.http.host);
        setPort(String(config.transports.http.port));
      })
      .catch(() => setMessage("Could not load daemon config."));
    return () => {
      active = false;
    };
  }, [api]);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.updateDaemonConfig({
        workspacesDir,
        // Partial patch: the daemon merges onto its existing http config, so
        // unmanaged fields (username, fsRoot, passwordHash) are preserved.
        transports: {
          http: {
            enabled: httpEnabled,
            host,
            port: Number(port) || 47831,
            ...(password ? { password } : {})
          } as DaemonConfig["transports"]["http"]
        }
      });
      setPassword("");
      setMessage("Saved. Transport changes apply after a daemon restart.");
    } catch {
      setMessage("Failed to save (daemon config is editable only over the local socket).");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!isLocal && (
        <div className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-400">
          Daemon settings can only be changed from the local app (unix socket). Connected over HTTP
          they are read-only.
        </div>
      )}

      <div className="divide-y divide-neutral-800">
        <Field label="Workspaces directory" hint="Supports $userhome / $appdir variables.">
          <Input
            className="w-40 sm:w-64"
            value={workspacesDir}
            disabled={!isLocal}
            onChange={(e) => setWorkspacesDir(e.target.value)}
          />
        </Field>

        <Field label="External HTTP access" hint="Expose the daemon to remote clients (token-gated).">
          <Switch checked={httpEnabled} disabled={!isLocal} onChange={setHttpEnabled} />
        </Field>

        {httpEnabled && (
          <>
            <Field label="Host">
              <Input
                className="w-40 sm:w-64"
                value={host}
                disabled={!isLocal}
                onChange={(e) => setHost(e.target.value)}
              />
            </Field>
            <Field label="Port">
              <Input
                className="w-40 sm:w-64"
                value={port}
                disabled={!isLocal}
                onChange={(e) => setPort(e.target.value)}
              />
            </Field>
            <Field label="Password" hint="Min 8 chars. Leave blank to keep current.">
              <Input
                className="w-40 sm:w-64"
                type="password"
                placeholder="••••••••"
                value={password}
                disabled={!isLocal}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </>
        )}
      </div>

      {message && <p className="text-xs text-neutral-400">{message}</p>}

      {isLocal && (
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Save daemon config"}
        </Button>
      )}
    </div>
  );
};
