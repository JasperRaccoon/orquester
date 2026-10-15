/**
 * The chat's Tools chip (unified MCP §9.2): how many Orquester tools this chat's agent is offered,
 * and — one click away — this chat's toolsets (Inherit / On / Off; `core` locked) and the grants
 * that apply to it, each revocable. Resolution is chat override → the agent's default (Settings ›
 * Agent tools); a change reaches the agent at the chat's next idle point.
 *
 * Renders nothing until the daemon answered, and nothing at all for a daemon without the route.
 * A click opens the panel (a dialog of plain controls, like the goal chip); it never opens by
 * itself and never takes focus unless opened.
 */

import React from "react";
import { Lock, Wrench } from "lucide-react";
import type { ThreadAgentToolsResponse } from "@orquester/api";

import { cn } from "../../../lib/cn";
import { dismissWhenChatTabLeaves } from "../../../lib/agent-chat-active-tab";
import { useThreadAgentTools } from "../../../lib/agent-tools/hooks";
import {
  failureMessage,
  revokeAgentToolGrant,
  revokeAgentToolGrants,
  updateThreadAgentTools
} from "../../../lib/agent-tools/store";
import { useAppStore } from "../../../store/app";
import { Dropdown } from "../../ui/dropdown";
import { SegmentedControl, type SegmentedOption } from "../../settings/primitives";
import { describeGrant } from "../../settings/agent-tools-settings.logic";
import {
  deriveToolsChip,
  formatDeclinedUntil,
  toolsetChoiceUpdate,
  type ToolsChipRow,
  type ToolsetChoice
} from "./tools-chip";

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
  dismissOn,
  now = Date.now()
}: {
  sessionId: string;
  data: ThreadAgentToolsResponse;
  dismissOn?: (dismiss: () => void) => () => void;
  now?: number;
}): React.ReactElement {
  const model = deriveToolsChip(data, now);
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
          className={cn(
            "ac-press inline-flex h-6 items-center gap-1 rounded-md px-1 font-mono text-neutral-500 hover:bg-neutral-800",
            model.pending && "text-info-300"
          )}
        >
          <Wrench size={12} aria-hidden className="shrink-0" />
          <span aria-hidden className="ac-tabular hidden sm:inline">
            {model.label}
          </span>
          <span aria-hidden className="ac-tabular sm:hidden">
            {model.toolCount}
          </span>
          <span className="sr-only">{model.ariaLabel}</span>
        </span>
      }
    >
      <ToolsPanel sessionId={sessionId} data={data} now={now} />
    </Dropdown>
  );
}

const CHOICES: readonly SegmentedOption<ToolsetChoice>[] = [
  { value: "inherit", label: "Default", title: "Use the agent's default from Settings › Agent tools" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" }
];

function ToolsPanel({ sessionId, data, now }: { sessionId: string; data: ThreadAgentToolsResponse; now: number }): React.ReactElement {
  const api = useAppStore((state) => state.api);
  const sessions = useAppStore((state) => state.sessions);
  const openSettings = useAppStore((state) => state.openSettings);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const model = deriveToolsChip(data, now);

  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(failureMessage(failure) ?? "The change did not go through. Try again."))
      .finally(() => setBusy(false));
  };

  const choose = (row: ToolsChipRow, choice: ToolsetChoice): void => {
    const request = toolsetChoiceUpdate(row, choice);
    if (!api || request === null || choice === row.choice) return;
    run(() => updateThreadAgentTools(api, sessionId, request));
  };

  const titleOf = (threadId: string): string | null => sessions.find((session) => session.id === threadId)?.title ?? null;
  const grants = data.grants.map((grant) => describeGrant(grant, titleOf, sessionId));
  const chatGrants = data.grants.filter((grant) => grant.scope === "chat" && grant.threadId === sessionId).length;

  return (
    <div className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto p-3 text-xs" data-tools-panel={sessionId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-neutral-300">Orquester tools in this chat</span>
        <span className="ac-tabular text-[11px] text-neutral-500">{model.toolCount} tools</span>
      </div>
      {model.pending ? (
        <p className="text-[11px] text-info-300">A change applies at this chat's next idle point: the agent session restarts and keeps the conversation.</p>
      ) : null}
      {model.note ? <p className="text-[11px] text-warn-300">{model.note}</p> : null}

      <ul className="flex flex-col gap-1.5" aria-label="Toolsets">
        {model.rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-col gap-1" data-toolset={row.id} data-on={row.on ? "true" : "false"}>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className={cn("min-w-0 truncate", row.on ? "text-neutral-200" : "text-neutral-500")} title={row.label}>
                {row.label}
                <span className="ml-1 text-neutral-600">· {row.toolCount}</span>
              </span>
              {row.locked ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-neutral-500" title="Always on">
                  <Lock size={11} aria-hidden />
                  Always on
                </span>
              ) : (
                <SegmentedControl
                  size="xs"
                  ariaLabel={`${row.label} in this chat`}
                  value={row.choice}
                  options={CHOICES.map((option) =>
                    option.value === "inherit" && row.inheritedOn !== null
                      ? { ...option, label: `Default (${row.inheritedOn ? "on" : "off"})` }
                      : option
                  )}
                  onChange={(choice) => choose(row, choice)}
                />
              )}
            </div>
            {row.declinedUntil ? (
              <span className="text-[11px] text-neutral-500">
                You denied it here; the agent may ask again at {formatDeclinedUntil(row.declinedUntil)}.
              </span>
            ) : null}
          </li>
        ))}
      </ul>

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
      <button type="button" className={cn(LINK, "self-start")} onClick={() => openSettings("agent-tools")}>
        Defaults for every chat: Settings › Agent tools
      </button>
    </div>
  );
}
