import type { RegistryKind } from "@orquester/api";

export type { RegistryKind };

export interface RegistryEntryDef {
  id: string;
  name: string;
  kind: RegistryKind;
  /** bin candidates. May use tokens: $LOCALAPPDATA, $PROGRAMFILES, $HOME */
  bin: readonly string[];
  /** Extra args passed to the resolved bin when a session is launched (not used for resolution/version/install). */
  args?: readonly string[];
  /**
   * CLI args that resume a past conversation, `{id}` standing in for the
   * conversation id. Absent when the agent has no known resume flag (or its
   * history format isn't readable, so nothing can be offered to resume).
   */
  resumeArgs?: readonly string[];
  /** Launch the resolved bin as a child of a real shell instead of execing it directly. */
  launchViaShell?: boolean;
  /** Extra environment variables set on the process when a session is launched. */
  env?: Readonly<Record<string, string>>;
  versionFlag?: string;
  installCmd?: string;
  /** Windows override for installCmd; the daemon picks this on win32. installCmd stays the POSIX form. */
  installCmdWin32?: string;
  updateCmd?: string;
  /**
   * When false, the entry is disabled at rest even if its bin resolves — a
   * daemon service (the CliProxyManager) enables it at runtime once its backing
   * infrastructure is healthy. Absent/true means "enabled as soon as bin found".
   */
  enabledAtRest?: boolean;
}

/**
 * Single source of truth.
 * Pure static data. No logic, no env evaluation here.
 */
