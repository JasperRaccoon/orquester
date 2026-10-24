import { useEffect, useState } from "react";

/** Reactive CSS media query. `useMediaQuery("(min-width: 768px)")` → desktop. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );

  useEffect(() => {
    // A DOM without media queries (jsdom in tests) reads as a phone.
    if (typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    handler();
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** True on md+ (≥768px) viewports. */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px)");
}
