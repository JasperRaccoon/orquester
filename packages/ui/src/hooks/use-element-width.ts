import { useCallback, useEffect, useRef, useState } from "react";

/**
 * What an element's own width (CSS px, its border box) comes to, following it
 * through every resize (`ResizeObserver`) — for a layout keyed on a PANEL's
 * width rather than the viewport's (the right-rail dock spans 260–560 px on
 * any desktop screen).
 *
 * `select` maps the width to what the caller lays out by (a breakpoint's
 * name, say): the component re-renders only when THAT changes, never on every
 * pixel of a resize drag. Without it the width itself is returned.
 *
 * Returns a callback ref to put on the element and the selected value: `null`
 * until it has been measured (the first render, a static render, an engine
 * without `ResizeObserver`), so a caller picks its own default for that.
 * `select` should be a stable function (a module-level one).
 */
export function useElementWidth<T extends HTMLElement, V = number>(
  select?: (width: number) => V
): [(node: T | null) => void, V | null] {
  const [value, setValue] = useState<V | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const selectRef = useRef(select);
  selectRef.current = select;

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    const measure = () => {
      const width = Math.round(node.getBoundingClientRect().width);
      const next = (selectRef.current ? selectRef.current(width) : width) as V;
      // An unchanged value is the same state: React skips the re-render.
      setValue(() => next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    []
  );

  return [ref, value];
}