export const REGISTRY = {
  shells: [
    { id: "bash", name: "Bash", kind: "shell", bin: ["bash"] as const },
    { id: "zsh", name: "Zsh", kind: "shell", bin: ["zsh"] as const },
    { id: "fish", name: "Fish", kind: "shell", bin: ["fish"] as const },
    { id: "nu", name: "Nushell", kind: "shell", bin: ["nu"] as const },
    { id: "pwsh", name: "PowerShell", kind: "shell", bin: ["pwsh", "powershell"] as const },
    { id: "cmd", name: "Command Prompt", kind: "shell", bin: ["cmd"] as const },
    { id: "sh", name: "sh", kind: "shell", bin: ["sh"] as const }
  ] as const,

  agents: [
    {
      id: "claude",
      name: "Claude Code",
      kind: "agent",
      bin: ["claude"] as const,
      // Equivalent of the user's `claude --d` shell shortcut, expanded so it works
      // when the daemon execs the binary directly (shell functions aren't consulted).
      args: ["--dangerously-skip-permissions", "--effort", "max", "--verbose"] as const,
      // Claude Code repaints its whole TUI each frame, which flickers over a
      // streamed PTY; this switches it to flicker-free diff rendering.
      env: { CLAUDE_CODE_NO_FLICKER: "1" },
      versionFlag: "--version",
      // Native installer (not npm -g): it manages ~/.local/bin/claude as a symlink into
      // ~/.local/share/claude/versions/<v> and flips it atomically on update, so a running
      // agent's binary is never rewritten in place. npm -g rewrites the binary in place, which
      // races Claude Code's own "binary changed -> self-restart" and dies with EACCES/ENOENT.
      installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
      installCmdWin32: 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"',
      updateCmd: "claude update",
      resumeArgs: ["--resume", "{id}"] as const
    },
    {
      id: "codex",
      name: "Codex",
      kind: "agent",
      bin: ["codex"] as const,
      args: ["--yolo"] as const,
      versionFlag: "--version",
      installCmd: "npm install -g @openai/codex",
      updateCmd: "npm update -g @openai/codex",
      // A subcommand, not a flag: codex's argument-free launch is a distinct mode.
      resumeArgs: ["resume", "{id}"] as const
    },
    {
      id: "cline",
      name: "Cline",
      kind: "agent",
      bin: ["cline"] as const,
      versionFlag: "--version",
      installCmd: "npm install -g cline",
      updateCmd: "npm update -g cline",
      resumeArgs: ["--id", "{id}"] as const
    },
    {
      // DETECT-ONLY on purpose — no installCmd/updateCmd, so Settings → Agents
      // shows it only once a `deepseek` binary is already on PATH and the
      // Install button stays disabled.
      //
      // The command this used to carry (`npm i -g @deepseek-ai/deepseek-cli`)
      // 404s: DeepSeek publishes no such package, and no official DeepSeek
      // coding-agent CLI exists on npm. The unscoped `deepseek-cli` name IS
      // taken (1.0.2, Jan 2025) but by an unaffiliated single-maintainer
      // OpenAI-SDK wrapper, not an agent harness — pointing an in-app Install
      // button at a stranger's package is worse than offering no install at
      // all. Restore an installCmd only if DeepSeek ships a first-party CLI.
      id: "deepseek",
      name: "DeepSeek",
      kind: "agent",
      bin: ["deepseek"] as const,
      versionFlag: "--version"
    },
    {
      // Not a rename of `deepseek` above — a different vendor's CLI (vegamo's
      // deepcode-cli, binary `deepcode`) that happens to drive DeepSeek models.
      id: "deepcode",
      name: "Deep Code",
      kind: "agent",
      bin: ["deepcode"] as const,
      versionFlag: "--version",
      installCmd: "npm install -g @vegamo/deepcode-cli",
      updateCmd: "npm update -g @vegamo/deepcode-cli"
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      kind: "agent",
      bin: ["gemini"] as const,
      versionFlag: "--version",
      installCmd: "npm install -g @google/gemini-cli",
      updateCmd: "npm update -g @google/gemini-cli"
    },
    {
      id: "kimi",
      name: "Kimi Code",
      kind: "agent",
      bin: ["kimi"] as const,
      versionFlag: "--version",
      // Single-binary installer (no npm package); the documented POSIX and
      // PowerShell one-liners from code.kimi.com.
      installCmd: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      installCmdWin32: 'powershell -NoProfile -Command "irm https://code.kimi.com/kimi-code/install.ps1 | iex"',
      updateCmd: "kimi upgrade",
      resumeArgs: ["--session", "{id}"] as const
    },
    {
      id: "opencode",
      name: "OpenCode",
      kind: "agent",
      bin: ["opencode"] as const,
      launchViaShell: true,
      versionFlag: "--version",
      installCmd: "npm install -g opencode-ai",
      updateCmd: "npm update -g opencode-ai",
      resumeArgs: ["--session", "{id}"] as const
    },
    {
      id: "grok",
      name: "Grok Build",
      kind: "agent",
      bin: ["grok"] as const,
      args: ["--yolo"] as const,
      // A managed install must never self-update: the daemon owns the binary's
      // lifecycle through installCmd/updateCmd.
      env: { GROK_DISABLE_AUTOUPDATER: "1" },
      versionFlag: "--version",
      installCmd: "npm install -g @xai-official/grok",
      installCmdWin32: "npm install -g @xai-official/grok",
      updateCmd: "npm update -g @xai-official/grok",
      resumeArgs: ["--resume", "{id}"] as const
    },
    {
      // Google's Antigravity CLI. The id is `agy` (its binary name) because the
      // IDE entry already owns `antigravity` and registry ids are one namespace.
      id: "agy",
      name: "Antigravity CLI",
      kind: "agent",
      bin: ["agy"] as const,
      versionFlag: "--version",
      installCmd: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      installCmdWin32: 'powershell -NoProfile -Command "irm https://antigravity.google/cli/install.ps1 | iex"',
      updateCmd: "agy update",
      resumeArgs: ["--conversation", "{id}"] as const
    },
    {
      // Claude Code driven through the managed CLIProxyAPI against a GPT/Kimi
      // catalog. Reuses the `claude` binary; the CliProxyManager enables it at
      // runtime once the proxy is healthy (disabled at rest).
      id: "claudex",
      name: "Claude Code × GPT/Kimi/Grok",
      kind: "agent",
      bin: ["claude"] as const,
      // "high", not the plain-claude "max": Sol is already the slow deep tier,
      // and max-effort turns there run into many minutes each. /effort in-tab
      // overrides per session.
      args: ["--dangerously-skip-permissions", "--effort", "high", "--verbose"] as const,
      env: { CLAUDE_CODE_NO_FLICKER: "1" },
      versionFlag: "--version",
      enabledAtRest: false
    },
    {
      // Claude Code with a mixed model set (Claude OAuth main loop + GPT/Kimi
      // side channels) through the managed proxy. Also runtime-enabled.
      id: "claudemix",
      name: "Claude Code × Mixed",
      kind: "agent",
      bin: ["claude"] as const,
      // "high" like claudex — GPT/Kimi side channels get painfully slow at max.
      args: ["--dangerously-skip-permissions", "--effort", "high", "--verbose"] as const,
      env: { CLAUDE_CODE_NO_FLICKER: "1" },
      versionFlag: "--version",
      enabledAtRest: false
    }
  ] as const,

  ides: [
    {
      id: "vscode",
      name: "VS Code",
      kind: "ide",
      bin: [
        "code",
        "code-insiders",
        "/usr/bin/code",
        "/usr/share/code/bin/code",
        "/snap/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        "$LOCALAPPDATA\\Programs\\Microsoft VS Code\\bin\\code.cmd",
        "$PROGRAMFILES\\Microsoft VS Code\\bin\\code.cmd"
      ] as const
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "ide",
      bin: [
        "cursor",
        "/usr/bin/cursor",
        "/usr/share/cursor/bin/cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        "$LOCALAPPDATA\\Programs\\cursor\\resources\\app\\bin\\cursor.cmd"
      ] as const
    },
    {
      id: "antigravity",
      name: "Antigravity",
      kind: "ide",
      bin: [
        "antigravity",
        "/usr/bin/antigravity",
        "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity",
        "$LOCALAPPDATA\\Programs\\Antigravity\\bin\\antigravity.cmd"
      ] as const
    },
    {
      id: "windsurf",
      name: "Windsurf",
      kind: "ide",
      bin: ["windsurf", "/usr/bin/windsurf", "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf"] as const
    },
    {
      id: "zed",
      name: "Zed",
      kind: "ide",
      bin: ["zed", "zeditor", "/usr/bin/zed", "/Applications/Zed.app/Contents/MacOS/cli"] as const
    },
    {
      id: "intellij",
      name: "IntelliJ IDEA",
      kind: "ide",
      bin: ["idea", "idea.sh", "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"] as const
    },
    {
      id: "sublime",
      name: "Sublime Text",
      kind: "ide",
      bin: ["subl", "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"] as const
    },
    {
      id: "clion",
      name: "CLion",
      kind: "ide",
      bin: ["clion", "/Applications/CLion.app/Contents/MacOS/clion"] as const
    },
    {
      id: "goland",
      name: "GoLand",
      kind: "ide",
      bin: ["goland", "/Applications/GoLand.app/Contents/MacOS/goland"] as const
    },
    {
      id: "phpstorm",
      name: "PhpStorm",
      kind: "ide",
      bin: ["phpstorm", "/Applications/PhpStorm.app/Contents/MacOS/phpstorm"] as const
    },
    {
      id: "pycharm",
      name: "PyCharm",
      kind: "ide",
      bin: ["pycharm", "/Applications/PyCharm.app/Contents/MacOS/pycharm"] as const
    },
    {
      id: "rustrover",
      name: "RustRover",
      kind: "ide",
      bin: ["rustrover", "/Applications/RustRover.app/Contents/MacOS/rustrover"] as const
    }
  ] as const,

  fileExplorers: [
    { id: "nautilus", name: "Files (Nautilus)", kind: "file-explorer", bin: ["nautilus"] as const },
    { id: "dolphin", name: "Dolphin", kind: "file-explorer", bin: ["dolphin"] as const },
    { id: "thunar", name: "Thunar", kind: "file-explorer", bin: ["thunar"] as const },
    { id: "nemo", name: "Nemo", kind: "file-explorer", bin: ["nemo"] as const },
    { id: "pcmanfm", name: "PCManFM", kind: "file-explorer", bin: ["pcmanfm"] as const },
    { id: "caja", name: "Caja", kind: "file-explorer", bin: ["caja"] as const },
    { id: "explorer", name: "Explorer", kind: "file-explorer", bin: ["explorer"] as const },
    { id: "system-files", name: "Open Directory", kind: "file-explorer", bin: [] as const }
  ] as const,

  browsers: [
    {
      id: "chrome",
      name: "Google Chrome",
      kind: "browser",
      bin: [
        "google-chrome",
        "google-chrome-stable",
        "chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "$PROGRAMFILES\\Google\\Chrome\\Application\\chrome.exe"
      ] as const
    },
    { id: "chromium", name: "Chromium", kind: "browser", bin: ["chromium", "chromium-browser"] as const },
    {
      id: "firefox",
      name: "Firefox",
      kind: "browser",
      bin: ["firefox", "/Applications/Firefox.app/Contents/MacOS/firefox", "$PROGRAMFILES\\Mozilla Firefox\\firefox.exe"] as const
    },
    {
      id: "brave",
      name: "Brave",
      kind: "browser",
      bin: ["brave-browser", "brave", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] as const
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      kind: "browser",
      bin: [
        "microsoft-edge",
        "microsoft-edge-stable",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "$PROGRAMFILES\\Microsoft Edge\\Application\\msedge.exe"
      ] as const
    },
    { id: "vivaldi", name: "Vivaldi", kind: "browser", bin: ["vivaldi", "vivaldi-stable"] as const },
    { id: "system-browser", name: "Default Browser", kind: "browser", bin: [] as const }
  ] as const
} as const;

