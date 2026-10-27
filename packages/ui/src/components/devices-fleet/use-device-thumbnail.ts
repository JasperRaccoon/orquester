/**
 * A fleet card's thumbnail as React state: a {@link ThumbnailPoller} fed by an
 * IntersectionObserver on the card (on screen or not) and the document's visibility.
 */

import { useEffect, useRef, useState } from "react";

import { OFF_SNAPSHOT, ThumbnailPoller, defaultThumbnailDeps, type ThumbnailDeps, type ThumbnailSnapshot } from "./thumbnail-poller";

/** Margin around the viewport that counts as on screen (a card about to scroll in starts early). */
const ROOT_MARGIN = "120px";

function pageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export interface DeviceThumbnail extends ThumbnailSnapshot {
  /** The card is on screen (or near it). */
  onScreen: boolean;
}

/**
 * Poll `url` about once a second while `element` is on screen and the page is visible. Without
 * IntersectionObserver (old browsers, jsdom) the card counts as on screen.
 */
export function useDeviceThumbnail(url: string | null, element: Element | null, deps?: ThumbnailDeps): DeviceThumbnail {
  const [snapshot, setSnapshot] = useState<ThumbnailSnapshot>(OFF_SNAPSHOT);
  const [onScreen, setOnScreen] = useState(false);
  const pollerRef = useRef<ThumbnailPoller | null>(null);
  const depsRef = useRef(deps);

  useEffect(() => {
    const poller = new ThumbnailPoller(depsRef.current ?? defaultThumbnailDeps(), setSnapshot);
    pollerRef.current = poller;
    poller.setPageVisible(pageVisible());
    const onVisibility = () => poller.setPageVisible(pageVisible());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      poller.dispose();
      pollerRef.current = null;
      setSnapshot(OFF_SNAPSHOT);
    };
  }, []);

  useEffect(() => {
    pollerRef.current?.setUrl(url);
  }, [url]);

  useEffect(() => {
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting);
      },
      { rootMargin: ROOT_MARGIN }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      setOnScreen(false);
    };
  }, [element]);

  useEffect(() => {
    pollerRef.current?.setOnScreen(onScreen);
  }, [onScreen]);

  return { ...snapshot, onScreen };
}
