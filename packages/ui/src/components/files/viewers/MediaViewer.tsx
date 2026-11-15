import React, { useState } from "react";
import { useObjectUrl } from "../../../hooks";

type MediaKind = "audio" | "video";

/**
 * Plays audio or video either from `src` — a URL the player streams by byte
 * range — or, with `buffered`, from the whole file read into memory (the
 * desktop socket, which has no URL a media element can load).
 */
export const MediaViewer: React.FC<
  | { kind: MediaKind; src: string; buffered?: undefined }
  | {
      kind: MediaKind;
      src?: undefined;
      buffered: { path: string; mime: string; fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer> };
    }
> = ({ kind, src, buffered }) =>
  buffered ? <BufferedMedia kind={kind} {...buffered} /> : <MediaElement kind={kind} src={src} />;

const BufferedMedia: React.FC<{
  kind: MediaKind;
  path: string;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ kind, path, mime, fetchBytes }) => {
  const { url, loading, error } = useObjectUrl(fetchBytes, path, mime, true);
  if (loading) return <p className="p-3 text-xs text-neutral-600">Loading…</p>;
  if (error || !url) return <p className="p-3 text-xs text-danger">Could not load media.</p>;
  return <MediaElement kind={kind} src={url} />;
};

const MediaElement: React.FC<{ kind: MediaKind; src: string }> = ({ kind, src }) => {
  // A load the browser can't play (a codec it lacks, a failed request) leaves a dead player.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <p className="p-3 text-xs text-danger">This file can't be played here.</p>;
  const onError = () => setFailedSrc(src);
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-neutral-900 p-4">
      {kind === "video" ? (
        <video src={src} controls playsInline preload="metadata" onError={onError} className="max-h-full max-w-full" />
      ) : (
        <audio src={src} controls preload="metadata" onError={onError} className="w-full max-w-md" />
      )}
    </div>
  );
};
