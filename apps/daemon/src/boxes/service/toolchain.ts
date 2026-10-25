/**
 * The `toolchain` setup step's plan (spec §8.2.6): a devcontainer when the repo has one and Docker
 * works in the box; otherwise mise for the version files it finds, corepack for `packageManager`,
 * then each lockfile's install command. Pure: the step reads the files and runs the commands.
 * Every command is a POSIX shell script run in the project directory; Windows boxes get no plan.
 */

import { shQuote } from "./box-exec.ts";

/** Files the planner looks at, relative to the project root. */
export const TOOLCHAIN_PROBE_FILES = [
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".java-version",
  "go.mod",
  "rust-toolchain.toml",
  "rust-toolchain",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "Cargo.toml",
  "Cargo.lock"
] as const;

export type ToolchainProbeFile = (typeof TOOLCHAIN_PROBE_FILES)[number];

/** Small files whose content the planner reads (the rest only need to exist). */
export const TOOLCHAIN_READ_FILES: readonly ToolchainProbeFile[] = [
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
  ".java-version",
  "go.mod",
  "rust-toolchain.toml",
  "rust-toolchain",
  "package.json"
];

export interface ToolchainCommand {
  label: string;
  script: string;
}

export interface ToolchainPlan {
  mode: "devcontainer" | "native" | "none" | "unsupported";
  commands: ToolchainCommand[];
  /** Log lines about what was found or ignored. */
  notes: string[];
}

export interface ToolchainInput {
  os: "linux" | "darwin" | "win32";
  docker: boolean;
  projectDir: string;
  /** Probe files that exist. */
  present: ReadonlySet<string>;
  /** Content of the present files in {@link TOOLCHAIN_READ_FILES}. */
  contents: Readonly<Record<string, string>>;
}

/** Where mise puts itself and its shims; prepended to PATH in every command. */
const PATH_PREAMBLE = 'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH" MISE_YES=1';
const ENSURE_MISE = "command -v mise >/dev/null 2>&1 || curl -fsSL https://mise.run | sh";
const SHIMS_MARKER = "# orquester: mise shims";
const SHIMS_LINE = `export PATH="$HOME/.local/share/mise/shims:$PATH" ${SHIMS_MARKER}`;
const NPM_GLOBAL_MARKER = "# orquester: npm global bin";
/** Where the box's agent CLI installs put npm's global packages (`ensureBoxAgentCli`). */
const NPM_GLOBAL_LINE = `export PATH="$HOME/.npm-global/bin:$PATH" ${NPM_GLOBAL_MARKER}`;

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

function script(...lines: string[]): string {
  return [PATH_PREAMBLE, ...lines].join("\n");
}

/** Append `line` to the login and interactive shell profiles that lack its marker: terminals opened later get it. */
function persistLine(marker: string, line: string): string[] {
  return ["~/.profile", "~/.bashrc", "~/.zshrc"].map((file) => `grep -qF ${shQuote(marker)} ${file} 2>/dev/null || printf '%s\\n' ${shQuote(line)} >> ${file}`);
}

/** `command -v <bin>` or install `<tool>` through mise. */
function ensureTool(bin: string, tool: string): string {
  return `command -v ${bin} >/dev/null 2>&1 || { ${ENSURE_MISE}; mise use -g ${tool}; }`;
}

function firstToken(text: string | undefined): string | null {
  if (text === undefined) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line.length > 0) return line.split(/\s+/)[0] ?? null;
  }
  return null;
}

function nodeVersion(text: string | undefined): string | null {
  const token = firstToken(text);
  if (token === null) return null;
  if (/^lts/i.test(token)) return "lts";
  if (token === "node" || token === "stable" || token === "latest") return "latest";
  return token.replace(/^v/i, "");
}

function goVersion(text: string | undefined): string | null {
  if (text === undefined) return null;
  const toolchain = /^toolchain\s+go(\S+)/m.exec(text)?.[1];
  if (toolchain) return toolchain;
  return /^go\s+(\d+(?:\.\d+){0,2})\s*$/m.exec(text)?.[1] ?? null;
}

function rustVersion(toml: string | undefined, plain: string | undefined): string | null {
  if (toml !== undefined) return /^\s*channel\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  return firstToken(plain);
}

