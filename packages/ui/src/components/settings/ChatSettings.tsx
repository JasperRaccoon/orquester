import React from "react";
import { continueThreadsForProject } from "@orquester/config";
import { Button, Switch } from "../ui";
import { useAppStore } from "../../store/app";
import { Badge, SegmentedControl, SettingRow, SettingsPage, SettingsSection } from "./primitives";

const FOLLOW_UP_OPTIONS = [
  { value: "steer", label: "Steer" },
  { value: "queue", label: "Queue" }
] as const;

/**
 * Agent-chat behaviour (agent chat spec §7.4, §4.6.7, §3.3).
 *
 * Three settings with two different homes, which is why the page splits them
 * into sections by where they are saved: the composer habits are per-device and
 * live in localStorage; continuing after a restart is daemon state the HOST
 * reads at boot, per project, so it rides `app.json` and is shared by every
 * client of that daemon.
 */
export const ChatSettings: React.FC = () => {
  const chatPrefs = useAppStore((s) => s.chatPrefs);
  const setChatPrefs = useAppStore((s) => s.setChatPrefs);
  const agentPrefs = useAppStore((s) => s.appConfig.agents);
  const updateAgentPrefs = useAppStore((s) => s.updateAgentPrefs);
  const project = useAppStore((s) => s.currentProject);

  const projectOverride = project
    ? agentPrefs.continueThreadsByProject[project.path]
    : undefined;
  const continuesHere = project
    ? continueThreadsForProject(agentPrefs, project.path)
    : agentPrefs.continueThreadsAfterRestart;

  return (
    <SettingsPage title="Agent chat" description="How the composer sends messages and what happens to turns a restart cuts short.">
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
    </SettingsPage>
  );
};
