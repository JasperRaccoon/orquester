/**
 * Settings › Agent tools (unified MCP §9.2, §7.6): which Orquester tools agent chats get, and what
 * they may do without asking.
 *
 * - the master switch (off: every chat gets only the locked `core` toolset);
 * - the toolsets × agents matrix (Claude Code, Codex, Grok, OpenCode; `core` locked) with tool
 *   counts, measured `tools/list` bytes and tier badges — each chat starts from its agent's column
 *   and may override it in its own Tools chip (project-level overrides do not exist, by ruling);
 * - every grant, with Revoke and Revoke all.
 *
 * The daemon owns the file; every change carries the `revision` this page saw, and one made
 * elsewhere meanwhile is refused and the page reads the settings again.
 */

import React from "react";
import { ChevronDown, ChevronRight, KeyRound, Lock, RotateCcw, Wrench } from "lucide-react";
import { AGENT_TOOLS_AGENTS, type AgentAdapterId, type AgentToolsetView } from "@orquester/api";

import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/relative-time";
import { useAgentToolsSettings } from "../../lib/agent-tools/hooks";
import {
  failureCode,
  failureMessage,
  failureStatus,
  revokeAgentToolGrant,
  revokeAgentToolGrants,
  updateAgentToolsSettings
} from "../../lib/agent-tools/store";
import { useAppStore } from "../../store/app";
import { Button, ConfirmDialog, Switch } from "../ui";
import {
  AGENT_TOOLS_AGENT_LABELS,
  AGENT_TOOLS_APPLY_NOTE,
  agentToolsMatrix,
  describeGrant,
  matrixCellUpdate,
  matrixResetUpdate,
  TIER_LABELS,
  type MatrixRow
} from "./agent-tools-settings.logic";
import { Badge, EmptyState, Notice, SettingRow, SettingsCard, SettingsPage, SettingsSection, type Tone } from "./primitives";

const TIER_TONE: Record<keyof typeof TIER_LABELS, Tone> = { read: "neutral", act: "info", admin: "warn" };

/** A refused change, in words — never the request. */
function changeFailureText(error: unknown): string {
  if (failureStatus(error) === 409 && failureCode(error) === "REVISION_MISMATCH") {
    return "These settings were changed elsewhere and have been read again. Make your change once more.";
  }
  return failureMessage(error) ?? "The change did not go through. Try again.";
}

