import { useEffect, useLayoutEffect } from "react";

/**
 * A layout effect in the browser — focus and caret moves land in the commit,
 * before paint and before the dock's safety net looks — and a plain effect
 * where there is no layout: the static render checks, where React warns about
 * `useLayoutEffect` and would run neither.
 */
export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
