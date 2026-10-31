import React from "react";
import { Clock } from "lucide-react";
import type { SessionSummary } from "@orquester/api";
import type { ScheduledPrompt, ScheduledPromptView } from "@orquester/api/agent-chat";

import { ApiError, type ApiClient } from "../../../lib/api-client";
import { cn } from "../../../lib/cn";
import { scheduledPromptStatus, scheduledPromptsOf } from "../../../lib/agent-chat/scheduled-prompts.logic";
import type { DockNotice } from "./ChatBannerDock";

const BUTTON =
  "ac-press inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 " +
  "disabled:pointer-events-none disabled:opacity-50";
const PRIMARY = "bg-neutral-200 text-neutral-900 hover:bg-neutral-50";
const SECONDARY = "border border-neutral-700 text-neutral-200 hover:bg-neutral-800";

/** The countdown shows minutes: a few redraws a minute keep it exact. */
const TICK_MS = 10_000;

function useNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [live]);
  return now;
}

type Pending = { id: string; kind: "send" | "edit" | "cancel" } | null;

/**
 * The chat's scheduled prompts (`SessionSummary.scheduledPrompts`), as one notice for the banner
 * dock: each prompt's start, when it goes out with a live countdown (or why it has not), and its
 * actions — Send now (Retry once it failed), Edit (cancel it and put it back into the composer)
 * and Cancel. The daemon keeps the list current; a sent prompt leaves it by itself.
 */
export function useScheduledPromptNotices(input: {
  session: Pick<SessionSummary, "id" | "scheduledPrompts">;
  api: Pick<ApiClient, "cancelScheduledPrompt" | "sendScheduledPromptNow">;
  /** Put a cancelled prompt back into the composer ("Edit"). */
  onEdit: (prompt: ScheduledPrompt) => void;
}): DockNotice[] {
  const { session, api, onEdit } = input;
  const list = session.scheduledPrompts;
  const prompts = React.useMemo(() => scheduledPromptsOf({ scheduledPrompts: list }), [list]);
  const now = useNow(prompts.length > 0);
  const [pending, setPending] = React.useState<Pending>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(async (next: NonNullable<Pending>, action: () => Promise<unknown>): Promise<void> => {
    setPending(next);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure instanceof ApiError ? failure.serverMessage : null) ?? "The action failed. Try again.");
    } finally {
      setPending(null);
    }
  }, []);

  return React.useMemo(() => {
    if (prompts.length === 0) return [];
    const at = new Date(now);
    const row = (prompt: ScheduledPromptView): React.ReactNode => {
      const disabled = pending !== null || prompt.state === "sending";
      const busy = (kind: NonNullable<Pending>["kind"]) => pending?.id === prompt.id && pending.kind === kind;
      return (
        <li key={prompt.id} className="flex min-w-0 flex-col gap-1 border-t border-neutral-800/70 pt-1.5 first:border-t-0 first:pt-0">
          <p className="truncate text-xs text-neutral-200" title={prompt.preview}>
            {prompt.preview || "(attachments only)"}
            {prompt.attachmentCount > 0 ? (
              <span className="text-neutral-500">
                {" "}
                · {prompt.attachmentCount} attachment{prompt.attachmentCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </p>
          <p
            className={cn("ac-tabular text-[11px]", prompt.state === "failed" ? "text-danger" : "text-neutral-400")}
            aria-live="polite"
          >
            {scheduledPromptStatus(prompt, at)}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={disabled}
              className={cn(BUTTON, PRIMARY)}
              onClick={() => void run({ id: prompt.id, kind: "send" }, () => api.sendScheduledPromptNow(session.id, prompt.id))}
            >
              {busy("send") ? "Sending…" : prompt.state === "failed" ? "Retry" : "Send now"}
            </button>
            <button
              type="button"
              disabled={disabled}
              className={cn(BUTTON, SECONDARY)}
              onClick={() =>
                void run({ id: prompt.id, kind: "edit" }, async () => {
                  const result = await api.cancelScheduledPrompt(session.id, prompt.id);
                  onEdit(result.cancelled);
                })
              }
            >
              Edit
            </button>
            <button
              type="button"
              disabled={disabled}
              className={cn(BUTTON, SECONDARY)}
              onClick={() => void run({ id: prompt.id, kind: "cancel" }, () => api.cancelScheduledPrompt(session.id, prompt.id))}
            >
              {busy("cancel") ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        </li>
      );
    };
    const failed = prompts.some((p) => p.state === "failed");
    return [
      {
        id: `scheduled-prompts:${session.id}`,
        variant: failed ? "warning" : "info",
        icon: <Clock size={14} aria-hidden />,
        title: prompts.length === 1 ? "Scheduled prompt" : `${prompts.length} scheduled prompts`,
        description: "Sent by the server at its time, even with every window closed.",
        body: (
          <div className="flex min-w-0 flex-col gap-1.5">
            <ul className="flex min-w-0 flex-col gap-1.5">{prompts.map(row)}</ul>
            {error ? (
              <p role="alert" className="text-[11px] text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )
      }
    ];
  }, [api, error, now, onEdit, pending, prompts, run, session.id]);
}
