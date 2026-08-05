import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ExternalLink, Key, Link2, Loader2, Plus, Power, RefreshCw, Trash2, Unlink, X } from "lucide-react";
import type {
  CliProxyProviderId,
  CliProxyProviderStatus,
  CliProxyRouterModel,
  CliProxyRouterProviderRequest,
  CliProxyRouterProviderStatus,
  CliProxyStatus,
  CliProxyXaiStatus
} from "@orquester/api";
import {
  CURATED_PROXY_MODELS,
  CURATED_PROXY_MODEL_IDS,
  MODEL_NAME_RE,
  ROUTER_PRESETS,
  ROUTER_PROVIDER_ID_RE,
  XAI_OAUTH_MODELS,
  XAI_OAUTH_MODEL_IDS
} from "@orquester/config";
import { cn } from "../../lib/cn";
import { Button, Input } from "../ui";
import { useAppStore } from "../../store/app";

const PROVIDER_LABEL: Record<CliProxyProviderId, string> = {
  codex: "Codex",
  claude: "Claude"
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

/** The id a router model is shown and keyed under (picker chips, overrides). */
const modelDisplayId = (m: CliProxyRouterModel): string => m.alias ?? m.name;

type RunFn = (fn: () => Promise<unknown>) => Promise<void>;
type RestartConfirmFn = (
  attempt: (force: boolean) => Promise<CliProxyStatus | { ok: boolean; affectedSessions?: number }>
) => Promise<void>;

export const ModelProxySettings: React.FC = () => {
  const status = useAppStore((s) => s.cliproxy);
  const models = useAppStore((s) => s.cliproxyModels);
  // Every model the pickers may offer: the curated picks plus whatever the
  // user's router providers serve (by display id). `?? []` guards a stale
  // bundle/daemon pairing that predates routerProviders (persisted-shape rule).
  const routerProviders = useMemo(() => status?.routerProviders ?? [], [status]);
  // The Grok models are offered while an xAI credential exists — `expired`
  // included, matching the daemon's files-present rule (`xaiLinked()`): the
  // expiry stamp is informational and the proxy refreshes on next use, so the
  // pickers and the launcher gate must not disagree. Unlinking resets a
  // dangling pick daemon-side (`resetDanglingModelPicks`). `?.` guards a
  // daemon/bundle pairing that predates the field (persisted-shape rule).
  const xaiLinked = status?.xai?.state === "linked" || status?.xai?.state === "expired";
  const pickerIds = useMemo(() => {
    const routerModelIds = routerProviders.flatMap((p) => p.models.map(modelDisplayId));
    return [
      ...new Set([
        ...CURATED_PROXY_MODEL_IDS,
        ...routerModelIds,
        ...(xaiLinked ? XAI_OAUTH_MODEL_IDS : [])
      ])
    ];
  }, [routerProviders, xaiLinked]);
  // Picks confirmed by the live catalog (the raw catalog lists every seeded
  // account's models + acc-prefixed duplicates — noise as a picker). With no
  // catalog, offer the whole list; ModelSelect keeps a stale saved value visible
  // either way.
  const modelOptions = useMemo(() => {
    const catalog = models?.models ?? [];
    const confirmed = catalog.length ? pickerIds.filter((m) => catalog.includes(m)) : [...pickerIds];
    return confirmed.length ? confirmed : [...pickerIds];
  }, [models, pickerIds]);
  // Context-window rows: curated models first, then any router model not already
  // covered by a curated row of the same id.
  const contextRows = useMemo(() => {
    const rows: { id: string; contextWindow?: number; compactWindow?: number; compactPct?: number }[] =
      CURATED_PROXY_MODELS.map((m) => ({
        id: m.id,
        contextWindow: m.contextWindow,
        compactWindow: m.compactWindow,
        compactPct: m.compactPct
      }));
    const seen = new Set(rows.map((r) => r.id));
    if (xaiLinked) {
      for (const m of XAI_OAUTH_MODELS) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        rows.push({ id: m.id, contextWindow: m.contextWindow, compactWindow: m.compactWindow });
      }
    }
    for (const p of routerProviders) {
      for (const m of p.models) {
        const id = modelDisplayId(m);
        if (seen.has(id)) continue;
        seen.add(id);
        rows.push({
          id,
          contextWindow: m.contextWindow,
          compactWindow: m.compactWindow,
          compactPct: m.compactPct
        });
      }
    }
    return rows;
  }, [routerProviders, xaiLinked]);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  const enableCliProxy = useAppStore((s) => s.enableCliProxy);
  const disableCliProxy = useAppStore((s) => s.disableCliProxy);
  const seedCliProxyAccount = useAppStore((s) => s.seedCliProxyAccount);
  const unseedCliProxyAccount = useAppStore((s) => s.unseedCliProxyAccount);
  const setCliProxyConfig = useAppStore((s) => s.setCliProxyConfig);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch status + model catalog when the panel opens (in case nothing has yet).
  useEffect(() => {
    void loadCliProxy();
  }, [loadCliProxy]);

  const run = useCallback<RunFn>(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // Restart-gated mutations (config/router provider/router key) refuse with
  // { ok:false, affectedSessions } while dependent sessions are live; on refusal,
  // confirm the session count with the user then re-attempt with force.
  const withRestartConfirm = useCallback<RestartConfirmFn>(async (attempt) => {
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
  }, []);

  if (!status) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-sm text-neutral-500">
        <Loader2 size={14} className="animate-spin" /> Loading proxy status…
      </div>
    );
  }

  const enabled = status.state !== "off";
  const working = busy || isBusyState(status.state);

  // Overrides are replaced wholesale by the route, so every edit sends the full
  // next record; an entry with no fields left is dropped (back to the default).
  const saveOverride = (
    id: string,
    patch: { contextWindow?: number; compactWindow?: number; compactPct?: number }
  ) => {
    const current = status.modelOverrides ?? {};
    const merged = { ...(current[id] ?? {}), ...patch };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
    const next = { ...current };
    if (Object.keys(cleaned).length === 0) delete next[id];
    else next[id] = cleaned;
    run(() => setCliProxyConfig({ modelOverrides: next }));
  };

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
        <p className="text-sm text-neutral-200">Run GPT &amp; router models in the Claude Code harness.</p>
        <p className="text-xs text-neutral-500">
          A managed proxy lets the <code>claudex</code> and <code>claudemix</code> launchers drive
          other models through the same interface — seeded from your existing accounts, plus any
          OpenAI-compatible router you add.
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

      {/* OAuth accounts (codex/claude) — credential-seeded, no keys involved */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Accounts</h3>
        <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {status.providers.map((p) => (
            <ProviderRow
              key={p.provider}
              provider={p}
              accounts={(agentAccounts?.accounts ?? []).filter((a) => a.agent === p.provider)}
              seeded={status.accounts.filter((a) => a.provider === p.provider)}
              busy={busy}
              onSeed={(accountId) => run(() => seedCliProxyAccount({ provider: p.provider, accountId }))}
              onUnseed={(accountId) =>
                run(() => unseedCliProxyAccount({ provider: p.provider, accountId }))
              }
            />
          ))}
        </div>
        {/* xAI OAuth (Grok): no key, no seeded credential — the proxy owns the
            tokens, so this card only drives the device-code link (spec §B.5). */}
        {/* degraded still has a reachable management API — the daemon accepts links there too */}
        <XaiAccountCard
          xai={status.xai}
          proxyRunning={status.state === "healthy" || status.state === "degraded"}
          busy={busy}
          run={run}
        />
      </section>

      {/* Key-based OpenAI-compatible routers (spec 2026-08-04 §3) */}
      <RoutersSection
        routers={routerProviders}
        busy={busy}
        run={run}
        withRestartConfirm={withRestartConfirm}
      />

      {/* Model defaults */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Model defaults</h3>
        <ModelSelect
          label="Default model"
          hint="What claudex runs unless a launch chip overrides it."
          value={status.defaultModel}
          options={modelOptions}
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
          options={modelOptions}
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

      {/* Context windows — per-model compact tuning (spec §3.2). Values are the
          launch-time env knobs; blank = the built-in / router-provider default. */}
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-neutral-200">Context windows</h3>
        <p className="text-xs text-neutral-500">
          Per-model context ceiling and auto-compact window for proxy launches. Blank fields use
          the built-in defaults; changes apply to new tabs (no proxy restart).
        </p>
        {contextRows.map((m) => {
          // Defensive read: a stale bundle/daemon pairing can serve a status
          // without the field (persisted-shape rule) — never crash the panel.
          const o = (status.modelOverrides ?? {})[m.id] ?? {};
          return (
            <div key={m.id} className="flex items-center gap-2 text-sm">
              <span className="w-32 truncate text-neutral-300" title={m.id}>
                {m.id}
              </span>
              <NumberField
                label="window"
                placeholder={m.contextWindow !== undefined ? String(m.contextWindow) : "default"}
                value={o.contextWindow}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { contextWindow: v })}
              />
              <NumberField
                label="compact at"
                placeholder={String(m.compactWindow ?? m.contextWindow ?? "default")}
                value={o.compactWindow}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { compactWindow: v })}
              />
              <NumberField
                label="pct"
                placeholder={m.compactPct !== undefined ? String(m.compactPct) : "default"}
                value={o.compactPct}
                disabled={busy}
                onCommit={(v) => saveOverride(m.id, { compactPct: v })}
              />
            </div>
          );
        })}
      </section>
    </div>
  );
};

