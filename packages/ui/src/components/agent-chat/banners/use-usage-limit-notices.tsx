import React from "react";
import { ArrowLeftRight, Gauge } from "lucide-react";
import type { AgentAccount, SessionSummary } from "@orquester/api";

import { ApiError, type ApiClient } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { limitFailoverText, usageLimitBannerModel } from "../../../lib/agent-chat/usage-limit.logic";
import type { DockNotice } from "./ChatBannerDock";

const BUTTON =
  "ac-press inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-neutral-200 text-neutral-900 hover:bg-neutral-50";
const SECONDARY = "border border-neutral-700 text-neutral-200 hover:bg-neutral-800";

/** How often the countdown is redrawn: it shows minutes, so a few redraws a minute keep it exact. */
const COUNTDOWN_TICK_MS = 10_000;

/** `Date.now()`, redrawn every {@link COUNTDOWN_TICK_MS} while `live`. */
function useCountdownNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

function newCommandId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

type Pending = "toggle" | "resume" | "switch" | null;

/**
 * The usage-limit notices of one chat, for the banner dock (`ChatBannerDock`'s `notices`):
 *
 * - while the chat is limited (`SessionSummary.usageLimit`): "Usage limit reached on <account>"
 *   with where the automatic resume stands and a live countdown, and its actions — cancel or
 *   re-arm the automatic resume, resume now, and switch account & continue when another account
 *   of the agent exists. It leaves by itself once the chat resumes or the user sends (the daemon
 *   clears the state);
 * - after an account switch (`SessionSummary.limitFailover`): a dismissible "Switched to <account>".
 *
 * Each action keeps its own `commandId` across a retry of the same click, so a resend after a
 * dropped answer never sends twice.
 */
export function useUsageLimitNotices(input: {
  session: Pick<SessionSummary, "id" | "refId" | "usageLimit" | "limitFailover">;
  api: Pick<ApiClient, "setUsageLimitAutoResume" | "resumeLimitedChat" | "switchLimitedChat" | "dismissLimitFailover">;
  accounts: readonly AgentAccount[] | undefined;
}): DockNotice[] {
  const { session, api, accounts } = input;
  const state = session.usageLimit ?? null;
  const failover = session.limitFailover ?? null;
  const live = state !== null && (state.autoResume === "armed" || state.autoResume === "off");
  const now = useCountdownNow(live);
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);
  const commandIds = React.useRef<{ resume?: string; switch?: string }>({});

  // A new limit (or none) starts clean: no error from the last one, fresh command ids.
  const limitKey = state ? `${state.noticeId}:${state.turnId ?? ""}` : "";
  React.useEffect(() => {
    setError(null);
    setPending(null);
    commandIds.current = {};
  }, [limitKey, session.id]);

  const run = React.useCallback(
    async (kind: Exclude<Pending, null>, action: () => Promise<unknown>): Promise<void> => {
      setPending(kind);
      setError(null);
      try {
        await action();
        if (kind !== "toggle") commandIds.current = {};
      } catch (failure) {
        const message = failure instanceof ApiError ? failure.serverMessage : null;
        setError(message ?? "The action failed. Try again.");
        // A refusal is final for that command id; a transport failure keeps it for the retry.
        if (failure instanceof ApiError && failure.status !== 503) commandIds.current = {};
      } finally {
        setPending(null);
      }
    },
    []
  );

  return React.useMemo(() => {
    const notices: DockNotice[] = [];
    if (state) {
      const model = usageLimitBannerModel({ state, refId: session.refId, accounts, now });
      const disabled = model.busy || pending !== null;
      const toggle = model.toggle;
      notices.push({
        id: `usage-limit:${session.id}`,
        variant: "warning",
        priority: "urgent",
        icon: <Gauge size={14} aria-hidden />,
        title: <span title={model.tooltip}>{model.title}</span>,
        description: (
          <span className="ac-tabular" aria-live="polite">
            {model.detail}
          </span>
        ),
        body: (
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {toggle ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(BUTTON, SECONDARY)}
                  onClick={() => void run("toggle", () => api.setUsageLimitAutoResume(session.id, toggle.armed))}
                >
                  {pending === "toggle" ? "Saving…" : toggle.label}
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                className={cn(BUTTON, PRIMARY)}
                onClick={() => {
                  const commandId = (commandIds.current.resume ??= newCommandId());
                  void run("resume", () => api.resumeLimitedChat(session.id, commandId));
                }}
              >
                {pending === "resume" || (model.busy && state.action?.kind !== "switch") ? "Resuming…" : "Resume now"}
              </button>
              {model.canSwitch ? (
                <button
                  type="button"
                  disabled={disabled}
                  className={cn(BUTTON, SECONDARY)}
                  onClick={() => {
                    const commandId = (commandIds.current.switch ??= newCommandId());
                    void run("switch", () => api.switchLimitedChat(session.id, { commandId }));
                  }}
                >
                  <ArrowLeftRight size={12} aria-hidden />
                  {pending === "switch" || (model.busy && state.action?.kind === "switch") ? "Switching…" : "Switch account & continue"}
                </button>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )
      });
    }
    if (failover) {
      const text = limitFailoverText(failover, accounts);
      notices.push({
        id: `limit-failover:${session.id}:${failover.at}`,
        variant: "info",
        icon: <ArrowLeftRight size={14} aria-hidden />,
        title: text.title,
        description: text.detail,
        onDismiss: () => {
          void api.dismissLimitFailover(session.id).catch(() => {
            /* the notice comes back with the next summary; nothing else to undo */
          });
        }
      });
    }
    return notices;
  }, [accounts, api, error, failover, now, pending, run, session.id, session.refId, state]);
}
