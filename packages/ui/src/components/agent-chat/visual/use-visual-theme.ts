/**
 * The live theme handed to agent-published pages (spec 2026-10-14 §2.3).
 *
 * Ported from T3 Code (MIT): `apps/web/src/hooks/useHtmlRenderTheme.ts`,
 * reading Orquester's scheme × mode instead of T3's palettes.
 */

import { useEffect, useState, type RefObject } from "react";

import type { HtmlRenderTheme } from "@orquester/api/agent-chat";

import { htmlRenderThemeTokens } from "../../../lib/theme";
import { useChatHost } from "../chat-host";

/**
 * The page tokens for the theme on screen where the page shows: read off the
 * themed element `anchor` sits in (`htmlRenderThemeTokens`; the document root
 * when there is no anchor, or before it is mounted), so it is exactly what
 * was painted there. Re-read in a passive effect, which runs after the app
 * root's layout effect has stamped a new scheme or mode — a value read while
 * rendering would be the previous theme's — and after the anchor mounted.
 */
export function useVisualTheme(anchor?: RefObject<Element | null>): HtmlRenderTheme {
  const { scheme, mode } = useChatHost().useAppearance();
  const [theme, setTheme] = useState<HtmlRenderTheme>(() => htmlRenderThemeTokens(mode, anchor?.current));
  useEffect(() => {
    setTheme((current) => {
      const next = htmlRenderThemeTokens(mode, anchor?.current);
      return sameTheme(current, next) ? current : next;
    });
  }, [anchor, scheme, mode]);
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
