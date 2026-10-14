/**
 * The live theme handed to agent-published pages (spec 2026-10-14 §2.3).
 *
 * Ported from T3 Code (MIT): `apps/web/src/hooks/useHtmlRenderTheme.ts`,
 * reading Orquester's scheme × mode instead of T3's palettes.
 */

import { useEffect, useState } from "react";

import type { HtmlRenderTheme } from "@orquester/api/agent-chat";

import { htmlRenderThemeTokens } from "../../../lib/theme";
import { useAppStore } from "../../../store/app";

/**
 * The page tokens for the theme on screen. Read off the document root, so it
 * is exactly what `applyTheme` painted: in a passive effect, which runs after
 * the root's layout effect has stamped a new scheme or mode — a value read
 * while rendering would be the previous theme's.
 */
export function useVisualTheme(): HtmlRenderTheme {
  const scheme = useAppStore((state) => state.colorScheme);
  const mode = useAppStore((state) => state.resolvedMode);
  const [theme, setTheme] = useState<HtmlRenderTheme>(() => htmlRenderThemeTokens(mode));
  useEffect(() => {
    setTheme((current) => {
      const next = htmlRenderThemeTokens(mode);
      return sameTheme(current, next) ? current : next;
    });
  }, [scheme, mode]);
  return theme;
}

function sameTheme(left: HtmlRenderTheme, right: HtmlRenderTheme): boolean {
  if (left.appearance !== right.appearance) return false;
  const keys = Object.keys(left.variables);
  return (
    keys.length === Object.keys(right.variables).length &&
    keys.every((key) => left.variables[key] === right.variables[key])
  );
}
