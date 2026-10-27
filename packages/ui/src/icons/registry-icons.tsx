import React from "react";
import {
  Bot,
  Code2,
  FolderOpen,
  Globe,
  TerminalSquare
} from "lucide-react";
import type { RegistryKind } from "../types";

// Agents - bare ids only, matching daemon + user SVGs
import Claude from "./agents/claude.svg?react";
import Codex from "./agents/codex.svg?react";
import DeepSeek from "./agents/deepseek.svg?react";
import Grok from "./agents/grok.svg?react";
import OpenCode from "./agents/opencode.svg?react";

// Shells - bare ids matching daemon where SVG exists
import Bash from "./shells/bash.svg?react";
import Fish from "./shells/fish.svg?react";
import NuShell from "./shells/nushell.svg?react";
import Pwsh from "./shells/pwsh.svg?react";
import Zsh from "./shells/zsh.svg?react";

// Lucide fallbacks for generics
const generic: Partial<Record<RegistryKind, React.ComponentType<React.SVGProps<SVGSVGElement> | { size?: number | string }>>> = {
  shell: TerminalSquare,
  agent: Bot,
  // A chat tab still names an agent through `refId`, so the specific icon
  // almost always wins; this only covers an entry with no artwork of its own.
  "agent-chat": Bot,
  ide: Code2,
  "file-explorer": FolderOpen,
  browser: Globe
};

const specific: Record<string, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  // agents (bare ids)
  claude: Claude,
  codex: Codex,
  deepseek: DeepSeek,
  grok: Grok,
  opencode: OpenCode,

  // shells (bare, matching daemon ids that have SVGs)
  bash: Bash,
  zsh: Zsh,
  fish: Fish,
  nu: NuShell,
  pwsh: Pwsh
};

/** The ids whose artwork is in `app-icons.tsx`, loaded with the first one drawn. */
const LAZY_ICON_IDS = [
  "vscode",
  "cursor",
  "antigravity",
  "windsurf",
  "zed",
  "intellij",
  "sublime",
  "clion",
  "goland",
  "phpstorm",
  "pycharm",
  "rustrover",
  "dolphin",
  "thunar",
  "explorer",
  "system-files",
  "chrome",
  "chromium",
  "firefox",
  "brave",
  "edge",
  "vivaldi"
] as const;

export type LazyIconId = (typeof LAZY_ICON_IDS)[number];

const lazyIconIds: ReadonlySet<string> = new Set(LAZY_ICON_IDS);

type AppIconProps = { refId: LazyIconId; size: number | string; fallback: React.ReactNode };

// A chunk that fails to load (offline, or gone after a deploy) leaves the
// generic icon in place rather than taking the menu or tab down with it.
const AppIcon = React.lazy(() =>
  import("./app-icons").then(
    (module): { default: React.ComponentType<AppIconProps> } => ({ default: module.AppIcon }),
    (): { default: React.ComponentType<AppIconProps> } => ({ default: ({ fallback }: AppIconProps) => <>{fallback}</> })
  )
);

export function getRegistryIcon(
  kind: RegistryKind,
  refId?: string,
  size: number | string = 14
): React.ReactNode {
  // Own keys only: a refId comes off the wire (a workflow's chain, a registry
  // entry), and `constructor` / `__proto__` must not resolve to Object's own.
  if (refId) {
    const Comp = Object.hasOwn(specific, refId) ? specific[refId] : undefined;
    if (Comp) {
      return React.createElement(Comp, { width: size, height: size });
    }
    if (lazyIconIds.has(refId)) {
      // The generic icon stands in while the artwork loads.
      const fallback = genericIcon(kind, size);
      return (
        <React.Suspense fallback={fallback}>
          <AppIcon refId={refId as LazyIconId} size={size} fallback={fallback} />
        </React.Suspense>
      );
    }
  }
  return genericIcon(kind, size);
}

function genericIcon(kind: RegistryKind, size: number | string): React.ReactNode {
  const Gen = Object.hasOwn(generic, kind) ? generic[kind] : undefined;
  if (Gen) {
    return React.createElement(Gen, { size });
  }
  return null;
}

export function RegistryIcon({
  kind,
  refId,
  size = 14
}: {
  kind: RegistryKind;
  refId?: string;
  size?: number | string;
}) {
  return <>{getRegistryIcon(kind, refId, size)}</>;
}
