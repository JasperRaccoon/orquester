// The approval card of `control_desktop` (unified MCP design 2026-10-15 §7.1: "desktop
// open/launch: command, cwd, env keys"; values too, per final review F2) — plan Task 12. Pure: built
// from the frozen arguments and the desktop as `/api/desktops` lists it. Every env value is shown in full beside its key (the agent
// wrote them, so masking would hide nothing from it and everything from the user — final review F2),
// and a key that changes which code runs (loader paths, the search path, runtime preloads, shell
// startup files, git's ssh/exec hooks) is named in a warning, because it can make the command run
// something else.

import type { ApprovalPreviewSection, DesktopSummary } from "@orquester/api";
import type { ApprovalPreview } from "../catalog/contract.ts";

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: "Claude", codex: "Codex", grok: "Grok", opencode: "OpenCode" };

/** The agent's display name for card titles ("An agent" for external callers, who never see a card). */
export const agentLabel = (agentId: string | undefined): string => (agentId ? (AGENT_LABELS[agentId] ?? agentId) : "An agent");

/**
 * Environment keys that change which code runs: dynamic-loader paths and preloads, the search path,
 * language runtime preloads and module paths, shell startup files, git's ssh/exec/config hooks, and
 * GUI toolkit / graphics driver plugin paths (a desktop runs GUI apps).
 */
const LOADER_KEYS: ReadonlySet<string> = new Set([
  "PATH",
  // Shells: files sourced or commands run at startup / every prompt.
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "IFS",
  // Node / Electron.
  "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE",
  // Python, Perl, Ruby.
  "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONUSERBASE", "PERL5LIB", "PERLLIB", "PERL5OPT", "RUBYOPT", "RUBYLIB",
  // JVM, .NET.
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "DOTNET_STARTUP_HOOKS", "DOTNET_ADDITIONAL_DEPS",
  // git: commands it runs and config it reads.
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_EDITOR", "GIT_PAGER", "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_TEMPLATE_DIR",
  // Programs other programs start.
  "EDITOR", "VISUAL", "PAGER", "BROWSER", "LESSOPEN", "LESSCLOSE",
  // GUI toolkits and graphics drivers: plugins loaded into every app.
  "GTK_MODULES", "GTK3_MODULES", "GTK_PATH", "QT_PLUGIN_PATH", "QT_QPA_PLATFORM_PLUGIN_PATH", "LIBGL_DRIVERS_PATH",
  "VK_ICD_FILENAMES", "VK_DRIVER_FILES", "VK_LAYER_PATH", "VK_ADD_LAYER_PATH", "VK_INSTANCE_LAYERS", "__EGL_VENDOR_LIBRARY_FILENAMES",
  "GCONV_PATH"
]);
/** Key prefixes with the same effect: the dynamic loaders, git's numbered config entries, .NET/CLR profilers. */
const LOADER_PREFIX = /^(LD_|DYLD_|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_|CORECLR_|COR_PROFILER)/;

/** Whether setting `key` can change which program, library or startup code a command runs. */
export const isLoaderEnvKey = (key: string): boolean => LOADER_KEYS.has(key) || LOADER_PREFIX.test(key);

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
  sections.push({ kind: "fields", title: "How it runs", rows: [{ label: "Working directory", value: input.cwd ?? "the project" }] });
  const env = input.env ?? {};
  const keys = Object.keys(env).sort();
  // Every value in full: the agent wrote it, and the user approves what actually runs.
  if (keys.length > 0) sections.push({ kind: "fields", title: "Environment", rows: keys.map((key) => ({ label: key, value: env[key] ?? "" })) });
  const flagged = keys.filter(isLoaderEnvKey);
  if (flagged.length > 0) {
    sections.push({
      kind: "warning",
      level: "caution",
      text: `${flagged.join(", ")} change${flagged.length === 1 ? "s" : ""} which program, library or startup code the command runs.`
    });
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
