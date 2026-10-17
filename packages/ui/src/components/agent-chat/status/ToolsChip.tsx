/**
 * The chat's Tools chip (unified MCP §7.6): every Orquester tool is available in every chat, so
 * the chip shows the grants that apply to this chat — one click away, each revocable — and, for a
 * chat a workflow runs, that it has no Admin tools.
 *
 * Renders nothing until the daemon answered, and nothing at all for a daemon without the route.
 * A click opens the panel (a dialog of plain controls, like the goal chip); it never opens by
 * itself and never takes focus unless opened.
 */

import React from "react";
import { Wrench } from "lucide-react";
import type { ThreadAgentToolsResponse } from "@orquester/api";

import { dismissWhenChatTabLeaves } from "../../../lib/agent-chat-active-tab";
import { useThreadAgentTools } from "../../../lib/agent-tools/hooks";
import { failureMessage, revokeAgentToolGrant, revokeAgentToolGrants } from "../../../lib/agent-tools/store";
import { useAppStore } from "../../../store/app";
import { Dropdown } from "../../ui/dropdown";
import { describeGrant } from "../../settings/agent-tools-settings.logic";
import { deriveToolsChip } from "./tools-chip";

const TRIGGER_CLASS = "min-w-0 shrink-0 rounded-md focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500";

const LINK =
  "rounded px-1 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 " +
  "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500 disabled:opacity-40";

export function ToolsChip({ sessionId }: { sessionId: string }): React.ReactElement | null {
  const entry = useThreadAgentTools(sessionId);
  const dismissOn = React.useMemo(() => dismissWhenChatTabLeaves(sessionId), [sessionId]);
  if (entry.unsupported || entry.data === null) return null;
  return <ToolsChipView sessionId={sessionId} data={entry.data} dismissOn={dismissOn} />;
}

/** The chip for loaded data — what a render check draws. */
export function ToolsChipView({
  sessionId,
  data,
  dismissOn
}: {
  sessionId: string;
  data: ThreadAgentToolsResponse;
  dismissOn?: (dismiss: () => void) => () => void;
}): React.ReactElement {
  const model = deriveToolsChip(data);
  return (
    <Dropdown
      align="right"
      width="w-80"
      className="p-0"
      triggerClassName={TRIGGER_CLASS}
      role="dialog"
      ariaLabel="Tools in this chat"
      focusOnOpen
      dismissOn={dismissOn}
      trigger={
        <span
          title={model.title}
          data-tools-chip={sessionId}
          className="ac-press inline-flex h-6 items-center gap-1 rounded-md px-1 font-mono text-neutral-500 hover:bg-neutral-800"
        >
          <Wrench size={12} aria-hidden className="shrink-0" />
          <span aria-hidden className="ac-tabular hidden sm:inline">
            {model.label}
          </span>
          {model.grantCount > 0 ? (
            <span aria-hidden className="ac-tabular sm:hidden">
              {model.grantCount}
            </span>
          ) : null}
          <span className="sr-only">{model.ariaLabel}</span>
        </span>
      }
    >
      <ToolsPanel sessionId={sessionId} data={data} />
    </Dropdown>
  );
}

function ToolsPanel({ sessionId, data }: { sessionId: string; data: ThreadAgentToolsResponse }): React.ReactElement {
  const api = useAppStore((state) => state.api);
  const sessions = useAppStore((state) => state.sessions);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const model = deriveToolsChip(data);

  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(failureMessage(failure) ?? "The change did not go through. Try again."))
      .finally(() => setBusy(false));
  };

  const titleOf = (threadId: string): string | null => sessions.find((session) => session.id === threadId)?.title ?? null;
  const grants = data.grants.map((grant) => describeGrant(grant, titleOf, sessionId));
  const chatGrants = data.grants.filter((grant) => grant.scope === "chat" && grant.threadId === sessionId).length;

  return (
    <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-3 text-xs" data-tools-panel={sessionId}>
      <p className="text-[11px] leading-relaxed text-neutral-400">
        Every Orquester tool is available in this chat. Admin tools ask for your approval with a card.
      </p>
      {model.note ? <p className="text-[11px] text-warn-300">{model.note}</p> : null}

      <div className="mt-1 border-t border-neutral-800 pt-2">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-medium text-neutral-300">Grants</span>
          {chatGrants > 0 ? (
            <button type="button" className={LINK} disabled={busy || !api} onClick={() => api && run(() => revokeAgentToolGrants(api, sessionId))}>
              Revoke this chat's
            </button>
          ) : null}
        </div>
        {grants.length === 0 ? (
          <p className="text-[11px] text-neutral-500">None: every approval-gated call asks.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-label="Grants">
            {grants.map((grant) => (
              <li key={grant.id} className="flex min-w-0 items-center justify-between gap-2" data-grant-id={grant.id}>
                <span className="min-w-0">
                  <span className="block truncate text-neutral-200">{grant.what}</span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {grant.where}
                    {grant.detail ? ` · ${grant.detail}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  className={LINK}
                  disabled={busy || !api}
                  onClick={() => api && run(() => revokeAgentToolGrant(api, grant.id))}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-[11px] text-danger-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
