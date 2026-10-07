/**
 * Which icon a process row shows, best first: the app's own artwork for the
 * agents, IDEs, browsers and shells it already draws elsewhere (the registry
 * icons of the new-tab menu), else a brand logo (simple-icons slug), else a
 * generic category. Pure — no React, no icon data — so `process-icons.check.ts`
 * can assert it with plain `node --import tsx`; `ProcessIcon.tsx` maps the
 * answer to artwork.
 */

/** Registry icon ids (`icons/registry-icons.tsx`) a process can be drawn with. */
export type AppIconId =
  | "claude"
  | "codex"
  | "deepseek"
  | "grok"
  | "opencode"
  | "vscode"
  | "cursor"
  | "windsurf"
  | "zed"
  | "antigravity"
  | "intellij"
  | "sublime"
  | "clion"
  | "goland"
  | "phpstorm"
  | "pycharm"
  | "rustrover"
  | "chrome"
  | "chromium"
  | "firefox"
  | "brave"
  | "edge"
  | "vivaldi"
  | "bash"
  | "zsh"
  | "fish"
  | "nu"
  | "pwsh"
  | "dolphin"
  | "thunar";

/** simple-icons slugs this table can name; `ProcessIcon.tsx` maps each to its artwork. */
export type BrandSlug =
  | "apache"
  | "bun"
  | "caddy"
  | "clickhouse"
  | "cloudflare"
  | "containerd"
  | "deno"
  | "docker"
  | "electron"
  | "esbuild"
  | "git"
  | "go"
  | "googlegemini"
  | "grafana"
  | "jest"
  | "kubernetes"
  | "mariadb"
  | "meilisearch"
  | "minio"
  | "mongodb"
  | "mysql"
  | "neovim"
  | "nextdotjs"
  | "nginx"
  | "nodedotjs"
  | "nodemon"
  | "npm"
  | "ollama"
  | "openjdk"
  | "php"
  | "pm2"
  | "pnpm"
  | "postgresql"
  | "prometheus"
  | "python"
  | "redis"
  | "ruby"
  | "rust"
  | "snapcraft"
  | "sqlite"
  | "tailscale"
  | "tmux"
  | "traefikproxy"
  | "turborepo"
  | "typescript"
  | "vim"
  | "vite"
  | "vitest"
  | "vscodium"
  | "webpack"
  | "xdotorg"
  | "yarn";

/** Generic kinds for processes no brand covers. */
export type IconCategory =
  | "agent"
  | "browser"
  | "build"
  | "container"
  | "database"
  | "editor"
  | "key"
  | "network"
  | "shell"
  | "system"
  | "generic";

export type ProcessIconKind = { app: AppIconId } | { brand: BrandSlug } | { category: IconCategory };

/**
 * Agents and other apps that run on a runtime (an npm-installed CLI is `node
 * …/bin/codex.js`): recognised by their command line, ahead of the tool brands.
 */
const COMMAND_APPS: ReadonlyArray<readonly [RegExp, AppIconId]> = [
  [/claude-code|\/claude(\s|$)|\bclaude\.js\b/, "claude"],
  [/@openai\/codex|\/codex(\.js)?(\s|$)/, "codex"],
  [/@xai-official\/grok|\/grok(\.js)?(\s|$)/, "grok"],
  [/opencode-ai|\/opencode(\.js)?(\s|$)/, "opencode"],
  [/\/deepseek(\.js)?(\s|$)/, "deepseek"]
];

/** Process (comm) names drawn with the app's own artwork. */
const NAME_APPS: ReadonlyArray<readonly [RegExp, AppIconId]> = [
  [/^claude$/, "claude"],
  [/^codex/, "codex"],
  [/^grok$/, "grok"],
  [/^opencode$/, "opencode"],
  [/^deepseek$/, "deepseek"],
  [/^(code|code-insiders|code-server)$/, "vscode"],
  [/^cursor$/, "cursor"],
  [/^windsurf$/, "windsurf"],
  [/^(zed|zed-editor)$/, "zed"],
  [/^antigravity$/, "antigravity"],
  [/^idea$/, "intellij"],
  [/^sublime_text$/, "sublime"],
  [/^clion$/, "clion"],
  [/^goland$/, "goland"],
  [/^phpstorm$/, "phpstorm"],
  [/^pycharm$/, "pycharm"],
  [/^rustrover$/, "rustrover"],
  [/^chrome/, "chrome"],
  [/^chromium/, "chromium"],
  [/^firefox/, "firefox"],
  [/^brave/, "brave"],
  [/^msedge/, "edge"],
  [/^vivaldi/, "vivaldi"],
  [/^bash$/, "bash"],
  [/^zsh$/, "zsh"],
  [/^fish$/, "fish"],
  [/^nu$/, "nu"],
  [/^pwsh$/, "pwsh"],
  [/^dolphin$/, "dolphin"],
  [/^thunar$/, "thunar"]
];

/**
 * Tools that run on a runtime (node, bun, python…) and so share its process
 * name: recognised by their command line. Ordered — the first match wins, so
 * the more specific pattern of two that can both match comes first (vitest
 * before vite, claude before a generic node script).
 */
const COMMAND_BRANDS: ReadonlyArray<readonly [RegExp, BrandSlug]> = [
  [/\bvitest\b/, "vitest"],
  [/[/\s]vite(\/|\.js|\.mjs|\s|$)/, "vite"],
  [/\bnext(-server|\/dist|\s+(dev|start|build))\b/, "nextdotjs"],
  [/\besbuild\b/, "esbuild"],
  [/\bjest\b/, "jest"],
  [/\bwebpack\b/, "webpack"],
  [/\bturbo(repo)?\b/, "turborepo"],
  [/\bpm2\b/, "pm2"],
  [/\bnodemon\b/, "nodemon"],
  [/\belectron\b/, "electron"],
  [/\bgemini\b/, "googlegemini"],
  [/\bpnpm\b/, "pnpm"],
  [/\byarn\b/, "yarn"],
  [/npm-cli|[/\s]npm(\s|$)/, "npm"],
  [/[/\s]tsx(\/|\s|$)|\bts-node\b/, "typescript"]
];