function packageManagerOf(text: string | undefined): string | null {
  if (text === undefined) return null;
  try {
    const value = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Install bubblewrap (Codex's Linux sandbox) where it is missing: as root or through passwordless
 * sudo, with whichever package manager the box has. Exits 0 when it cannot (no root, no package
 * manager — a container): the caller treats a failure as a note, never a failed step.
 */
export function bubblewrapScript(): string {
  return [
    "command -v bwrap >/dev/null 2>&1 && { echo 'bubblewrap is installed.'; exit 0; }",
    'SUDO=""',
    'if [ "$(id -u)" != 0 ]; then',
    "  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO='sudo -n'; else echo 'No root access: skipped bubblewrap.'; exit 0; fi",
    "fi",
    "if command -v apt-get >/dev/null 2>&1; then",
    "  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap || { $SUDO apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q bubblewrap; }",
    "elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q bubblewrap",
    "elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y -q bubblewrap",
    "elif command -v apk >/dev/null 2>&1; then $SUDO apk add --no-cache bubblewrap",
    "elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install bubblewrap",
    "elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -S --noconfirm --needed bubblewrap",
    "else echo 'No package manager: skipped bubblewrap.'; fi"
  ].join("\n");
}

/** The swap a box gets: as much as its memory, from 1 to 8 GiB. */
export function boxSwapGiB(memBytes: number): number {
  return Math.min(8, Math.max(1, Math.round(memBytes / 1024 ** 3)));
}

/**
 * Swap for a box that has none: cloud images ship without, so a test run that exhausts memory
 * meets the OOM killer at once. `sizeGiB` of swap at `path` (listed in `fstab` so it survives a
 * reboot), as root or through passwordless sudo, and only when the disk has three times that
 * free. Exits 0 when it skips (swap already on, no root, too little disk); 1 when it failed.
 */
export function swapScript(sizeGiB: number, path = "/swapfile", fstab = "/etc/fstab"): string {
  const size = Math.max(1, Math.floor(sizeGiB));
  return [
    "[ -n \"$(swapon --noheadings 2>/dev/null)\" ] && { echo 'Swap is already on.'; exit 0; }",
    'SUDO=""',
    'if [ "$(id -u)" != 0 ]; then',
    "  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO='sudo -n'; else echo 'No root access: skipped adding swap.'; exit 0; fi",
    "fi",
    `avail=$(df -Pk "$(dirname '${path}')" | awk 'NR==2{print $4}')`,
    `[ "\${avail:-0}" -ge ${size * 3 * 1024 * 1024} ] || { echo 'Less than ${size * 3} GiB free on disk: skipped adding swap.'; exit 0; }`,
    `$SUDO fallocate -l ${size}G '${path}' && $SUDO chmod 600 '${path}' && $SUDO mkswap '${path}' >/dev/null && $SUDO swapon '${path}' || { echo 'Adding swap failed.'; $SUDO rm -f '${path}'; exit 1; }`,
    `grep -q '^${path} ' '${fstab}' 2>/dev/null || echo '${path} none swap sw 0 0' | $SUDO tee -a '${fstab}' >/dev/null`,
    `echo 'Added ${size} GiB of swap.'`
  ].join("\n");
}

/**
 * Install Node.js LTS through mise where `node` or `npm` is missing, whatever the repo uses: the
 * npm-installed agent CLIs (Codex, Grok, OpenCode) and the `npx` MCP servers synced into the box
 * need it. Puts mise's shims and npm's global bin dir on the PATH of terminals opened later.
 */
export function nodeScript(): string {
  return script(
    "command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && { echo 'Node.js is installed.'; exit 0; }",
    "echo 'Installing Node.js LTS with mise.'",
    ENSURE_MISE,
    "mise use -g node@lts",
    ...persistLine(SHIMS_MARKER, SHIMS_LINE),
    ...persistLine(NPM_GLOBAL_MARKER, NPM_GLOBAL_LINE),
    "command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1"
  );
}

/**
 * Install git and an SSH client (box clones go over SSH, spec §7) where either is missing: as root
 * or through passwordless sudo, with whichever package manager the box has (minimal images such as
 * Debian 12 ship neither). Exits 0 once both are on PATH, 1 when they are missing and cannot be
 * installed (the message says why).
 */
export function gitClientScript(): string {
  return [
    "command -v git >/dev/null 2>&1 && command -v ssh >/dev/null 2>&1 && exit 0",
    'SUDO=""',
    'if [ "$(id -u)" != 0 ]; then',
    "  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then SUDO='sudo -n'; else echo 'git or ssh is missing and there is no root access to install them.'; exit 1; fi",
    "fi",
    "echo 'Installing git and the SSH client.'",
    "if command -v apt-get >/dev/null 2>&1; then",
    "  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends git openssh-client || { $SUDO apt-get update -q && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends git openssh-client; }",
    "elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y -q git openssh-clients",
    "elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y -q git openssh-clients",
    "elif command -v apk >/dev/null 2>&1; then $SUDO apk add --no-cache git openssh-client",
    "elif command -v zypper >/dev/null 2>&1; then $SUDO zypper --non-interactive install git openssh-clients",
    "elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -S --noconfirm --needed git openssh",
    "else echo 'git or ssh is missing and the box has no known package manager.'; exit 1; fi",
    "command -v git >/dev/null 2>&1 && command -v ssh >/dev/null 2>&1 && exit 0",
    "echo 'Installing git and the SSH client failed.'",
    "exit 1"
  ].join("\n");
}

export function planToolchain(input: ToolchainInput): ToolchainPlan {
  const { present, contents } = input;
  const has = (file: ToolchainProbeFile) => present.has(file);
  const notes: string[] = [];
  if (input.os === "win32") {
    return { mode: "unsupported", commands: [], notes: ["Automatic toolchain setup is not available on Windows boxes."] };
  }

  const devcontainer = has(".devcontainer/devcontainer.json") || has(".devcontainer.json");
  if (devcontainer && input.docker) {
    return {
      mode: "devcontainer",
      commands: [
        {
          label: "devcontainer up",
          script: script(ensureTool("npx", "node@lts"), `npx -y @devcontainers/cli up --workspace-folder ${shQuote(input.projectDir)}`)
        }
      ],
      notes: ["Found a devcontainer and a working Docker: using the devcontainer."]
    };
  }
  if (devcontainer) notes.push("Found a devcontainer, but Docker does not work in this box: installing natively.");

  const commands: ToolchainCommand[] = [];
  // Tools mise installs globally in the box (a repo's own mise config is installed in place).
  const tools: string[] = [];
  const addTool = (tool: string, version: string | null, file: string) => {
    if (version === null) return;
    if (!VERSION_PATTERN.test(version)) {
      notes.push(`Ignored the version in ${file}: it is not a plain version.`);
      return;
    }
    tools.push(`${tool}@${version}`);
  };
  addTool("node", nodeVersion(contents[".nvmrc"] ?? contents[".node-version"]), has(".nvmrc") ? ".nvmrc" : ".node-version");
  addTool("python", firstToken(contents[".python-version"]), ".python-version");
  addTool("ruby", firstToken(contents[".ruby-version"])?.replace(/^ruby-/, "") ?? null, ".ruby-version");
  addTool("java", firstToken(contents[".java-version"]), ".java-version");
  addTool("go", goVersion(contents["go.mod"]), "go.mod");
  addTool("rust", rustVersion(contents["rust-toolchain.toml"], contents["rust-toolchain"]), "rust-toolchain");
  const miseConfig = has("mise.toml") || has(".mise.toml") || has(".tool-versions");

  if (miseConfig || tools.length > 0) {
    commands.push({
      label: "install mise",
      script: script(
        ENSURE_MISE,
        // Terminals opened later find the tools too.
        ...persistLine(SHIMS_MARKER, SHIMS_LINE)
      )
    });
  }
  if (miseConfig) {
    commands.push({ label: "mise install", script: script("mise trust", "mise install") });
  }
  if (tools.length > 0) {
    commands.push({ label: `mise use -g ${tools.join(" ")}`, script: script(`mise use -g ${tools.join(" ")}`) });
  }

  if (packageManagerOf(contents["package.json"]) !== null || has("pnpm-lock.yaml") || has("yarn.lock")) {
    commands.push({ label: "corepack enable", script: script(ensureTool("node", "node@lts"), "corepack enable") });
  }
  if (has("pnpm-lock.yaml")) {
    commands.push({ label: "pnpm install --frozen-lockfile", script: script("pnpm install --frozen-lockfile") });
  } else if (has("yarn.lock")) {
    commands.push({ label: "yarn install", script: script("yarn install") });
  } else if (has("bun.lock") || has("bun.lockb")) {
    commands.push({ label: "bun install --frozen-lockfile", script: script(ensureTool("bun", "bun@latest"), "bun install --frozen-lockfile") });
  } else if (has("package-lock.json")) {
    commands.push({ label: "npm ci", script: script(ensureTool("npm", "node@lts"), "npm ci") });
  } else if (has("package.json")) {
    notes.push("package.json has no lockfile: skipped the JavaScript install.");
  }

  if (has("uv.lock")) {
    commands.push({ label: "uv sync --frozen", script: script(ensureTool("uv", "uv@latest"), "uv sync --frozen") });
  } else if (has("poetry.lock")) {
    commands.push({ label: "poetry install", script: script(ensureTool("poetry", "poetry@latest"), "poetry install --no-interaction") });
  } else if (has("requirements.txt")) {
    commands.push({
      label: "pip install -r requirements.txt",
      script: script(ensureTool("python3", "python@3"), "python3 -m venv .venv", ".venv/bin/pip install -r requirements.txt")
    });
  }

  if (has("Cargo.toml") || has("Cargo.lock")) {
    commands.push({ label: "cargo fetch", script: script(ensureTool("cargo", "rust@stable"), "cargo fetch") });
  }
  if (has("go.mod")) {
    commands.push({ label: "go mod download", script: script(ensureTool("go", "go@latest"), "go mod download") });
  }

  return { mode: commands.length > 0 ? "native" : "none", commands, notes };
}
