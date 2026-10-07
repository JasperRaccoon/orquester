import React from "react";
import {
  Bot,
  Box,
  Code2,
  Container,
  Database,
  Globe,
  Hammer,
  KeyRound,
  Network,
  Settings2,
  SquareTerminal,
  type LucideIcon
} from "lucide-react";
import {
  siApache,
  siBun,
  siCaddy,
  siClickhouse,
  siCloudflare,
  siContainerd,
  siDeno,
  siDocker,
  siElectron,
  siEsbuild,
  siGit,
  siGo,
  siGooglegemini,
  siGrafana,
  siJest,
  siKubernetes,
  siMariadb,
  siMeilisearch,
  siMinio,
  siMongodb,
  siMysql,
  siNeovim,
  siNextdotjs,
  siNginx,
  siNodedotjs,
  siNodemon,
  siNpm,
  siOllama,
  siOpenjdk,
  siPhp,
  siPm2,
  siPnpm,
  siPostgresql,
  siPrometheus,
  siPython,
  siRedis,
  siRuby,
  siRust,
  siSnapcraft,
  siSqlite,
  siTailscale,
  siTmux,
  siTraefikproxy,
  siTurborepo,
  siTypescript,
  siVim,
  siVite,
  siVitest,
  siVscodium,
  siWebpack,
  siXdotorg,
  siYarn,
  type SimpleIcon
} from "simple-icons";
import type { SystemProcessInfo } from "@orquester/api";
import { RegistryIcon } from "../../icons";
import { cn } from "../../lib/cn";
import type { RegistryKind } from "../../types";
import { ROLE_ICON } from "./OrquesterCore";
import {
  isDarkBrandColor,
  processIconKind,
  type AppIconId,
  type BrandSlug,
  type IconCategory
} from "./process-icons";

/** Which registry family each app icon belongs to (only matters if its artwork were missing). */
const APP_KIND: Record<AppIconId, RegistryKind> = {
  claude: "agent",
  codex: "agent",
  deepseek: "agent",
  grok: "agent",
  opencode: "agent",
  vscode: "ide",
  cursor: "ide",
  windsurf: "ide",
  zed: "ide",
  antigravity: "ide",
  intellij: "ide",
  sublime: "ide",
  clion: "ide",
  goland: "ide",
  phpstorm: "ide",
  pycharm: "ide",
  rustrover: "ide",
  chrome: "browser",
  chromium: "browser",
  firefox: "browser",
  brave: "browser",
  edge: "browser",
  vivaldi: "browser",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  nu: "shell",
  pwsh: "shell",
  dolphin: "file-explorer",
  thunar: "file-explorer"
};

/** Named imports only: simple-icons ships thousands of logos and tree-shakes to these. */
const BRANDS: Record<BrandSlug, SimpleIcon> = {
  apache: siApache,
  bun: siBun,
  caddy: siCaddy,
  clickhouse: siClickhouse,
  cloudflare: siCloudflare,
  containerd: siContainerd,
  deno: siDeno,
  docker: siDocker,
  electron: siElectron,
  esbuild: siEsbuild,
  git: siGit,
  go: siGo,
  googlegemini: siGooglegemini,
  grafana: siGrafana,
  jest: siJest,
  kubernetes: siKubernetes,
  mariadb: siMariadb,
  meilisearch: siMeilisearch,
  minio: siMinio,
  mongodb: siMongodb,
  mysql: siMysql,
  neovim: siNeovim,
  nextdotjs: siNextdotjs,
  nginx: siNginx,
  nodedotjs: siNodedotjs,
  nodemon: siNodemon,
  npm: siNpm,
  ollama: siOllama,
  openjdk: siOpenjdk,
  php: siPhp,
  pm2: siPm2,
  pnpm: siPnpm,
  postgresql: siPostgresql,
  prometheus: siPrometheus,
  python: siPython,
  redis: siRedis,
  ruby: siRuby,
  rust: siRust,
  snapcraft: siSnapcraft,
  sqlite: siSqlite,
  tailscale: siTailscale,
  tmux: siTmux,
  traefikproxy: siTraefikproxy,
  turborepo: siTurborepo,
  typescript: siTypescript,
  vim: siVim,
  vite: siVite,
  vitest: siVitest,
  vscodium: siVscodium,
  webpack: siWebpack,
  xdotorg: siXdotorg,
  yarn: siYarn,
};

const CATEGORIES: Record<IconCategory, LucideIcon> = {
  agent: Bot,
  browser: Globe,
  build: Hammer,
  container: Container,
  database: Database,
  editor: Code2,
  key: KeyRound,
  network: Network,
  shell: SquareTerminal,
  system: Settings2,
  generic: Box
};

/**
 * A process row's icon: Orquester's own infrastructure keeps its role icon
 * (the highlight must not depend on a logo); an agent, IDE, browser or shell
 * the app already has artwork for uses that, so a Codex process looks like the
 * Codex tab; another known product shows its brand logo in its brand colour —
 * the text colour when that is too dark to read — and anything else a generic
 * category glyph.
 */
export const ProcessIcon: React.FC<{ proc: SystemProcessInfo; size?: number }> = ({ proc, size = 14 }) => {
  if (proc.role) {
    const Icon = ROLE_ICON[proc.role];
    return <Icon size={size} className="shrink-0 text-info" />;
  }
  const kind = processIconKind(proc);
  if ("app" in kind) {
    // The text colour is for monochrome artwork drawn in `currentColor` (Grok).
    return (
      <span className="inline-flex shrink-0 text-neutral-200">
        <RegistryIcon kind={APP_KIND[kind.app]} refId={kind.app} size={size} />
      </span>
    );
  }
  if ("brand" in kind) {
    const icon = BRANDS[kind.brand];
    const dark = isDarkBrandColor(icon.hex);
    return (
      <svg
        role="img"
        aria-label={icon.title}
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill={dark ? "currentColor" : `#${icon.hex}`}
        className={cn("shrink-0", dark && "text-neutral-300")}
      >
        <title>{icon.title}</title>
        <path d={icon.path} />
      </svg>
    );
  }
  const Icon = CATEGORIES[kind.category];
  return (
    <Icon
      size={size}
      aria-hidden
      className={cn("shrink-0", kind.category === "generic" ? "text-neutral-600" : "text-neutral-400")}
    />
  );
};
