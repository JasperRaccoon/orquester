import React, { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Power, RefreshCw, X } from "lucide-react";
import type { CliProxyProviderId, CliProxyProviderStatus, CliProxyStatus } from "@orquester/api";
import { CURATED_PROXY_MODELS } from "@orquester/config";
import { cn } from "../../lib/cn";
import { Button, Input } from "../ui";
import { useAppStore } from "../../store/app";

const PROVIDER_LABEL: Record<CliProxyProviderId, string> = {
  codex: "Codex",
  claude: "Claude",
  openrouter: "OpenRouter"
};

// Manager states, ordered off → healthy, with copy for the header pill.
const STATE_LABEL: Record<CliProxyStatus["state"], string> = {
  off: "Off",
  downloading: "Downloading…",
  building: "Building…",
  starting: "Starting…",
  healthy: "Running",
  degraded: "Degraded",
  error: "Error"
};

const STATE_TONE: Record<CliProxyStatus["state"], string> = {
  off: "bg-neutral-800 text-neutral-300",
  downloading: "bg-sky-900/40 text-sky-300",
  building: "bg-sky-900/40 text-sky-300",
  starting: "bg-sky-900/40 text-sky-300",
  healthy: "bg-emerald-900/40 text-emerald-300",
  degraded: "bg-amber-900/40 text-amber-300",
  error: "bg-red-900/40 text-red-300"
};

const isBusyState = (s: CliProxyStatus["state"]) =>
  s === "downloading" || s === "building" || s === "starting";

const formatVerified = (iso: string | null): string => {
  if (!iso) return "never verified";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "verified";
  const diff = Date.now() - t;
  if (diff < 60_000) return "verified just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `verified ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `verified ${hrs}h ago`;
  return `verified ${Math.floor(hrs / 24)}d ago`;
};