/** Runtimes whose own logo is the fallback when no tool on them is recognised. */
const RUNTIME_BRANDS: ReadonlyArray<readonly [RegExp, BrandSlug]> = [
  [/^node(js)?$/, "nodedotjs"],
  [/^bun$/, "bun"],
  [/^deno$/, "deno"],
  [/^python[\d.]*$/, "python"]
];

/** Process (comm) names of known products. Comm names are truncated to 15 chars by Linux. */
const NAME_BRANDS: ReadonlyArray<readonly [RegExp, BrandSlug]> = [
  [/^ruby[\d.]*$|^puma|^unicorn/, "ruby"],
  [/^java$/, "openjdk"],
  [/^(go|gopls)$/, "go"],
  [/^(cargo|rustc|rust-analyzer)$/, "rust"],
  [/^php(-fpm)?[\d.]*$/, "php"],
  [/^nginx$/, "nginx"],
  [/^caddy$/, "caddy"],
  [/^(apache2|httpd)$/, "apache"],
  [/^postgres$|^postmaster$/, "postgresql"],
  [/^mysqld$/, "mysql"],
  [/^mariadbd?$/, "mariadb"],
  [/^redis(-server)?$/, "redis"],
  [/^mongod$/, "mongodb"],
  [/^(dockerd|docker|docker-proxy|com\.docker)/, "docker"],
  [/^containerd$/, "containerd"],
  [/^codium$/, "vscodium"],
  [/^git(-|$)/, "git"],
  [/^gemini$/, "googlegemini"],
  [/^nvim$/, "neovim"],
  [/^vim?$/, "vim"],
  [/^kube(let|ctl|-)/, "kubernetes"],
  [/^prometheus$/, "prometheus"],
  [/^grafana/, "grafana"],
  [/^ollama/, "ollama"],
  [/^tmux/, "tmux"],
  [/^tailscaled?$/, "tailscale"],
  [/^cloudflared$/, "cloudflare"],
  [/^pnpm$/, "pnpm"],
  [/^npm$/, "npm"],
  [/^yarn$/, "yarn"],
  [/^esbuild$/, "esbuild"],
  [/^electron$/, "electron"],
  [/^(Xvfb|Xorg|Xwayland)$/, "xdotorg"],
  [/^sqlite3?$/, "sqlite"],
  [/^clickhouse/, "clickhouse"],
  [/^meilisearch$/, "meilisearch"],
  [/^minio$/, "minio"],
  [/^traefik$/, "traefikproxy"],
  [/^snapd$/, "snapcraft"]
];

const NAME_CATEGORIES: ReadonlyArray<readonly [RegExp, IconCategory]> = [
  [/^(aider|goose|amp|cline)$/, "agent"],
  [/^(sh|dash|ksh|mksh|csh|tcsh|login)$/, "shell"],
  [/^(nano|emacs|helix|hx|micro|kate|gedit)$/, "editor"],
  [/^(sshd?|ssh-agent|sftp-server|gpg-agent)$/, "key"],
  [/^(headless_shell|epiphany|webkit)/, "browser"],
  [/^(runc|containerd-shim|podman|buildkitd|conmon|crun)/, "container"],
  [/^(make|gcc|g\+\+|cc1|cc1plus|clang|ld|cmake|ninja|rustup)$/, "build"],
  [/^(influxd|etcd|couchdb|memcached|valkey)/, "database"],
  [/^(dhclient|NetworkManager|wpa_supplicant|openvpn|wg-quick|haproxy|dnsmasq)/, "network"],
  [
    /^(systemd|init$|dbus|cron|rsyslogd|journald|udevd|polkitd|agetty|udisksd|accounts-daemon|irqbalance|multipathd|unattended|packagekitd|atd$|chronyd|ntpd|auditd|fwupd)/,
    "system"
  ]
];

/** The icon for a process, from its comm name and command line. */
export function processIconKind(proc: { name: string; cmdline: string }): ProcessIconKind {
  const name = proc.name.trim();
  const lower = name.toLowerCase();
  const runtime = RUNTIME_BRANDS.find(([pattern]) => pattern.test(lower));
  // A tool on a runtime is the tool, not the runtime: `node …/vite.js` is Vite,
  // `node …/@openai/codex/bin/codex.js` is Codex. Only runtimes are looked
  // through — a native binary's own name is the truth.
  if (runtime) {
    const app = COMMAND_APPS.find(([pattern]) => pattern.test(proc.cmdline));
    if (app) return { app: app[1] };
    const tool = COMMAND_BRANDS.find(([pattern]) => pattern.test(proc.cmdline));
    return { brand: tool ? tool[1] : runtime[1] };
  }
  const app = NAME_APPS.find(([pattern]) => pattern.test(lower));
  if (app) return { app: app[1] };
  const brand = NAME_BRANDS.find(([pattern]) => pattern.test(name) || pattern.test(lower));
  if (brand) return { brand: brand[1] };
  const category = NAME_CATEGORIES.find(([pattern]) => pattern.test(name));
  return { category: category ? category[1] : "generic" };
}

/**
 * True when a brand colour is too dark to read on a dark surface (Bun, Deno,
 * Rust, Next.js… are black): the icon then takes the text colour instead.
 * Relative luminance per WCAG 2.x.
 */
export function isDarkBrandColor(hex: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return true;
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  return luminance < 0.1;
}
