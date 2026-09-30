import React, { useEffect, useRef, useState } from "react";
import { Boxes, Download, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import type { RegistryEntry } from "@orquester/api";
import { Button, Input } from "../ui";
import { getRegistryIcon } from "../../icons";
import { useRegistry } from "../../hooks";
import { useAppStore } from "../../store/app";
import { Badge, EmptyState, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "";

/**
 * Agent CLIs ("harnesses") the daemon can launch: installed ones first (with
 * their detected version and an update action), then the rest of the catalog
 * with an install action, then options that apply to the harnesses themselves.
 */
export const AgentsSettings: React.FC = () => {
  const registry = useRegistry();
  // Named `agentPrefs`, not `agents`: the registry entries are the agents here.
  const agentPrefs = useAppStore((s) => s.appConfig.agents);
  const updateAgentPrefs = useAppStore((s) => s.updateAgentPrefs);
  const [timeoutDraft, setTimeoutDraft] = useState(String(agentPrefs.claudeTimeoutMinutes));

  // Re-sync when the value changes underneath us: it lives in the daemon's
  // app.json (shared by every client of that daemon) and is refetched on each
  // connect, so a switch of connection can bring in a different value.
  useEffect(
    () => setTimeoutDraft(String(agentPrefs.claudeTimeoutMinutes)),
    [agentPrefs.claudeTimeoutMinutes]
  );

  /** Persist the draft if it is in range; returns false when it is not. */
  const persistTimeout = () => {
    const next = Number.parseInt(timeoutDraft, 10);
    // Never persist something the daemon's zod schema would refuse.
    if (!Number.isInteger(next) || next < 1 || next > 30) {
      return false;
    }
    if (next !== agentPrefs.claudeTimeoutMinutes) {
      void updateAgentPrefs({ ...agentPrefs, claudeTimeoutMinutes: next });
    }
    return true;
  };

  const commitTimeout = () => {
    // Reject out-of-band values by snapping the field back.
    if (!persistTimeout()) setTimeoutDraft(String(agentPrefs.claudeTimeoutMinutes));
  };

  // Blur alone is not a reliable commit point: the modal closes on a
  // document-level Escape handler (and the panel switches tabs), which unmounts
  // the focused input without React ever firing onBlur — the edit would be
  // silently lost. Every other control here persists immediately, so commit on
  // unmount too (persist only — no setState on an unmounted component).
  const persistRef = useRef(persistTimeout);
  persistRef.current = persistTimeout;
  useEffect(() => () => void persistRef.current(), []);

  const installed = registry.agents.filter((a) => a.enabled);
  const available = registry.agents.filter((a) => !a.enabled);

  return (
    <SettingsPage title="Harnesses" description="Install and update the agent CLIs this server can launch.">
      <SettingsSection
        title="Installed"
        description="Detected on the server and ready to launch."
        actions={<Badge>{installed.length}</Badge>}
      >
        {installed.length === 0 ? (
          <EmptyState
            icon={<Boxes size={18} />}
            title="No harnesses installed"
            description="Install one from the list below to start agent sessions."
          />
        ) : (
          installed.map((agent) => <HarnessRow key={agent.id} agent={agent} />)
        )}
      </SettingsSection>

      {available.length > 0 && (
        <SettingsSection
          title="Available"
          description="Not found on the server. Installing runs the command shown on the server."
          actions={<Badge>{available.length}</Badge>}
        >
          {available.map((agent) => (
            <HarnessRow key={agent.id} agent={agent} />
          ))}
        </SettingsSection>
      )}

      <SettingsSection title="Harness options">
        <SettingRow
          label="Claude stream timeout"
          htmlFor="claude-stream-timeout"
          description="How long an idle Claude stream may stall before the harness aborts it. Applies to every Claude session launched here and its subagents; 30 is the most the harness honors. Takes effect for newly launched sessions."
        >
          <div className="flex items-center gap-2">
            <Input
              id="claude-stream-timeout"
              className="w-16 text-right tabular-nums"
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={timeoutDraft}
              onChange={(e) => setTimeoutDraft(e.target.value)}
              onBlur={commitTimeout}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            <span className="text-xs text-neutral-500">
              min <span className="text-neutral-600">· 1–30</span>
            </span>
          </div>
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
  );
};

/** One agent CLI: identity + status badges on the left, its lifecycle action on the right. */
const HarnessRow: React.FC<{ agent: RegistryEntry }> = ({ agent }) => {
  const installAgent = useAppStore((s) => s.installAgent);
  const updateAgent = useAppStore((s) => s.updateAgent);
  const busy = agent.installState === "installing";
  const failed = agent.installState === "error";

  const label = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium text-neutral-100">{agent.name}</span>
      {agent.enabled && agent.version && (
        <Badge className="font-mono" title={agent.resolvedBin}>
          {agent.version}
        </Badge>
      )}
      {agent.chat && (
        <Badge tone="info" icon={<MessageSquare size={10} />} title="Can open agent chat tabs">
          Chat
        </Badge>
      )}
      {busy ? (
        <Badge tone="info" icon={<Loader2 size={10} className="animate-spin" />}>
          {agent.enabled ? "Updating…" : "Installing…"}
        </Badge>
      ) : failed ? (
        <Badge tone="danger" title={agent.installError}>
          Failed
        </Badge>
      ) : (
        !agent.enabled && <Badge>Not installed</Badge>
      )}
    </span>
  );

  const description = failed ? (
    <span className="block truncate text-danger" title={agent.installError}>
      {agent.installError ? firstLine(agent.installError) : "The last install or update did not finish."}
    </span>
  ) : agent.enabled ? (
    agent.resolvedBin && (
      <span className="block truncate font-mono text-[11px]" title={agent.resolvedBin}>
        {agent.resolvedBin}
      </span>
    )
  ) : agent.installCmd ? (
    <span className="block truncate font-mono text-[11px]" title={agent.installCmd}>
      {agent.installCmd}
    </span>
  ) : (
    "No installer available — install it on the server manually."
  );

  return (
    <SettingRow icon={getRegistryIcon("agent", agent.id, 15)} label={label} description={description}>
      {busy ? null : failed ? (
        <Button size="sm" variant="outline" onClick={() => void installAgent(agent.id)}>
          <RefreshCw size={13} /> Retry
        </Button>
      ) : agent.enabled ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!agent.updateCmd}
          title={agent.updateCmd}
          onClick={() => void updateAgent(agent.id)}
        >
          <RefreshCw size={13} /> Update
        </Button>
      ) : (
        <Button size="sm" disabled={!agent.installCmd} onClick={() => void installAgent(agent.id)}>
          <Download size={13} /> Install
        </Button>
      )}
    </SettingRow>
  );
};