export const ModelProxySettings: React.FC = () => {
  const status = useAppStore((s) => s.cliproxy);
  const models = useAppStore((s) => s.cliproxyModels);
  // Curated picks confirmed by the live catalog (the raw catalog lists every
  // seeded account's models + acc-prefixed duplicates — noise as a picker).
  // With no catalog, offer the whole curated list; ModelSelect keeps a stale
  // saved value visible either way.
  const curatedOptions = useMemo(() => {
    const catalog = models?.models ?? [];
    const confirmed = catalog.length
      ? CURATED_PROXY_MODELS.filter((m) => catalog.includes(m))
      : [...CURATED_PROXY_MODELS];
    return confirmed.length ? confirmed : [...CURATED_PROXY_MODELS];
  }, [models]);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const enableCliProxy = useAppStore((s) => s.enableCliProxy);
  const disableCliProxy = useAppStore((s) => s.disableCliProxy);
  const seedCliProxyAccount = useAppStore((s) => s.seedCliProxyAccount);
  const unseedCliProxyAccount = useAppStore((s) => s.unseedCliProxyAccount);
  const setCliProxyOpenRouterKey = useAppStore((s) => s.setCliProxyOpenRouterKey);
  const setCliProxyConfig = useAppStore((s) => s.setCliProxyConfig);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch status + model catalog when the panel opens (in case nothing has yet).
  useEffect(() => {
    void loadCliProxy();
  }, [loadCliProxy]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Restart-gated mutations (config/openrouter-key) refuse with { ok:false,
  // affectedSessions } while dependent sessions are live; on refusal, confirm
  // the session count with the user then re-attempt with force.
  const withRestartConfirm = async (
    attempt: (force: boolean) => Promise<CliProxyStatus | { ok: boolean; affectedSessions?: number }>
  ): Promise<void> => {
    const res = await attempt(false);
    if (res && "ok" in res && res.ok === false) {
      const n = res.affectedSessions ?? 0;
      if (
        window.confirm(
          `This restarts the model proxy and will close ${n} running ` +
            `session${n === 1 ? "" : "s"}. Continue?`
        )
      ) {
        await attempt(true);
      }
    }
  };

  if (!status) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-sm text-neutral-500">
        <Loader2 size={14} className="animate-spin" /> Loading proxy status…
      </div>
    );
  }

  const enabled = status.state !== "off";
  const working = busy || isBusyState(status.state);

  const toggle = () => {
    if (enabled) {
      if (
        status.activeSessionCount > 0 &&
        !window.confirm(
          `Disabling the model proxy will close ${status.activeSessionCount} running ` +
            `session${status.activeSessionCount === 1 ? "" : "s"}. Continue?`
        )
      ) {
        return;
      }
      void run(() => disableCliProxy(status.activeSessionCount > 0));
    } else {
      void run(() => enableCliProxy());
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-neutral-200">Run GPT &amp; Kimi in the Claude Code harness.</p>
        <p className="text-xs text-neutral-500">
          A managed proxy lets the <code>claudex</code> and <code>claudemix</code> launchers drive
          other models through the same interface — seeded from your existing accounts, no extra login.
        </p>
      </div>

      {/* Status header */}
      <div className="flex items-center gap-3 rounded-lg border border-neutral-800 px-3 py-3">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
            STATE_TONE[status.state]
          )}
        >
          {isBusyState(status.state) ? <Loader2 size={11} className="animate-spin" /> : null}
          {STATE_LABEL[status.state]}
        </span>
        <div className="min-w-0 flex-1">
          {status.detail ? <p className="truncate text-xs text-neutral-400">{status.detail}</p> : null}
          {status.version ? (
            <p className="truncate text-[11px] text-neutral-600">CLIProxyAPI {status.version}</p>
          ) : null}
          {status.reasons.length > 0 && (
            <ul className="mt-0.5 space-y-0.5">
              {status.reasons.map((r, i) => (
                <li key={i} className="truncate text-[11px] text-amber-400/80">
                  {r}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Button size="sm" variant={enabled ? "outline" : "default"} disabled={working} onClick={toggle}>
          {working ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
          {enabled ? "Disable" : "Enable"}
        </Button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Per-provider chips */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Providers</h3>
        <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {status.providers.map((p) => (
            <ProviderRow
              key={p.provider}
              provider={p}
              accounts={(agentAccounts?.accounts ?? []).filter(
                (a) => p.provider !== "openrouter" && a.agent === p.provider
              )}
              seeded={status.accounts.filter((a) => a.provider === p.provider)}
              busy={busy}
              onSeed={(accountId) =>
                run(() =>
                  seedCliProxyAccount({ provider: p.provider as "codex" | "claude", accountId })
                )
              }
              onUnseed={(accountId) =>
                run(() =>
                  unseedCliProxyAccount({ provider: p.provider as "codex" | "claude", accountId })
                )
              }
              onSaveKey={(key) =>
                run(() => withRestartConfirm((force) => setCliProxyOpenRouterKey(key, force)))
              }
            />
          ))}
        </div>
      </section>

      {/* Model defaults */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Model defaults</h3>
        <ModelSelect
          label="Default model"
          hint="What claudex runs unless a launch chip overrides it."
          value={status.defaultModel}
          options={curatedOptions}
          stale={!models}
          disabled={busy}
          onChange={(m) =>
            run(() => withRestartConfirm((force) => setCliProxyConfig({ defaultModel: m }, force)))
          }
        />
        <ModelSelect
          label="Background model"
          hint="Used for lightweight background turns (summaries, titles)."
          value={status.backgroundModel}
          options={curatedOptions}
          stale={!models}
          disabled={busy}
          onChange={(m) =>
            run(() => withRestartConfirm((force) => setCliProxyConfig({ backgroundModel: m }, force)))
          }
        />
        {!models && (
          <p className="text-[11px] text-amber-400/80">
            Proxy offline — the model list may be stale. Your saved selections are kept.
          </p>
        )}
      </section>
    </div>
  );
};

const ProviderRow: React.FC<{
  provider: CliProxyProviderStatus;
  accounts: { id: string; label: string; email: string | null }[];
  seeded: { id: string; label: string; email?: string }[];
  busy: boolean;
  onSeed: (accountId: string) => void;
  onUnseed: (accountId: string) => void;
  onSaveKey: (key: string) => void;
}> = ({ provider, accounts, seeded, busy, onSeed, onUnseed, onSaveKey }) => {
  const [seeding, setSeeding] = useState(false);
  const [keyEntry, setKeyEntry] = useState(false);
  const [key, setKey] = useState("");
  const ok = provider.state === "ok";
  const isOpenRouter = provider.provider === "openrouter";

  const stateText = ok
    ? isOpenRouter && !provider.lastVerifiedAt
      ? // A stored key whose verification was inconclusive (network) — honest
        // label instead of the contradictory green-check "never verified".
        "key set — not verified yet"
      : formatVerified(provider.lastVerifiedAt)
    : provider.state === "expired"
      ? "expired — re-seed to refresh"
      : "not connected";

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
            ok ? "bg-emerald-900/50 text-emerald-300" : "bg-neutral-800 text-neutral-500"
          )}
        >
          {ok ? <Check size={12} /> : <X size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-100">{PROVIDER_LABEL[provider.provider]}</p>
          <p className={cn("truncate text-xs", ok ? "text-emerald-400/80" : "text-neutral-500")}>
            {stateText}
          </p>
        </div>
        {!ok &&
          (isOpenRouter ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setKeyEntry((v) => !v)}>
              Add key
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setSeeding((v) => !v)}>
              Seed from account
            </Button>
          ))}
        {ok && !isOpenRouter && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setSeeding((v) => !v)}>
            <RefreshCw size={12} /> Re-seed
          </Button>
        )}
      </div>

      {seeding && !isOpenRouter && (
        <div className="ml-8 mt-2 space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          {accounts.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No managed {PROVIDER_LABEL[provider.provider]} accounts. Import one in Settings → Accounts.
            </p>
          ) : (
            accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  setSeeding(false);
                  onSeed(a.id);
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.email ? <span className="shrink-0 text-xs text-neutral-500">{a.email}</span> : null}
              </button>
            ))
          )}
        </div>
      )}

      {!isOpenRouter && seeded.length > 0 && (
        <div className="ml-8 mt-2 space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          {seeded.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-neutral-200"
            >
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.email ? <span className="shrink-0 text-xs text-neutral-500">{a.email}</span> : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Un-seed ${a.label}? Orquester will resume managing this account's ` +
                        `token and the proxy will stop using it.`
                    )
                  ) {
                    onUnseed(a.id);
                  }
                }}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
              >
                <X size={12} /> Un-seed
              </button>
            </div>
          ))}
        </div>
      )}

      {keyEntry && isOpenRouter && (
        <div className="ml-8 mt-2 space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <Input
            autoFocus
            type="password"
            placeholder="OpenRouter API key (sk-or-…)"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && key.trim()) {
                setKeyEntry(false);
                onSaveKey(key.trim());
                setKey("");
              }
            }}
          />
          <p className="text-[11px] text-neutral-600">
            Stored on the daemon and never displayed again. Imported into the proxy for Kimi routing.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || !key.trim()}
              onClick={() => {
                setKeyEntry(false);
                onSaveKey(key.trim());
                setKey("");
              }}
            >
              Save key
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setKeyEntry(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const ModelSelect: React.FC<{
  label: string;
  hint: string;
  value: string;
  options: string[];
  stale: boolean;
  disabled: boolean;
  onChange: (model: string) => void;
}> = ({ label, hint, value, options, stale, disabled, onChange }) => {
  // Always include the persisted value even when the catalog fetch failed, so a
  // saved default never renders blank (spec §5).
  const opts = useMemo(() => {
    const set = new Set(options);
    if (value) set.add(value);
    return [...set];
  }, [options, value]);

  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className="text-sm text-neutral-200">{label}</p>
        <p className="text-xs text-neutral-500">{hint}</p>
      </div>
      <select
        className="w-44 shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 disabled:opacity-50 sm:w-56"
        value={value}
        disabled={disabled}
        onChange={(e) => e.target.value !== value && onChange(e.target.value)}
      >
        {opts.map((m) => (
          <option key={m} value={m}>
            {m}
            {stale && m === value ? " (saved)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
};
