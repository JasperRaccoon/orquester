import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, ExternalLink, Loader2, RefreshCw, Settings2, XCircle } from "lucide-react";
import type {
  BlacksmithSetupResponse,
  BlacksmithSetupStep,
  BlacksmithSetupStepState,
  BoxProviderInfo,
  OwnerSummary,
  SetBlacksmithSetupRequest
} from "@orquester/api";

import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { boxesErrorText } from "../../../lib/boxes/errors";
import {
  loadBlacksmithSetup,
  saveBlacksmithSetup,
  startBlacksmithTest,
  useBlacksmithSetup,
  useBoxes
} from "../../../lib/boxes/store";
import { Button } from "../../ui";
import { Badge } from "../../settings/primitives";
import { ProviderTile } from "./ProviderTile";
import { providerSubline } from "./providers.logic";
import {
  blacksmithAccounts,
  blacksmithBusy,
  blacksmithCanPickOrg,
  blacksmithCanTest,
  blacksmithOrgs,
  blacksmithStatus,
  nextBlacksmithPoll
} from "./blacksmith.logic";

const STEP_ICON: Record<BlacksmithSetupStepState, React.ReactNode> = {
  todo: <Circle size={14} className="text-neutral-600" />,
  running: <Loader2 size={14} className="animate-spin text-info" />,
  ok: <CheckCircle2 size={14} className="text-ok" />,
  "action-needed": <AlertTriangle size={14} className="text-warn" />,
  failed: <XCircle size={14} className="text-danger" />
};

const NEW_ORG_URL = "https://github.com/account/organizations/new";

const selectClass =
  "h-7 min-w-0 max-w-full rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-base text-neutral-100 disabled:opacity-50 sm:text-xs";

/**
 * Re-read the setup while a step runs (the daemon sends no event for it): on
 * every boxes change (the test box appears, connects and goes) and on a
 * growing delay, until the steps settle or the deadline passes.
 */
