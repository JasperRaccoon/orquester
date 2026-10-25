import React from "react";

import { useIsDesktop } from "../../hooks";
import { AgentProfileEditorHost } from "../right-rail/agent-profile/AgentProfileEditorHost";
import { AgentProfilePanel } from "../right-rail/agent-profile/AgentProfilePanel";
import { useActiveChatTarget } from "../right-rail/chat-target";
import { SettingsPage } from "./primitives";

/** The page's one-line intro: what this edits, and which chats load it. */
const AGENT_CONFIG_INTRO =
  "Each agent's own global setup — its instruction file, MCP servers, skills, plugins, hooks and commands. Chats with no profile (\"Global\") load it.";

/**
 * Settings → Agent config (agent profiles spec §5.4): the per-agent global
 * config editor (agent profile spec §7), unchanged in behavior — Claude,
 * Codex, Grok and OpenCode, their instruction file and every item kind, with
 * add, import, copy and live sync. It is how "Global" is managed.
 *
 * The panel lists and scrolls inside a fixed-height card (the page fills the
 * content area, `fill`), its search and kind tabs pinned on top and "+ Add"
 * at the bottom. Until an agent is picked it follows the visible chat tab, as
 * it did in the rail. Its editor host is mounted with it: the editor opens
 * over Settings, and nothing else opens it.
 */
export const AgentConfigSettings: React.FC = () => {
  const isDesktop = useIsDesktop();
  const sessionId = useActiveChatTarget();
  return (
    <SettingsPage title="Agent config" description={AGENT_CONFIG_INTRO} fill>
      <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/30 pt-3 text-sm">
        <AgentProfilePanel sessionId={sessionId} projectPath="" variant={isDesktop ? "docked" : "sheet"} />
      </div>
      <AgentProfileEditorHost />
    </SettingsPage>
  );
};