const NumberField: React.FC<{
  label: string;
  placeholder: string;
  value: number | undefined;
  disabled: boolean;
  onCommit: (v: number | undefined) => void;
}> = ({ label, placeholder, value, disabled, onCommit }) => {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  useEffect(() => setText(value === undefined ? "" : String(value)), [value]);
  const commit = () => {
    if (text.trim() === "") {
      if (value !== undefined) onCommit(undefined); // no-op blur must not PUT
      return;
    }
    const n = Number(text);
    if (Number.isInteger(n) && n > 0) {
      if (n !== value) onCommit(n); // unchanged value must not PUT
    } else {
      setText(value === undefined ? "" : String(value)); // revert invalid input
    }
  };
  return (
    <label className="flex items-center gap-1 text-xs text-neutral-500">
      {label}
      <Input
        className="w-24"
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
    </label>
  );
};

const ProviderRow: React.FC<{
  provider: CliProxyProviderStatus;
  accounts: { id: string; label: string; email: string | null }[];
  seeded: { id: string; label: string; email?: string }[];
  busy: boolean;
  onSeed: (accountId: string) => void;
  onUnseed: (accountId: string) => void;
}> = ({ provider, accounts, seeded, busy, onSeed, onUnseed }) => {
  const [seeding, setSeeding] = useState(false);
  const ok = provider.state === "ok";

  const stateText = ok
    ? formatVerified(provider.lastVerifiedAt)
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
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setSeeding((v) => !v)}>
          {ok ? (
            <>
              <RefreshCw size={12} /> Seed / Re-seed
            </>
          ) : (
            "Seed from account"
          )}
        </Button>
      </div>

      {seeding && (
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
                {seeded.some((s) => s.id === a.id) ? (
                  <span className="shrink-0 text-[10px] text-emerald-400/70">seeded · click to refresh</span>
                ) : (
                  <span className="shrink-0 text-[10px] text-neutral-500">not seeded · click to add</span>
                )}
              </button>
            ))
          )}
        </div>
      )}

      {seeded.length > 0 && (
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
    </div>
  );
};