function useFollowRunningSetup(setup: BlacksmithSetupResponse | null): void {
  const api = useAppStore((s) => s.api);
  const boxes = useBoxes();
  const busy = blacksmithBusy(setup);

  useEffect(() => {
    if (!busy || !api) return;
    void loadBlacksmithSetup(api).catch(() => undefined);
  }, [busy, api, boxes]);

  useEffect(() => {
    if (!busy || !api) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let previous: number | null = null;
    // A read in flight when the effect ends must not schedule another.
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      const delay = nextBlacksmithPoll(previous, startedAt, Date.now());
      if (delay === null) return;
      previous = delay;
      timer = setTimeout(() => {
        void loadBlacksmithSetup(api)
          .catch(() => undefined)
          .finally(schedule);
      }, delay);
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [busy, api]);
}

/** The Blacksmith (macOS) row: its status and, expanded, the five-step checklist. */
export const BlacksmithRow: React.FC<{ provider: BoxProviderInfo }> = ({ provider }) => {
  const setup = useBlacksmithSetup();
  const [open, setOpen] = useState(false);
  const status = blacksmithStatus(setup);
  const subline = providerSubline(provider);
  useFollowRunningSetup(setup);

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${provider.label} setup`}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <ProviderTile provider={provider} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-neutral-100">{provider.label} (macOS)</span>
            <span className="block truncate text-xs text-neutral-500">
              {subline || "macOS boxes as GitHub Actions jobs in your org"}
            </span>
          </span>
        </button>
        {status.kind === "pill" ? (
          <Badge tone={status.tone}>{status.label}</Badge>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Set up
          </Button>
        )}
      </div>
      {open && <BlacksmithChecklist setup={setup} />}
    </div>
  );
};

const BlacksmithChecklist: React.FC<{ setup: BlacksmithSetupResponse | null }> = ({ setup }) => {
  const api = useAppStore((s) => s.api);
  const accounts = useAppStore((s) => s.accounts);
  const listOwners = useAppStore((s) => s.listOwners);
  const openSettings = useAppStore((s) => s.openSettings);
  const [owners, setOwners] = useState<OwnerSummary[] | null>(null);
  const [ownersError, setOwnersError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const github = blacksmithAccounts(accounts);
  const accountId = setup?.gitAccountId ?? null;

  // The org choices come from the chosen account (Settings → Git hosting's own listing).
  useEffect(() => {
    setOwners(null);
    setOwnersError(null);
    if (!accountId) return;
    let current = true;
    listOwners(accountId)
      .then((list) => current && setOwners(list))
      .catch((err: unknown) => current && setOwnersError(boxesErrorText(err, "Could not list the account's orgs.")));
    return () => {
      current = false;
    };
  }, [accountId, listOwners]);

  if (!setup) {
    return (
      <div className="flex items-center gap-2 border-t border-neutral-800/80 px-4 py-3 text-xs text-neutral-500">
        <Loader2 size={12} className="animate-spin" /> Loading the setup…
      </div>
    );
  }

  const run = async (kind: "save" | "test", call: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError(boxesErrorText(err));
    } finally {
      setBusy(null);
    }
  };
  const save = (req: SetBlacksmithSetupRequest) => api && void run("save", () => saveBlacksmithSetup(api, req));
  const test = () => api && void run("test", () => startBlacksmithTest(api));
  const orgs = blacksmithOrgs(owners);

  const control = (step: BlacksmithSetupStep): React.ReactNode => {
    switch (step.id) {
      case "account":
        return github.length === 0 ? (
          <Button size="sm" variant="outline" onClick={() => openSettings("git-hosting")}>
            <Settings2 size={12} /> Connect a GitHub account
          </Button>
        ) : (
          <select
            aria-label="GitHub account"
            className={selectClass}
            disabled={busy !== null}
            value={setup.gitAccountId ?? ""}
            onChange={(e) => e.target.value && save({ gitAccountId: e.target.value })}
          >
            <option value="">Choose an account…</option>
            {github.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label} ({account.login})
              </option>
            ))}
          </select>
        );
      case "org":
        if (!blacksmithCanPickOrg(setup)) return null;
        if (ownersError) return <span className="text-danger">{ownersError}</span>;
        if (owners === null) return <Loader2 size={12} className="animate-spin text-neutral-500" />;
        return (
          <span className="flex flex-wrap items-center gap-2">
            {orgs.length > 0 && (
              <select
                aria-label="GitHub organization"
                className={selectClass}
                disabled={busy !== null}
                value={setup.org ?? ""}
                onChange={(e) => e.target.value && save({ org: e.target.value })}
              >
                <option value="">Choose an org…</option>
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.label}
                  </option>
                ))}
              </select>
            )}
            <ActionLink href={step.actionUrl ?? NEW_ORG_URL}>{orgs.length > 0 ? "New org" : "Create an org on GitHub"}</ActionLink>
          </span>
        );
      case "app":
        return step.state === "action-needed" || step.state === "failed" ? (
          <span className="flex flex-wrap items-center gap-2">
            {step.actionUrl && <ActionLink href={step.actionUrl}>Open GitHub</ActionLink>}
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => save({})}>
              <RefreshCw size={12} /> Check again
            </Button>
          </span>
        ) : null;
      case "repo":
        return setup.repo ? <span className="font-mono text-[11px] text-neutral-400">{setup.repo}</span> : null;
      case "test":
        return step.state === "running" ? (
          <span className="text-neutral-500">Starting a box, waiting for it to connect, destroying it (about 2 minutes)…</span>
        ) : (
          <Button size="sm" variant="outline" disabled={busy !== null || !blacksmithCanTest(setup)} onClick={test}>
            {busy === "test" && <Loader2 size={12} className="animate-spin" />}
            {step.state === "ok" || step.state === "failed" ? "Run the test again" : "Run test"}
          </Button>
        );
    }
  };

  return (
    <div className="space-y-2 border-t border-neutral-800/80 bg-neutral-950/40 px-4 py-3">
      <ol aria-label="Blacksmith setup" className="space-y-2.5">
        {setup.steps.map((step, index) => {
          const node = control(step);
          return (
            <li key={step.id} className="flex gap-2.5 text-xs">
              <span className="mt-px shrink-0" aria-label={step.state}>
                {STEP_ICON[step.state]}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className={cn("text-neutral-200", step.state === "todo" && "text-neutral-400")}>
                  {index + 1}. {step.label}
                  {(step.id === "repo" || step.id === "test") && <span className="text-neutral-500"> · automatic</span>}
                </p>
                {step.message && (
                  <p className={cn("leading-relaxed", step.state === "failed" ? "text-danger" : "text-neutral-500")}>
                    {step.message}
                  </p>
                )}
                {node && <div>{node}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
};

const ActionLink: React.FC<{ href: string; children: React.ReactNode }> = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noreferrer"
    className="inline-flex items-center gap-1 text-neutral-300 underline underline-offset-2 hover:text-neutral-100"
  >
    {children} <ExternalLink size={11} />
  </a>
);
