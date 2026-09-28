import { useCallback, useEffect, useRef, useState } from "react";

/**
 * An element's own width in CSS px, following it through every resize
 * (`ResizeObserver`) — for a layout keyed on a PANEL's width rather than the
 * viewport's (the right-rail dock spans 260–560 px on any desktop screen).
 *
 * Returns a callback ref to put on the element and its width: `null` until it
 * has been measured (the first render, a static render, an engine without
 * `ResizeObserver`), so a caller picks its own default for that.
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number | null] {
  const [width, setWidth] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null) return;
    const measure = (value: number) => {
      const rounded = Math.round(value);
      setWidth((current) => (current === rounded ? current : rounded));
    };
    measure(node.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    // The border box, like the first measure: padding counts as width here.
    observer.current = new ResizeObserver(() => measure(node.getBoundingClientRect().width));
    observer.current.observe(node);
  }, []);

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    []
  );

  return [ref, width];
}