/** Absolute stamp for the proxy-owned token expiry (a relative "in 3h" would
 *  imply Orquester tracks the refresh — it does not; the proxy does). */
const formatStamp = (iso: string | null): string => {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

/**
 * The xAI (Grok) account card. Unlike every other proxy credential this one is
 * linked by an RFC 8628 device-code prompt the daemon drives against the proxy's
 * management API, and the proxy — not Orquester — owns and refreshes the tokens.
 * Nothing here is a secret: the verification URL and user code are meant to be
 * read out loud. State advances through the normal `cliproxy.changed` broadcast,
 * so the card just fires the mutation and lets the status stream do the rest.
 */
const XaiAccountCard: React.FC<{
  xai: CliProxyXaiStatus | undefined;
  proxyRunning: boolean;
  busy: boolean;
  run: RunFn;
}> = ({ xai, proxyRunning, busy, run }) => {
  const api = useAppStore((s) => s.api);
  const loadCliProxy = useAppStore((s) => s.loadCliProxy);
  // A daemon/bundle pairing that predates the field serves no `xai` at all.
  const state = xai?.state ?? "none";
  const link = xai?.link ?? null;

  // Unlink is session-gated like the router mutations (409 → affectedSessions),
  // but nothing restarts — the proxy hot-discovers the auth-dir change — so the
  // confirm copy talks about losing Grok access, not about a proxy restart.
  // Returns false when the user declines the forced retry.
  const confirmedUnlink = async (): Promise<boolean> => {
    if (!api) throw new Error("not connected");
    const res = await api.unlinkCliProxyXai();
    if ("ok" in res && res.ok === false) {
      const n = res.affectedSessions ?? 0;
      if (
        !window.confirm(
          `${n} running session${n === 1 ? "" : "s"} use Grok models and will lose ` +
            `access when the account is unlinked. Continue?`
        )
      ) {
        return false;
      }
      await api.unlinkCliProxyXai(true);
    }
    return true;
  };

  const startLink = () =>
    run(async () => {
      if (!api) throw new Error("not connected");
      await api.linkCliProxyXai();
      await loadCliProxy();
    });

  const dropLink = () =>
    run(async () => {
      await confirmedUnlink();
      await loadCliProxy();
    });

  // Expired means the refresh token is dead: unlink first so the new device flow
  // is not refused as "already linked".
  const relink = () =>
    run(async () => {
      if (!api) throw new Error("not connected");
      if (!(await confirmedUnlink())) return;
      await api.linkCliProxyXai();
      await loadCliProxy();
    });

  const ok = state === "linked";

  return (
    <div className="rounded-lg border border-neutral-800 px-3 py-2.5">
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
          <p className="truncate text-sm text-neutral-100">Grok account</p>
          {state === "linked" && (
            <p className="truncate text-xs text-emerald-400/80">
              {xai?.email ?? "linked"} · token valid until {formatStamp(xai?.expiredAt ?? null)}
            </p>
          )}
          {state === "expired" && (
            <p className="truncate text-xs text-amber-400/80">
              token expired {formatStamp(xai?.expiredAt ?? null)} — the proxy retries the refresh on
              next use; link again if Grok launches fail
            </p>
          )}
          {state === "linking" && (
            <p className="truncate text-xs text-sky-300">waiting for you to approve the device code…</p>
          )}
          {state === "none" && <p className="truncate text-xs text-neutral-500">not linked</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {state === "none" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !proxyRunning}
              title={proxyRunning ? undefined : "Start the model proxy first"}
              onClick={startLink}
            >
              <Link2 size={12} /> Link Grok account
            </Button>
          )}
          {state === "expired" && (
            <Button size="sm" variant="outline" disabled={busy || !proxyRunning} onClick={relink}>
              <RefreshCw size={12} /> Link again
            </Button>
          )}
          {state === "linking" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={dropLink}>
              Cancel
            </Button>
          )}
          {(state === "linked" || state === "expired") && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={dropLink} title="Unlink Grok account">
              <Unlink size={12} />
            </Button>
          )}
        </div>
      </div>

      {state === "linking" && link && (
        <div className="ml-8 mt-2 space-y-1 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <a
            href={link.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-sky-400 hover:underline"
          >
            <ExternalLink size={12} /> {link.url}
          </a>
          <p className="text-xs text-neutral-400">
            Code: <span className="font-mono text-sm text-neutral-100">{link.userCode}</span>
          </p>
          <p className="text-[11px] text-neutral-600">Expires {formatStamp(link.expiresAt)}.</p>
        </div>
      )}

      {state !== "linking" && xai?.lastLinkError && (
        <p className="ml-8 mt-2 text-[11px] text-red-400/80">
          Last link attempt failed: {xai.lastLinkError}
        </p>
      )}

      {xai?.lastQuotaError && (
        <p className="ml-8 mt-2 text-[11px] text-amber-400/80">
          Last quota error: {xai.lastQuotaError} — xAI cools the account for 24 h after this.
        </p>
      )}

      <p className="ml-8 mt-2 text-[11px] text-neutral-600">
        Runs your SuperGrok subscription through a reverse-engineered first-party-client contract:
        it can break or be rate-limited without notice, and no quota readout is possible.
      </p>
    </div>
  );
};