/**
 * The agent's own CLI flags for resuming `conversationId`, or `[]` when the
 * agent (or a non-agent id) has no known resume flag. Pure lookup over the
 * static catalog above — the daemon appends the result at spawn.
 */
export function resumeArgsFor(agentId: string, conversationId: string): string[] {
  const entry = (REGISTRY.agents as readonly RegistryEntryDef[]).find((a) => a.id === agentId);
  // Function replacer: an id containing `$&`/`$1` must be substituted
  // literally, not re-expanded by String.replace's pattern syntax.
  return entry?.resumeArgs?.map((arg) => arg.replace(/\{id\}/g, () => conversationId)) ?? [];
}

/**
 * Whether `agentId` has a known resume flag at all — i.e. whether
 * {@link resumeArgsFor} can ever return a non-empty result for it. The UI gates
 * its "resume a past conversation" affordances on this so it never offers a
 * resume the daemon would refuse with `RESUME_UNAVAILABLE`.
 *
 * Read from the same static catalog `resumeArgsFor` uses (not the runtime
 * registry entry), so the answer matches the daemon exactly — including for a
 * user-defined `agents.json` override, whose id the catalog does not know and
 * which therefore genuinely cannot resume. Shared UI/daemon gate in the spirit
 * of {@link CHROMIUM_FAMILY_IDS}.
 */
