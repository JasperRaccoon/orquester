import React from "react";
import { GitFork, GitMerge, X } from "lucide-react";

import type { SessionSummary } from "@orquester/api";

import { cn } from "../../lib/cn";
import {
  lineageChildStatus,
  lineageChildren,
  lineageChildrenLabel,
  lineageParent,
  lineageRelationNoun,
  lineageVerb
} from "../../lib/agent-chat/lineage.logic";
import { lineageIcon } from "./LineageMark";
import { Dropdown, DropdownItem } from "../ui";

export interface LineageNotice {
  tone: "info" | "error";
  text: string;
}

/**
 * The thread's relations, over its timeline (thread lineage, spec 2026-10-14
 * §6): for a child, "Forked from <title>" / "Delegated by <title>" / "Opened
 * by <title>" (a chat another chat's agent opened, unified MCP §4.1) — the
 * title opens the parent — and "Merge back", which sends the parent the
 * fork's result (its last answer, editable first); for a parent, its forks
 * and delegated tasks, each with what it is doing, each opening its tab.
 * Also where the outcome of a fork or a merge is said. Renders nothing for a
 * thread with neither, and no notice.
 */
export function ThreadLineageBar({
  session,
  sessions,
  defaultMergeText,
  notice,
  onDismissNotice,
  onOpenSession,
  onMergeBack,
  onMergeAction
}: {
  session: SessionSummary;
  /** Every tab the store holds (the project's): parents and children are read from their records. */
  sessions: readonly SessionSummary[];
  /** What "Merge back" offers to send: the thread's last finished answer. */
  defaultMergeText: string;
  notice: LineageNotice | null;
  onDismissNotice: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Resolves once the daemon took the merge (sent or queued); rejects with its refusal. */
  onMergeBack: (text: string) => Promise<void>;
  /** Deliver now (a failed one: retry) or discard a pending merge; the view says how it went. */
  onMergeAction: (mergeId: string, action: "deliver" | "discard") => Promise<void>;
}): React.ReactElement | null {
  const lineage = session.lineage;
  const pendingMerges = session.pendingMerges ?? [];
  const [acting, setActing] = React.useState<string | null>(null);
  const act = (mergeId: string, action: "deliver" | "discard"): void => {
    if (acting !== null) return;
    setActing(mergeId);
    onMergeAction(mergeId, action)
      .catch(() => {
        /* the view says why, in the notice */
      })
      .finally(() => setActing(null));
  };
  const titleOf = (id: string): string => sessions.find((candidate) => candidate.id === id)?.title ?? "a closed chat";
  const parent = lineageParent(sessions, lineage);
  const children = React.useMemo(() => lineageChildren(sessions, session.id), [sessions, session.id]);
  const [composing, setComposing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);

  // A thread switch closes the merge editor: it belongs to the thread it opened on.
  React.useEffect(() => {
    setComposing(false);
    setSending(false);
  }, [session.id]);

  if (!lineage && children.length === 0 && notice === null && pendingMerges.length === 0) return null;

  const openComposer = (): void => {
    setDraft(defaultMergeText);
    setComposing(true);
  };
  const submit = (): void => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    onMergeBack(text)
      .then(() => setComposing(false))
      .catch(() => {
        /* the view says why, in the notice */
      })
      .finally(() => setSending(false));
  };

  const RelationIcon = lineageIcon(lineage?.relation);
  const noun = lineageRelationNoun(lineage?.relation);

  return (
    <div className="shrink-0 border-b border-neutral-800/70 bg-neutral-950" data-thread-lineage="true">
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs text-neutral-400 sm:px-5">
        {lineage ? (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <RelationIcon size={12} strokeWidth={1.8} className="shrink-0 text-neutral-500" aria-hidden />
            <span className="shrink-0">{lineageVerb(lineage)}</span>
            {parent ? (
              <button
                type="button"
                onClick={() => onOpenSession(parent.id)}
                className="min-w-0 truncate rounded text-neutral-200 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                title={`Open “${parent.title}”`}
              >
                {parent.title}
              </button>
            ) : (
              <span className="truncate text-neutral-500" title="That chat's tab was closed">
                a closed chat
              </span>
            )}
          </span>
        ) : null}
        {lineage && parent ? (
          <button
            type="button"
            onClick={composing ? () => setComposing(false) : openComposer}
            className={cn(
              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300",
              "hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
              composing && "bg-neutral-800 text-neutral-100"
            )}
            aria-expanded={composing}
            title={`Send this ${noun}'s result to “${parent.title}”`}
          >
            <GitMerge size={12} strokeWidth={1.8} aria-hidden />
            Merge back
          </button>
        ) : null}
        {children.length > 0 ? (
          <Dropdown
            align="left"
            width="w-72"
            ariaLabel="Forks, delegated tasks and opened chats"
            triggerClassName="rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            trigger={
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100">
                <GitFork size={12} strokeWidth={1.8} aria-hidden />
                {lineageChildrenLabel(children)}
              </span>
            }
          >
            {children.map((child) => (
              <DropdownItem
                key={child.id}
                icon={React.createElement(lineageIcon(child.lineage?.relation), { size: 13, "aria-hidden": true })}
                onClick={() => onOpenSession(child.id)}
              >
                <span className="min-w-0 flex-1 truncate">{child.title}</span>
                <span className="shrink-0 text-xs text-neutral-500">{lineageChildStatus(child)}</span>
              </DropdownItem>
            ))}
          </Dropdown>
        ) : null}
        {notice ? (
          <span
            role={notice.tone === "error" ? "alert" : "status"}
            className={cn(
              "ml-auto inline-flex min-w-0 items-center gap-1",
              notice.tone === "error" ? "text-danger-300" : "text-neutral-300"
            )}
          >
            <span className="min-w-0 truncate" title={notice.text}>
              {notice.text}
            </span>
            <button
              type="button"
              onClick={onDismissNotice}
              aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ) : null}
      </div>
      {pendingMerges.length > 0 ? (
        <ul className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-1 px-3 pb-1.5 text-xs sm:px-5" aria-label="Pending merges">
          {pendingMerges.map((merge) => {
            const outgoing = merge.childSessionId === session.id;
            const other = titleOf(outgoing ? merge.parentSessionId : merge.childSessionId);
            const failed = merge.state === "failed";
            return (
              <li
                key={merge.mergeId}
                className={cn("flex min-w-0 items-center gap-2", failed ? "text-danger-300" : "text-neutral-400")}
                data-merge-state={merge.state}
              >
                <GitMerge size={12} strokeWidth={1.8} className="shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate" title={merge.error ?? merge.preview}>
                  {outgoing ? `Merge to “${other}”` : `Merge from “${other}”`}{" "}
                  {failed
                    ? `failed${merge.error ? `: ${merge.error}` : ""}`
                    : outgoing
                      ? "is queued until it is idle"
                      : "is waiting until this chat is idle"}
                  {/* A queued merge that was refused before says why it is still waiting. */}
                  {!failed && merge.attempts > 0 && merge.error
                    ? ` (tried ${merge.attempts}×: ${merge.error})`
                    : null}
                </span>
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() => act(merge.mergeId, "deliver")}
                  className="shrink-0 rounded px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                  title="Send it now: a running turn takes it as a message sent mid-turn"
                >
                  {failed ? "Retry" : "Deliver now"}
                </button>
                <button
                  type="button"
                  disabled={acting !== null}
                  onClick={() => act(merge.mergeId, "discard")}
                  className="shrink-0 rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
                >
                  Discard
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {composing && parent ? (
        <div className="mx-auto w-full min-w-0 max-w-3xl px-3 pb-2 sm:px-5">
          <label className="mb-1 block text-xs text-neutral-500" htmlFor={`merge-back-${session.id}`}>
            Sent to “{parent.title}” as a message from this {noun} —
            queued if it is busy.
          </label>
          <textarea
            id={`merge-back-${session.id}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setComposing(false);
              }
            }}
            rows={4}
            placeholder="What should the original conversation hear?"
            className="max-h-60 w-full resize-y rounded-lg border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
          />
          <div className="mt-1.5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setComposing(false)}
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={sending || draft.trim().length === 0}
              className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
            >
              <GitMerge size={12} strokeWidth={1.8} aria-hidden />
              {sending ? "Sending…" : "Merge back"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
