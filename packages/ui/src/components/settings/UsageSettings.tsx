import React from "react";
import { Gauge, Loader2, RefreshCw } from "lucide-react";
import type { UsagePrefs } from "@orquester/config";
import { cn } from "../../lib/cn";
import type { UsageResetFormat } from "../../lib/usage-display";
import { getRegistryIcon } from "../../icons";
import { useRegistry, useUsageResetFormat } from "../../hooks";
import { useAppStore } from "../../store/app";
import { Button, Switch } from "../ui";
import { Badge, SegmentedControl, SettingRow, SettingsPage, SettingsSection, type Tone } from "./primitives";
import { UsageOverview } from "./UsageOverview";

type UsageAgentId = "claude" | "codex" | "grok";

/** The agents that report usage, with the names the toggles show. */
const USAGE_AGENTS: { id: UsageAgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok Build" }
];

/** "Busiest" follows whichever agent is closest to a limit. */
const CHIP_OPTIONS: { value: UsagePrefs["chip"]; label: string }[] = [
  { value: "busiest", label: "Busiest" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "grok", label: "Grok" }
];

const RESET_OPTIONS: { value: UsageResetFormat; label: string }[] = [
  { value: "relative", label: "Countdown" },
  { value: "absolute", label: "Clock" },
  { value: "both", label: "Both" }
];

export const UsageSettings: React.FC = () => {
  const prefs = useAppStore((s) => s.appConfig.usage);
  const usage = useAppStore((s) => s.usage);
  const updateAppConfig = useAppStore((s) => s.updateAppConfig);
  const loadUsage = useAppStore((s) => s.loadUsage);
  const registry = useRegistry();
  const [resetFormat, setResetFormat] = useUsageResetFormat();
  const [refreshing, setRefreshing] = React.useState(false);

  const setUsage = (patch: Partial<typeof prefs>) => void updateAppConfig({ usage: { ...prefs, ...patch } });

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadUsage(true);
    } finally {
      setRefreshing(false);
    }
  };

  const agentHint = (id: UsageAgentId): { label: string; tone: Tone } => {
    // Grok's credential can come from a managed account alone — the grok CLI
    // need not be installed for usage to report.
    if (id !== "grok") {
      const installed = registry.agents.some((a) => a.id === id && a.enabled);
      if (!installed) return { label: "Not installed", tone: "neutral" };
    }
    const found = usage?.agents.find((a) => a.id === id);
    if (!found) return { label: id === "grok" ? "Not linked" : "Not logged in", tone: "neutral" };
    if (found.stale) {
      return { label: found.plan ? `Logged in · ${found.plan} — updating…` : "Logged in — updating…", tone: "ok" };
    }
    return { label: found.plan ? `Logged in · ${found.plan}` : "Logged in", tone: "ok" };
  };

  // With the chip off, "Chip shows" has nothing to drive: it stays changeable
  // (the choice is kept for when the chip returns) but reads as secondary.
  // The per-agent switches stay at full strength — they also decide which
  // cards the overview marks Hidden and which missing logins it lists.
  const chipOff = !prefs.enabled;

  return (
    <SettingsPage
      title="Usage"
      description="Quota for each agent login, read from the active daemon — credentials never leave it."
      wide
      actions={
        <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          Refresh
        </Button>
      }
    >
      <SettingsSection
        title="Quotas"
        bare
        actions={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-neutral-500">Resets as</span>
            <SegmentedControl
              size="xs"
              ariaLabel="Show reset times as"
              value={resetFormat}
              onChange={setResetFormat}
              options={RESET_OPTIONS.map((o) => ({
                ...o,
                title: `Show reset times as a ${o.label.toLowerCase()}`
              }))}
            />
          </div>
        }
      >
        <UsageOverview refreshing={refreshing} onRefresh={() => void refresh()} />
      </SettingsSection>

      <SettingsSection title="Top-bar chip" description="A compact quota chip that opens a details panel.">
        <SettingRow label="Show usage in the top bar" icon={<Gauge size={14} />}>
          <Switch
            label="Show usage in the top bar"
            checked={prefs.enabled}
            onChange={(v) => setUsage({ enabled: v })}
          />
        </SettingRow>
        <SettingRow
          label="Chip shows"
          description={chipOff ? "Applies once the chip is shown." : "Which agent drives the collapsed chip."}
          className={cn("transition-opacity", chipOff && "opacity-50")}
        >
          <SegmentedControl
            ariaLabel="Chip shows"
            value={prefs.chip}
            onChange={(chip) => setUsage({ chip })}
            options={CHIP_OPTIONS.map((o) => ({
              ...o,
              icon: o.value === "busiest" ? <Gauge size={12} /> : getRegistryIcon("agent", o.value, 12)
            }))}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="Agents in the chip and panel"
        description="Turning an agent off keeps it out of the chip and panel; its card above stays, marked Hidden."
      >
        {USAGE_AGENTS.map(({ id, label }) => {
          const hint = agentHint(id);
          return (
            <SettingRow
              key={id}
              label={label}
              icon={getRegistryIcon("agent", id, 14)}
              description={
                <Badge tone={hint.tone}>
                  {hint.label}
                </Badge>
              }
            >
              <Switch
                label={`Show ${label} usage`}
                checked={prefs.agents[id] ?? true}
                onChange={(v) => setUsage({ agents: { ...prefs.agents, [id]: v } })}
              />
            </SettingRow>
          );
        })}
      </SettingsSection>
    </SettingsPage>
  );
};