export function canResumeAgent(agentId: string): boolean {
  // Answered by running the real resolver rather than re-reading the catalog:
  // the two can never drift (the placeholder id is irrelevant — only the arity
  // of the result matters).
  return resumeArgsFor(agentId, "x").length > 0;
}

/**
 * Registry browser ids that speak CDP and can be driven by the daemon's
 * server-side browser tabs (Design Mode). Firefox and the empty-bin
 * "system-browser" fallback are deliberately excluded: they may be `enabled`
 * on a host that has no Chromium at all, and only Chromium-family binaries
 * work under puppeteer-core. Shared by the daemon's resolver and the UI's
 * new-tab gate so the menu never offers a browser the daemon will 409.
 */
export const CHROMIUM_FAMILY_IDS: ReadonlySet<string> = new Set([
  "chrome",
  "chromium",
  "brave",
  "edge",
  "vivaldi"
]);

/** One boolean toggle on a template variant; flipping it swaps which flag is appended. */
export interface ProjectTemplateOptionDef {
  id: string;
  label: string;
  /** Appended when the option is on. Empty string = append nothing (the CLI's default). */
  flagOn: string;
  /** Appended when the option is off. Empty string = append nothing. */
  flagOff: string;
  defaultOn: boolean;
}

export interface ProjectTemplateVariantDef {
  id: string;
  /** e.g. "React + TS" for the Vite template. */
  name: string;
  /** Opaque icon id — the client owns the id → mark mapping. */
  icon: string;
  /** The base command, before any option flags are appended. */
  command: string;
  options: readonly ProjectTemplateOptionDef[];
}

