import { useEffect, useLayoutEffect } from "react";
import { applyTheme, resolveMode, watchMode } from "../lib/theme";
import { useAppStore } from "../store/app";

/**
 * Keeps the document in sync with the theme preference. "system" re-resolves
 * when the OS flips; "dynamic" is re-checked on a timer so the app follows the
 * time of day on its own. Mount once, at the app root.
 */
export function useTheme(): void {
  const scheme = useAppStore((s) => s.colorScheme);
  const themeMode = useAppStore((s) => s.themeMode);
  const mode = useAppStore((s) => s.resolvedMode);
  const setResolvedMode = useAppStore((s) => s.setResolvedMode);

  useEffect(() => {
    const sync = () => setResolvedMode(resolveMode(themeMode));
    sync();
    return watchMode(themeMode, sync);
  }, [themeMode, setResolvedMode]);

  // Layout, not passive: the attributes must land in the same frame React first
  // commits, or a non-default theme flashes the stock dark palette on every load.
  useLayoutEffect(() => applyTheme(scheme, mode), [scheme, mode]);
}