const RoutersSection: React.FC<{
  routers: CliProxyRouterProviderStatus[];
  busy: boolean;
  run: RunFn;
  withRestartConfirm: RestartConfirmFn;
}> = ({ routers, busy, run, withRestartConfirm }) => {
  const putProvider = useAppStore((s) => s.putCliProxyRouterProvider);
  const deleteProvider = useAppStore((s) => s.deleteCliProxyRouterProvider);
  const setKey = useAppStore((s) => s.setCliProxyRouterKey);
  const clearKey = useAppStore((s) => s.clearCliProxyRouterKey);
  const [adding, setAdding] = useState(false);

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-neutral-200">Routers</h3>
          <p className="text-xs text-neutral-500">
            Key-based OpenAI-compatible gateways. Their models are keyless at launch — the account
            chip does not apply.
          </p>
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding((v) => !v)}>
          <Plus size={12} /> Add router
        </Button>
      </div>

      {adding && (
        <AddRouterForm
          existingIds={routers.map((r) => r.id)}
          busy={busy}
          onCancel={() => setAdding(false)}
          onCreate={(id, cfg) => {
            setAdding(false);
            void run(() => withRestartConfirm((force) => putProvider(id, cfg, force)));
          }}
        />
      )}

      <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {routers.length === 0 && !adding && (
          <p className="px-3 py-2.5 text-xs text-neutral-500">
            No routers yet. Add OpenRouter, TokenRouter, or any OpenAI-compatible gateway.
          </p>
        )}
        {routers.map((r) => (
          <RouterRow
            key={r.id}
            router={r}
            busy={busy}
            onSaveKey={(key) => run(() => withRestartConfirm((force) => setKey(r.id, key, force)))}
            onClearKey={() => run(() => withRestartConfirm((force) => clearKey(r.id, force)))}
            onSaveModels={(models) =>
              run(() =>
                withRestartConfirm((force) =>
                  putProvider(r.id, { label: r.label, baseUrl: r.baseUrl, preset: r.preset, models }, force)
                )
              )
            }
            onDelete={() => {
              if (window.confirm(`Delete router "${r.label}" and its stored key?`)) {
                void run(() => withRestartConfirm((force) => deleteProvider(r.id, force)));
              }
            }}
          />
        ))}
      </div>
    </section>
  );
};

