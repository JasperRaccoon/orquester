import React from "react";
import { SYSTEM_ACCOUNT_ID } from "@orquester/api";
import { continueThreadsForProject, IDLE_COMPACTION_MODES, type IdleCompactionMode } from "@orquester/config";
import { Button, Switch } from "../ui";
import { useAppStore } from "../../store/app";
import { Badge, SegmentedControl, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const ACCOUNT_IDLE_COMPACTION_OPTIONS = [{ value: "default", label: "Use default" }, ...IDLE_COMPACTION_MODES] as const;
type AccountIdleCompaction = (typeof ACCOUNT_IDLE_COMPACTION_OPTIONS)[number]["value"];

const FOLLOW_UP_OPTIONS = [
  { value: "steer", label: "Steer" },
  { value: "queue", label: "Queue" }
] as const;

/**
 * Agent-chat behaviour (agent chat spec §7.4, §4.6.7, §3.3).
 *
 * Settings with two different homes, which is why the page splits them into
 * sections by where they are saved: the composer habits are per-device and
 * live in localStorage; continuing after a restart is daemon state the HOST
 * reads at boot, per project, and the usage-limit recovery is daemon state the
 * DAEMON reads at every limit, so both ride `app.json` and are shared by every
 * client of that daemon. So does idle compaction, which the daemon schedules and
 * the host reads when Claude asks its resume question.
 */
export const ChatSettings: React.FC = () => {
  const chatPrefs = useAppStore((s) => s.chatPrefs);
  const setChatPrefs = useAppStore((s) => s.setChatPrefs);
  const agentPrefs = useAppStore((s) => s.appConfig.agents);
  const updateAgentPrefs = useAppStore((s) => s.updateAgentPrefs);
  const project = useAppStore((s) => s.currentProject);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  // T3 Code's per-instance override: the system login and each managed Claude account.
  const claudeAccounts = [
    { id: SYSTEM_ACCOUNT_ID, label: "System login" },
    ...(agentAccounts?.accounts ?? []).filter((account) => account.agent === "claude").map((account) => ({ id: account.id, label: account.label }))
  ];
  const setAccountIdleCompaction = (accountId: string, value: AccountIdleCompaction) => {
    const next: Record<string, IdleCompactionMode> = { ...agentPrefs.claudeIdleCompactionByAccount };
    if (value === "default") delete next[accountId];
    else next[accountId] = value;
    void updateAgentPrefs({ ...agentPrefs, claudeIdleCompactionByAccount: next });
  };

  const projectOverride = project
    ? agentPrefs.continueThreadsByProject[project.path]
    : undefined;
  const continuesHere = project
    ? continueThreadsForProject(agentPrefs, project.path)
    : agentPrefs.continueThreadsAfterRestart;

  return (
    <SettingsPage title="Agent chat" description="How the composer sends messages, what happens to turns a restart cuts short, how chats recover from usage limits, and when idle Claude chats are compacted.">
      <SettingsSection title="Composer" description="Saved on this device.">
        <SettingRow
          label="Enter while the agent is working"
          description="Steer hands your message to the running turn now. Queue holds it until the next tool call finishes or the turn ends. ⌘/Ctrl+Enter does the other for one message."
        >
          <SegmentedControl
            ariaLabel="Enter while the agent is working"
            value={chatPrefs.followUpBehavior}
            options={FOLLOW_UP_OPTIONS}
            onChange={(value) => setChatPrefs({ followUpBehavior: value })}
          />
        </SettingRow>
        <SettingRow
          label="List skills in the / menu"
          description="Off keeps / to commands only. Skills are always listed under $, so nothing becomes unreachable."
        >
          <Switch
            label="List skills in the / menu"
            checked={chatPrefs.showSkillsInSlashMenu}
            onChange={(checked) => setChatPrefs({ showSkillsInSlashMenu: checked })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="After a restart" description="Shared by every client of this server.">
        <SettingRow
          label="Continue interrupted turns"
          description="After a crash, reboot or manual restart, threads with a saved resume point pick up where they left off; others wait for a new message. Off by default: resuming is wrong when a turn was halfway through something destructive."
        >
          <Switch
            label="Continue interrupted turns"
            checked={agentPrefs.continueThreadsAfterRestart}
            onChange={(checked) =>
              void updateAgentPrefs({ ...agentPrefs, continueThreadsAfterRestart: checked })
            }
          />
        </SettingRow>
        {project ? (
          <SettingRow
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                <span>
                  In <span className="font-medium">{project.name}</span>
                </span>
                {projectOverride === undefined ? (
                  <Badge>Default</Badge>
                ) : (
                  <Badge tone="info">Pinned {projectOverride ? "on" : "off"}</Badge>
                )}
              </span>
            }
            description={
              projectOverride === undefined
                ? `Following the default (${continuesHere ? "on" : "off"}). Flip it to pin this project.`
                : "Pinned for this project, whatever the default says."
            }
          >
            {projectOverride !== undefined && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const next = { ...agentPrefs.continueThreadsByProject };
                  delete next[project.path];
                  void updateAgentPrefs({ ...agentPrefs, continueThreadsByProject: next });
                }}
              >
                Use default
              </Button>
            )}
            <Switch
              label={`Continue interrupted turns in ${project.name}`}
              checked={continuesHere}
              onChange={(checked) =>
                void updateAgentPrefs({
                  ...agentPrefs,
                  continueThreadsByProject: {
                    ...agentPrefs.continueThreadsByProject,
                    [project.path]: checked
                  }
                })
              }
            />
          </SettingRow>
        ) : (
          <SettingRow
            label="Per-project override"
            description="Open a project to pin a different choice for it."
          />
        )}
      </SettingsSection>

      <SettingsSection title="Usage limits" description="Shared by every client of this server.">
        <SettingRow
          label="Auto-resume chats when the usage limit resets"
          description={'When a chat stops on its account\'s usage limit and the reset time is known, send "Continue where you left off." shortly after the reset. A chat you have written to since, or that waits for an approval or an answer, is left alone; each chat\'s banner can cancel it.'}
        >
          <Switch
            label="Auto-resume chats when the usage limit resets"
            checked={agentPrefs.autoResumeLimitedChats}
            onChange={(checked) => void updateAgentPrefs({ ...agentPrefs, autoResumeLimitedChats: checked })}
          />
        </SettingRow>
        <SettingRow
          label="Switch to another account when a chat hits its usage limit"
          description="Move the chat to another account of the same agent that still has quota, and continue there. When every account is limited, the chat waits for the earliest reset instead. Off by default: it spends another account's quota without asking. Never for OpenCode, which has no accounts."
        >
          <Switch
            label="Switch to another account when a chat hits its usage limit"
            checked={agentPrefs.switchAccountOnUsageLimit}
            onChange={(checked) => void updateAgentPrefs({ ...agentPrefs, switchAccountOnUsageLimit: checked })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Idle Claude chats" description="Shared by every client of this server.">
        <SettingRow
          label="Compact idle chats"
          description="When to compact an idle Claude chat over 200,000 tokens. When you return shows a Compact chip beside Send once its prompt cache has expired: sending compacts first, or click it to keep the full history. Before the cache expires (beta) sends /compact two minutes before the cache runs out (an hour on a subscription, 5 minutes with an API key), so coming back does not re-read the whole conversation; it shows in the chat as an automatic compaction. Never skips both, and answers Claude's own resume prompt with the full history. You can always compact by hand."
        >
          <SegmentedControl
            ariaLabel="Compact idle chats"
            value={agentPrefs.claudeIdleCompaction}
            options={IDLE_COMPACTION_MODES}
            onChange={(value) => void updateAgentPrefs({ ...agentPrefs, claudeIdleCompaction: value })}
          />
        </SettingRow>
        {claudeAccounts.map((account) => {
          const override = Object.hasOwn(agentPrefs.claudeIdleCompactionByAccount, account.id)
            ? agentPrefs.claudeIdleCompactionByAccount[account.id]
            : undefined;
          return (
            <SettingRow
              key={account.id}
              label={
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-medium">{account.label}</span>
                  {override === undefined ? <Badge>Default</Badge> : <Badge tone="info">Pinned</Badge>}
                </span>
              }
              description={
                override === undefined
                  ? "Chats on this account follow the default."
                  : "Chats on this account use this, whatever the default says."
              }
            >
              <SegmentedControl
                ariaLabel={`Compact idle chats on ${account.label}`}
                size="xs"
                value={override ?? "default"}
                options={ACCOUNT_IDLE_COMPACTION_OPTIONS}
                onChange={(value) => setAccountIdleCompaction(account.id, value)}
              />
            </SettingRow>
          );
        })}
      </SettingsSection>
    </SettingsPage>
  );
};