export interface ProjectTemplateDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  /** Bin names that must resolve on PATH before the template can be offered. */
  requires: readonly string[];
  variants: readonly ProjectTemplateVariantDef[];
}

const NO_TEMPLATE_OPTIONS: readonly ProjectTemplateOptionDef[] = [];

const VITE_INSTALL: ProjectTemplateOptionDef = {
  id: "install",
  label: "Install dependencies and start dev server",
  flagOn: "--immediate",
  flagOff: "--no-immediate",
  defaultOn: true
};
const VITE_ESLINT: ProjectTemplateOptionDef = {
  id: "eslint",
  label: "Use ESLint instead of Oxlint",
  flagOn: "--eslint",
  flagOff: "--no-eslint",
  defaultOn: false
};
const VITE_REACT_OPTIONS: readonly ProjectTemplateOptionDef[] = [VITE_INSTALL, VITE_ESLINT];
const VITE_OPTIONS: readonly ProjectTemplateOptionDef[] = [VITE_INSTALL];

const NEXT_OPTIONS: readonly ProjectTemplateOptionDef[] = [
  { id: "install", label: "Install dependencies", flagOn: "", flagOff: "--skip-install", defaultOn: true }
];

const ASTRO_OPTIONS: readonly ProjectTemplateOptionDef[] = [
  { id: "install", label: "Install dependencies", flagOn: "--install", flagOff: "--no-install", defaultOn: true }
];

const SVELTEKIT_OPTIONS: readonly ProjectTemplateOptionDef[] = [
  { id: "install", label: "Install dependencies", flagOn: "--install npm", flagOff: "--no-install", defaultOn: true }
];

/**
 * Static catalog of project scaffold commands. Unlike {@link REGISTRY} these are
 * not installable tools — each variant's command is TYPED INTO a fresh terminal
 * tab once the project directory exists, so the user watches it run and answers
 * any interactive prompts themselves instead of the daemon trying to capture
 * headless output from a command that wants a TTY.
 *
 * `requires` names bins the daemon probes against PATH to mark a template
 * available; `icon` is an opaque id the client maps to a mark.
 *
 * Flags were taken from each CLI's own `--help` (create-vite@7, create-next-app@15,
 * create-astro@5, sv@0.9). Scaffolders change flags across majors; a stale one
 * just fails live in the terminal in front of the user, same as any other error.
 */
