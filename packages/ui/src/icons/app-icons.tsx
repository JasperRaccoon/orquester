/**
 * The IDE, file-explorer and browser artwork of `registry-icons.tsx`: by far
 * its biggest SVGs, drawn only by menus and the tabs they open, so they load as
 * one chunk the first time one is drawn. Its ids are `LAZY_ICON_IDS`.
 */

import React from "react";

import type { LazyIconId } from "./registry-icons";

// IDEs - bare ids, matching daemon where possible; filename variants mapped to id
import Antigravity from "./ides/antigravity.svg?react";
import CLion from "./ides/clion.svg?react";
import Cursor from "./ides/cursor.svg?react";
import GoLand from "./ides/goland.svg?react";
import IntelliJ from "./ides/intellij-idea.svg?react";
import PhpStorm from "./ides/phpstorm.svg?react";
import PyCharm from "./ides/pycharm.svg?react";
import RustRover from "./ides/rustrover.svg?react";
import Sublime from "./ides/sublime.svg?react";
import VSCode from "./ides/vscode.svg?react";
import Windsurf from "./ides/windsurf.svg?react";
import Zed from "./ides/zed.svg?react";

// Explorers - only those with SVGs
import Dolphin from "./explorers/dolphin.svg?react";
import Explorer from "./explorers/explorer.svg?react";
import Thunar from "./explorers/thunar.svg?react";

// Browsers - only those with SVGs
import Brave from "./browsers/brave.svg?react";
import Chrome from "./browsers/chrome.svg?react";
import Chromium from "./browsers/chromium.svg?react";
import Edge from "./browsers/edge.svg?react";
import Firefox from "./browsers/firefox.svg?react";
import Vivaldi from "./browsers/vivaldi.svg?react";

const ICONS: Record<LazyIconId, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  // ides (bare ids from daemon + jetbrains from user SVGs)
  vscode: VSCode,
  cursor: Cursor,
  antigravity: Antigravity,
  windsurf: Windsurf,
  zed: Zed,
  intellij: IntelliJ,
  sublime: Sublime,
  clion: CLion,
  goland: GoLand,
  phpstorm: PhpStorm,
  pycharm: PyCharm,
  rustrover: RustRover,

  // explorers (only existing SVGs; system-files falls back or maps if present)
  dolphin: Dolphin,
  thunar: Thunar,
  explorer: Explorer,
  "system-files": Explorer,

  // browsers
  chrome: Chrome,
  chromium: Chromium,
  firefox: Firefox,
  brave: Brave,
  edge: Edge,
  vivaldi: Vivaldi
};

export function AppIcon({ refId, size }: { refId: LazyIconId; size: number | string }) {
  return React.createElement(ICONS[refId], { width: size, height: size });
}