/** Slugify a label into a candidate provider id (lowercase, dash-separated). */
const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

const AddRouterForm: React.FC<{
  existingIds: string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (id: string, cfg: CliProxyRouterProviderRequest) => void;
}> = ({ existingIds, busy, onCancel, onCreate }) => {
  const [preset, setPreset] = useState<"openrouter" | "tokenrouter" | null>(
    ROUTER_PRESETS[0]?.preset ?? null
  );
  const initial = ROUTER_PRESETS.find((p) => p.preset === preset);
  const [id, setId] = useState(initial ? initial.preset : "");
  const [label, setLabel] = useState(initial ? initial.label : "");
  const [baseUrl, setBaseUrl] = useState(initial ? initial.baseUrl : "");
  const [models, setModels] = useState<CliProxyRouterModel[]>(
    initial ? initial.models.map((m) => ({ ...m })) : []
  );

  // Switching preset re-prefills every field — the form is a create surface, so
  // there is nothing worth preserving across the switch.
  const choosePreset = (next: "openrouter" | "tokenrouter" | null) => {
    setPreset(next);
    const p = ROUTER_PRESETS.find((x) => x.preset === next);
    setId(p ? p.preset : "");
    setLabel(p ? p.label : "");
    setBaseUrl(p ? p.baseUrl : "");
    setModels(p ? p.models.map((m) => ({ ...m })) : []);
  };

  const idError = !id
    ? "id is required"
    : !ROUTER_PROVIDER_ID_RE.test(id)
      ? "lowercase letters, digits and dashes only"
      : existingIds.includes(id)
        ? "a router with this id already exists"
        : null;
  const urlError = /^https?:\/\/\S+$/.test(baseUrl) ? null : "must be an http(s) URL";
  const valid = !idError && !urlError && label.trim().length > 0;

  return (
    <div className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
      <div className="flex flex-wrap gap-1.5">
        {ROUTER_PRESETS.map((p) => (
          <button
            key={p.preset}
            type="button"
            disabled={busy}
            onClick={() => choosePreset(p.preset)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              preset === p.preset
                ? "bg-neutral-200 text-neutral-900"
                : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          disabled={busy}
          onClick={() => choosePreset(null)}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
            preset === null
              ? "bg-neutral-200 text-neutral-900"
              : "border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
          )}
        >
          Custom
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-neutral-400">
          <span>Label</span>
          <Input
            value={label}
            placeholder="My router"
            disabled={busy}
            onChange={(e) => {
              const next = e.target.value;
              setLabel(next);
              // Custom routers derive the id from the label until it's edited.
              if (preset === null) setId(slugify(next));
            }}
          />
        </label>
        <label className="space-y-1 text-xs text-neutral-400">
          <span>Id</span>
          <Input value={id} placeholder="my-router" disabled={busy} onChange={(e) => setId(e.target.value)} />
          {idError && <span className="block text-[11px] text-red-400">{idError}</span>}
        </label>
      </div>

      <label className="block space-y-1 text-xs text-neutral-400">
        <span>Base URL</span>
        <Input
          value={baseUrl}
          placeholder="https://api.example.com/v1"
          disabled={busy}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        {urlError && <span className="block text-[11px] text-red-400">{urlError}</span>}
      </label>

      <p className="text-[11px] text-neutral-600">
        {models.length > 0
          ? `${models.length} preset model${models.length === 1 ? "" : "s"} will be enabled — edit them after adding the key.`
          : "No models yet — add the key, then pick models from the router's catalog."}
      </p>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !valid}
          onClick={() => onCreate(id, { label: label.trim(), baseUrl: baseUrl.trim(), preset, models })}
        >
          Add router
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

const KEY_STATE_TEXT: Record<CliProxyRouterProviderStatus["keyState"], string> = {
  none: "no key",
  // A stored key whose verification was inconclusive (network) — honest label
  // instead of a contradictory green-check "never verified".
  set: "key set — not verified yet",
  verified: "verified"
};

const RouterRow: React.FC<{
  router: CliProxyRouterProviderStatus;
  busy: boolean;
  onSaveKey: (key: string) => void;
  onClearKey: () => void;
  onSaveModels: (models: CliProxyRouterModel[]) => void;
  onDelete: () => void;
}> = ({ router, busy, onSaveKey, onClearKey, onSaveModels, onDelete }) => {
  const [keyEntry, setKeyEntry] = useState(false);
  const [editingModels, setEditingModels] = useState(false);
  const [key, setKey] = useState("");
  const hasKey = router.keyState !== "none";
  const stateText =
    router.keyState === "verified" ? formatVerified(router.keyVerifiedAt) : KEY_STATE_TEXT[router.keyState];

  const submitKey = () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setKeyEntry(false);
    setKey("");
    onSaveKey(trimmed);
  };

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
            hasKey ? "bg-emerald-900/50 text-emerald-300" : "bg-neutral-800 text-neutral-500"
          )}
        >
          {hasKey ? <Check size={12} /> : <X size={12} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-neutral-100">{router.label}</p>
          <p className="truncate text-[11px] text-neutral-500">{router.baseUrl}</p>
          <p className={cn("truncate text-xs", hasKey ? "text-emerald-400/80" : "text-neutral-500")}>
            {stateText} · {router.models.length} model{router.models.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setKeyEntry((v) => !v)}>
            <Key size={12} /> {hasKey ? "Replace key" : "Add key"}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditingModels((v) => !v)}>
            Models
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDelete} title="Delete router">
            <Trash2 size={12} />
          </Button>
        </div>
      </div>

      {keyEntry && (
        <div className="ml-8 mt-2 space-y-2 rounded-md border border-neutral-800 bg-neutral-950 p-2">
          <Input
            autoFocus
            type="password"
            placeholder="API key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitKey();
            }}
          />
          <p className="text-[11px] text-neutral-600">
            Stored on the daemon and never displayed again. Imported into the proxy for this
            router's models.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !key.trim()} onClick={submitKey}>
              Save key
            </Button>
            {hasKey && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setKeyEntry(false);
                  setKey("");
                  onClearKey();
                }}
              >
                Remove key
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setKeyEntry(false);
                setKey("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {editingModels && (
        <RouterModelsEditor
          router={router}
          busy={busy}
          onCancel={() => setEditingModels(false)}
          onSave={(models) => {
            setEditingModels(false);
            onSaveModels(models);
          }}
        />
      )}
    </div>
  );
};

