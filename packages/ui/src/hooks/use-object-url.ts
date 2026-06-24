import { useEffect, useState } from "react";

export interface ObjectUrlState {
  url: string | null;
  loading: boolean;
  error: boolean;
}

/**
 * Fetch bytes for `path`, wrap them in a typed Blob, and expose a
 * createObjectURL() string that is revoked on path/mime change and on unmount.
 * `enabled` gates the fetch (skip when over the download ceiling). An in-flight
 * fetch is aborted when inputs change.
 */
export function useObjectUrl(
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>,
  path: string,
  mime: string,
  enabled: boolean
): ObjectUrlState {
  const [state, setState] = useState<ObjectUrlState>({ url: null, loading: enabled, error: false });

  useEffect(() => {
    if (!enabled) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ url: null, loading: true, error: false });
    fetchBytes(path, controller.signal)
      .then((bytes) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setState({ url: objectUrl, loading: false, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ url: null, loading: false, error: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fetchBytes, path, mime, enabled]);

  return state;
}
