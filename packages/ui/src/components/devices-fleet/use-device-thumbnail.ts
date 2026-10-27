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

/** What a card polls: the URL (no credentials in it) and the transport's auth headers. */
export interface DeviceThumbnailRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
}

/**
 * Poll `request` about once a second while `element` is on screen and the page is visible. Without
 * IntersectionObserver (old browsers, jsdom) the card counts as on screen.
 */
export function useDeviceThumbnail(request: DeviceThumbnailRequest | null, element: Element | null, deps?: ThumbnailDeps): DeviceThumbnail {
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

  const url = request?.url ?? null;
  const headers = request?.headers;
  useEffect(() => {
    // The poller ignores an equal URL and equal headers, so a re-render's fresh object is free.
    pollerRef.current?.setUrl(url, headers);
  }, [url, headers]);

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