/** Cap on rendered catalog rows — real catalogs run 116–500+ entries. */
const CATALOG_RENDER_LIMIT = 120;

const RouterModelsEditor: React.FC<{
  router: CliProxyRouterProviderStatus;
  busy: boolean;
  onCancel: () => void;
  onSave: (models: CliProxyRouterModel[]) => void;
}> = ({ router, busy, onCancel, onSave }) => {
  const getCatalog = useAppStore((s) => s.getCliProxyRouterCatalog);
  const [models, setModels] = useState<CliProxyRouterModel[]>(() => router.models.map((m) => ({ ...m })));
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  // Fetch the upstream catalog once per open. A failure is not fatal: the manual
  // "add model id" path below covers it (spec §4).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getCatalog(router.id)
      .then((res) => {
        if (cancelled) return;
        setCatalog(res.models);
        setCatalogError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCatalog(null);
        setCatalogError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getCatalog, router.id]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.trim().toLowerCase();
    return q ? catalog.filter((m) => m.toLowerCase().includes(q)) : catalog;
  }, [catalog, query]);

  const toggle = (name: string) => {
    setModels((prev) =>
      prev.some((m) => m.name === name) ? prev.filter((m) => m.name !== name) : [...prev, { name }]
    );
  };

  const patch = (name: string, next: Partial<CliProxyRouterModel>) => {
    setModels((prev) => prev.map((m) => (m.name === name ? { ...m, ...next } : m)));
  };

  const addManual = () => {
    const name = manual.trim();
    if (!name) return;
    if (!MODEL_NAME_RE.test(name)) {
      setManualError("invalid model id");
      return;
    }
    if (models.some((m) => m.name === name)) {
      setManualError("already enabled");
      return;
    }
    setModels((prev) => [...prev, { name }]);
    setManual("");
    setManualError(null);
  };

  return (
    <div className="ml-8 mt-2 space-y-3 rounded-md border border-neutral-800 bg-neutral-950 p-2">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Input
            className="flex-1"
            value={query}
            placeholder={loading ? "Loading catalog…" : "Search catalog"}
            disabled={busy || loading || !catalog}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading && <Loader2 size={13} className="animate-spin text-neutral-500" />}
        </div>
        {catalogError && (
          <p className="text-[11px] text-amber-400/80">
            Catalog unavailable ({catalogError}) — add model ids manually below.
          </p>
        )}
        {catalog && (
          <div className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-neutral-800 p-1">
            {filtered.length === 0 && (
              <p className="px-1 py-1 text-[11px] text-neutral-500">No catalog models match.</p>
            )}
            {filtered.slice(0, CATALOG_RENDER_LIMIT).map((name) => (
              <label
                key={name}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={models.some((m) => m.name === name)}
                  onChange={() => toggle(name)}
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </label>
            ))}
            {filtered.length > CATALOG_RENDER_LIMIT && (
              <p className="px-1 py-1 text-[11px] text-neutral-500">
                Showing {CATALOG_RENDER_LIMIT} of {filtered.length} — refine the search.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <p className="text-[11px] text-neutral-500">
          Enabled models ({models.length}) — alias is the id shown in pickers; windows are optional.
        </p>
        {models.length === 0 && (
          <p className="text-[11px] text-neutral-600">None enabled yet.</p>
        )}
        {models.map((m) => (
          <div key={m.name} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="w-40 truncate text-neutral-300" title={m.name}>
              {m.name}
            </span>
            <label className="flex items-center gap-1 text-neutral-500">
              alias
              <Input
                className="w-28"
                value={m.alias ?? ""}
                placeholder="none"
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  patch(m.name, { alias: v === "" ? undefined : v });
                }}
              />
            </label>
            <NumberField
              label="window"
              placeholder="default"
              value={m.contextWindow}
              disabled={busy}
              onCommit={(v) => patch(m.name, { contextWindow: v })}
            />
            <NumberField
              label="compact at"
              placeholder="default"
              value={m.compactWindow}
              disabled={busy}
              onCommit={(v) => patch(m.name, { compactWindow: v })}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => toggle(m.name)}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
              title="Remove model"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Input
            className="flex-1"
            value={manual}
            placeholder="Add model id manually (e.g. moonshotai/kimi-k3-free)"
            disabled={busy}
            onChange={(e) => {
              setManual(e.target.value);
              setManualError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") addManual();
            }}
          />
          <Button size="sm" variant="outline" disabled={busy || !manual.trim()} onClick={addManual}>
            <Plus size={12} /> Add
          </Button>
        </div>
        {manualError && <p className="text-[11px] text-red-400">{manualError}</p>}
      </div>

      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => onSave(models)}>
          Save models
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
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