export const TEMPLATES: readonly ProjectTemplateDef[] = [
  {
    id: "vite",
    name: "Vite",
    category: "Frontend",
    icon: "vite",
    requires: ["npm"],
    variants: [
      { id: "react", name: "React", icon: "react", command: "npm create vite@latest . -- --template react", options: VITE_REACT_OPTIONS },
      { id: "react-ts", name: "React + TS", icon: "typescript", command: "npm create vite@latest . -- --template react-ts", options: VITE_REACT_OPTIONS },
      { id: "vue", name: "Vue", icon: "vuejs", command: "npm create vite@latest . -- --template vue", options: VITE_OPTIONS },
      { id: "vue-ts", name: "Vue + TS", icon: "typescript", command: "npm create vite@latest . -- --template vue-ts", options: VITE_OPTIONS },
      { id: "svelte", name: "Svelte", icon: "svelte", command: "npm create vite@latest . -- --template svelte", options: VITE_OPTIONS },
      { id: "svelte-ts", name: "Svelte + TS", icon: "typescript", command: "npm create vite@latest . -- --template svelte-ts", options: VITE_OPTIONS },
      { id: "vanilla", name: "Vanilla", icon: "javascript", command: "npm create vite@latest . -- --template vanilla", options: VITE_OPTIONS },
      { id: "vanilla-ts", name: "Vanilla + TS", icon: "typescript", command: "npm create vite@latest . -- --template vanilla-ts", options: VITE_OPTIONS }
    ]
  },
  {
    id: "next",
    name: "Next.js",
    category: "Frontend",
    icon: "nextdotjs",
    requires: ["npx"],
    variants: [
      {
        id: "ts",
        name: "TypeScript",
        icon: "typescript",
        command:
          'npx create-next-app@latest . --typescript --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm',
        options: NEXT_OPTIONS
      },
      {
        id: "js",
        name: "JavaScript",
        icon: "javascript",
        command:
          'npx create-next-app@latest . --javascript --eslint --tailwind --app --src-dir --import-alias "@/*" --use-npm',
        options: NEXT_OPTIONS
      }
    ]
  },
  {
    id: "astro",
    name: "Astro",
    category: "Frontend",
    icon: "astro",
    requires: ["npm"],
    variants: [
      { id: "minimal", name: "Minimal", icon: "astro", command: "npm create astro@latest . -- --template minimal --yes", options: ASTRO_OPTIONS },
      { id: "blog", name: "Blog", icon: "astro", command: "npm create astro@latest . -- --template blog --yes", options: ASTRO_OPTIONS }
    ]
  },
  {
    id: "svelte",
    name: "SvelteKit",
    category: "Frontend",
    icon: "svelte",
    requires: ["npx"],
    variants: [
      { id: "ts", name: "TypeScript", icon: "typescript", command: "npx sv create . --template minimal --types ts --no-add-ons", options: SVELTEKIT_OPTIONS },
      { id: "js", name: "JavaScript", icon: "javascript", command: "npx sv create . --template minimal --no-types --no-add-ons", options: SVELTEKIT_OPTIONS }
    ]
  },
  {
    id: "node",
    name: "Node.js",
    category: "Backend",
    icon: "nodedotjs",
    requires: ["npm"],
    variants: [{ id: "default", name: "Default", icon: "nodedotjs", command: "npm init -y", options: NO_TEMPLATE_OPTIONS }]
  },
  {
    id: "python-uv",
    name: "Python (uv)",
    category: "Backend",
    icon: "python",
    requires: ["uv"],
    variants: [{ id: "default", name: "Default", icon: "python", command: "uv init .", options: NO_TEMPLATE_OPTIONS }]
  },
  {
    id: "cargo",
    name: "Rust",
    category: "Systems",
    icon: "rust",
    requires: ["cargo"],
    variants: [{ id: "default", name: "Default", icon: "rust", command: "cargo init .", options: NO_TEMPLATE_OPTIONS }]
  },
  {
    id: "go",
    name: "Go",
    category: "Systems",
    icon: "go",
    requires: ["go"],
    // `go mod init` needs a module path; a fixed literal keeps the command
    // assembled from catalog data only (no free-text interpolation).
    variants: [{ id: "default", name: "Default", icon: "go", command: "go mod init project", options: NO_TEMPLATE_OPTIONS }]
  }
];