export const AgentToolsSettings: React.FC = () => {
  const api = useAppStore((state) => state.api);
  const sessions = useAppStore((state) => state.sessions);
  const { settings, settingsLoading, settingsError, settingsUnsupported } = useAgentToolsSettings();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);

  const run = (action: () => Promise<unknown>): void => {
    if (busy || !api) return;
    setBusy(true);
    setError(null);
    action()
      .catch((failure: unknown) => setError(changeFailureText(failure)))
      .finally(() => setBusy(false));
  };

  const page = (children: React.ReactNode): React.ReactElement => (
    <SettingsPage
      title="Agent tools"
      description="The Orquester tools agent chats get, and what they may do without asking you."
    >
      {children}
    </SettingsPage>
  );

  if (settingsUnsupported) {
    return page(
      <EmptyState
        icon={<Wrench size={18} />}
        title="Not available on this daemon"
        description="This Orquester daemon predates agent tool settings. Update it to choose which tools chats get."
      />
    );
  }
  if (settings === null) {
    return page(
      settingsError ? (
        <Notice tone="danger" title="Could not load the agent tools">
          {settingsError}
        </Notice>
      ) : (
        <p className="text-sm text-neutral-500">{settingsLoading ? "Loading…" : ""}</p>
      )
    );
  }

  const rows = agentToolsMatrix(settings.toolsets);
  const viewById = new Map(settings.toolsets.map((view) => [view.id, view]));
  const reset = matrixResetUpdate(settings.toolsets, settings.revision);
  const titleOf = (threadId: string): string | null => sessions.find((session) => session.id === threadId)?.title ?? null;

  return page(
    <>
      {error ? (
        <Notice tone="warn" title="Not saved">
          {error}
        </Notice>
      ) : null}

      <SettingsSection title="Agent tools in chats">
        <SettingRow
          label="Offer Orquester tools to agent chats"
          description={
            settings.enabled
              ? "Each chat gets the toolsets on for its agent below, plus its own choices in its Tools chip."
              : "Off: every chat gets only Chats & delegation. Your choices below and in each chat are kept for when you turn it back on."
          }
        >
          <Switch
            checked={settings.enabled}
            disabled={busy || !api}
            label="Offer Orquester tools to agent chats"
            onChange={(enabled) => api && run(() => updateAgentToolsSettings(api, { revision: settings.revision, enabled }))}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Toolsets per agent"
        description="What each agent's chats start with. A chat can turn a toolset on or off for itself in its Tools chip; an agent can also ask, with a card you answer."
        actions={
          reset ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => api && run(() => updateAgentToolsSettings(api, reset))}>
              <RotateCcw size={13} />
              Reset to defaults
            </Button>
          ) : null
        }
        bare
      >
        <div className={cn("overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/40", !settings.enabled && "opacity-60")}>
          <table className="w-full min-w-[34rem] border-collapse text-sm" data-agent-tools-matrix="">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-[11px] text-neutral-500">
                <th scope="col" className="px-4 py-2 font-medium">
                  Toolset
                </th>
                {AGENT_TOOLS_AGENTS.map((agent) => (
                  <th key={agent} scope="col" className="px-2 py-2 text-center font-medium">
                    {AGENT_TOOLS_AGENT_LABELS[agent]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800/80">
              {rows.map((row) => (
                <MatrixTableRow
                  key={row.id}
                  row={row}
                  view={viewById.get(row.id)!}
                  disabled={busy || !api}
                  onToggle={(agent, on) => {
                    const request = matrixCellUpdate(viewById.get(row.id)!, agent, on, settings.revision);
                    if (request && api) run(() => updateAgentToolsSettings(api, request));
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-1 text-xs leading-relaxed text-neutral-500">{AGENT_TOOLS_APPLY_NOTE}</p>
      </SettingsSection>

      <SettingsSection
        title="Grants"
        description="Approvals you extended to later calls of the same kind. A chat grant ends when its chat closes; a project grant lasts until you revoke it. Revoking takes effect at the agent's next call."
        actions={
          settings.grants.length > 0 ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRevokeAll(true)}>
              Revoke all
            </Button>
          ) : null
        }
      >
        {settings.grants.length === 0 ? (
          <EmptyState icon={<KeyRound size={16} />} title="No grants" description="Every call that needs your approval asks with a card in its chat." />
        ) : (
          settings.grants.map((grant) => {
            const line = describeGrant(grant, titleOf);
            return (
              <SettingRow
                key={grant.id}
                label={line.what}
                description={
                  <span data-grant-id={grant.id}>
                    {line.where}
                    {line.detail ? ` · ${line.detail}` : ""} · granted {relativeTime(grant.createdAt)}
                    {grant.lastUsedAt ? ` · last used ${relativeTime(grant.lastUsedAt)}` : " · not used yet"}
                  </span>
                }
              >
                <Button variant="outline" size="sm" disabled={busy || !api} onClick={() => api && run(() => revokeAgentToolGrant(api, grant.id))}>
                  Revoke
                </Button>
              </SettingRow>
            );
          })
        )}
      </SettingsSection>

      <ConfirmDialog
        open={confirmRevokeAll}
        title="Revoke every grant?"
        message="Every chat and project grant goes; the next call of each kind asks you again with a card."
        confirmLabel="Revoke all"
        onCancel={() => setConfirmRevokeAll(false)}
        onConfirm={() => {
          setConfirmRevokeAll(false);
          if (api) run(() => revokeAgentToolGrants(api));
        }}
      />
    </>
  );
};

function MatrixTableRow({
  row,
  view,
  disabled,
  onToggle
}: {
  row: MatrixRow;
  view: AgentToolsetView;
  disabled: boolean;
  onToggle: (agent: AgentAdapterId, on: boolean) => void;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr data-toolset-row={row.id}>
        <td className="px-4 py-2.5 align-top">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 items-start gap-1.5 rounded text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          >
            <Chevron size={13} className="mt-0.5 shrink-0 text-neutral-500" aria-hidden />
            <span className="min-w-0">
              <span className="block text-neutral-200">{row.label}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-neutral-500">
                <span>
                  {row.toolCount} tool{row.toolCount === 1 ? "" : "s"}
                  {row.bytes ? ` · ${row.bytes}` : ""}
                </span>
                {(Object.keys(row.tiers) as (keyof typeof row.tiers)[])
                  .filter((tier) => row.tiers[tier] > 0)
                  .map((tier) => (
                    <Badge key={tier} tone={TIER_TONE[tier]}>
                      {TIER_LABELS[tier]} {row.tiers[tier]}
                    </Badge>
                  ))}
              </span>
            </span>
          </button>
        </td>
        {row.cells.map((cell) => (
          <td key={cell.agent} className="px-2 py-2.5 text-center align-top" data-cell={`${row.id}:${cell.agent}`}>
            {cell.locked ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500" title="Always on">
                <Lock size={12} aria-hidden />
                <span className="sr-only">Always on</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Switch
                  checked={cell.on}
                  disabled={disabled}
                  label={`${row.label} for ${AGENT_TOOLS_AGENT_LABELS[cell.agent]}`}
                  onChange={(on) => onToggle(cell.agent, on)}
                />
                {cell.customised ? (
                  <span
                    role="img"
                    className="h-1.5 w-1.5 rounded-full bg-info"
                    title="Changed from the default"
                    aria-label="Changed from the default"
                  />
                ) : null}
              </span>
            )}
          </td>
        ))}
      </tr>
      {open ? (
        <tr>
          <td colSpan={1 + row.cells.length} className="px-4 pb-3">
            <SettingsCard className="bg-neutral-950/40">
              <ul className="flex flex-wrap gap-1.5 p-3" aria-label={`${row.label} tools`}>
                {view.tools.map((tool) => (
                  <li key={tool.name} className="inline-flex items-center gap-1 rounded-md bg-neutral-800/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300">
                    {tool.name}
                    <Badge tone={TIER_TONE[tool.tier]} className="px-1.5 py-0">
                      {TIER_LABELS[tool.tier]}
                    </Badge>
                  </li>
                ))}
              </ul>
            </SettingsCard>
          </td>
        </tr>
      ) : null}
    </>
  );
}
