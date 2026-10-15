// The approval card of `control_desktop` (unified MCP design 2026-10-15 §7.1: "desktop
// open/launch: command, cwd, env keys") — plan Task 12. Pure: built from the frozen arguments and
// the desktop as `/api/desktops` lists it. Env VALUES are never shown (they may be credentials the
// agent passes along); their keys are, and a key that changes how a program is loaded or found is
// flagged, because it can make the command run something else.

import type { ApprovalPreviewSection, DesktopSummary } from "@orquester/api";
import type { ApprovalPreview } from "../catalog/contract.ts";

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** The agent's display name for card titles ("An agent" for external callers, who never see a card). */
export const agentLabel = (agentId: string | undefined): string => (agentId ? (AGENT_LABELS[agentId] ?? agentId) : "An agent");

/** Environment keys that change which code runs: loader paths, the search path, runtime preloads. */
const LOADER_KEY = /^(LD_|DYLD_)|^(PATH|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|BASH_ENV|ENV)$/;

export interface DesktopPreviewInput {
  action: "open" | "launch_app" | "stop_app" | "close_window" | "close";
  agentId: string | undefined;
  /** `ws/p` of the project the desktop is (or opens) in. */
  projectLabel: string;
  /** The desktop acted on (every action but `open`). */
  desktop?: Pick<DesktopSummary, "id" | "title" | "apps" | "windows">;
  title?: string;
  size?: { width: number; height: number };
  renderThreads?: number;
  command?: string;
  /** The working directory as it will be used (absolute), when given. */
  cwd?: string;
  env?: Record<string, string>;
  appId?: string;
  windowId?: string;
  force?: boolean;
}

function launchSections(input: DesktopPreviewInput): ApprovalPreviewSection[] {
  if (input.command === undefined) return [];
  const sections: ApprovalPreviewSection[] = [{ kind: "code", title: "Command", language: "sh", text: input.command }];
  const rows: { label: string; value: string; state?: "flagged" }[] = [{ label: "Working directory", value: input.cwd ?? "the project" }];
  const keys = Object.keys(input.env ?? {}).sort();
  for (const key of keys) rows.push({ label: "Environment", value: key, ...(LOADER_KEY.test(key) ? { state: "flagged" as const } : {}) });
  sections.push({ kind: "fields", title: "How it runs", rows });
  const flagged = keys.filter((key) => LOADER_KEY.test(key));
  if (flagged.length > 0) {
    sections.push({ kind: "warning", level: "caution", text: `${flagged.join(", ")} change${flagged.length === 1 ? "s" : ""} which program or library the command loads.` });
  }
  return sections;
}

/** The card's content for one `control_desktop` call. */
export function desktopPreview(input: DesktopPreviewInput): ApprovalPreview {
  const agent = agentLabel(input.agentId);
  const scopeLabel = `Project ${input.projectLabel}`;
  const desktopName = input.desktop ? `"${input.desktop.title}"` : "";
  switch (input.action) {
    case "open": {
      const rows = [
        { label: "Project", value: input.projectLabel },
        { label: "Title", value: input.title ?? "Desktop" },
        ...(input.size ? [{ label: "Size", value: `${input.size.width}×${input.size.height}` }] : []),
        ...(input.renderThreads !== undefined ? [{ label: "Render threads", value: String(input.renderThreads) }] : [])
      ];
      return {
        title: `${agent} wants to open a desktop in ${input.projectLabel}${input.command !== undefined ? " and run a command in it" : ""}`,
        scopeLabel,
        sections: [
          { kind: "text", text: "A desktop runs GUI apps on this computer, as you, with access to your files." },
          { kind: "fields", title: "Desktop", rows },
          ...launchSections(input)
        ]
      };
    }
    case "launch_app":
      return {
        title: `${agent} wants to run a command in the desktop ${desktopName} (${input.projectLabel})`,
        scopeLabel,
        sections: [{ kind: "text", text: "The command runs on this computer, as you, with access to your files." }, ...launchSections(input)]
      };
    case "stop_app": {
      const app = input.desktop?.apps.find((candidate) => candidate.id === input.appId);
      return {
        title: `${agent} wants to stop an app in the desktop ${desktopName} (${input.projectLabel})`,
        scopeLabel,
        sections: [{ kind: "fields", rows: [{ label: "App", value: app ? app.command : (input.appId ?? "") }, { label: "Force", value: input.force ? "yes (SIGKILL at once)" : "no" }] }]
      };
    }
    case "close_window": {
      const window = input.desktop?.windows.find((candidate) => candidate.id === input.windowId);
      return {
        title: `${agent} wants to close a window in the desktop ${desktopName} (${input.projectLabel})`,
        scopeLabel,
        sections: [{ kind: "fields", rows: [{ label: "Window", value: window ? `${window.title} (${window.id})` : (input.windowId ?? "") }] }]
      };
    }
    case "close":
      return {
        title: `${agent} wants to close the desktop ${desktopName} (${input.projectLabel})`,
        scopeLabel,
        sections: [{ kind: "text", text: `Every app in it stops (${input.desktop?.apps.length ?? 0}); unsaved work in them is lost.` }]
      };
  }
}
