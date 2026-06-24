import React from "react";
import { useObjectUrl } from "../../../hooks";

export const MediaViewer: React.FC<{
  path: string;
  mime: string;
  kind: "audio" | "video";
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, mime, kind, fetchBytes }) => {
  const { url, loading, error } = useObjectUrl(fetchBytes, path, mime, true);
  if (loading) return <p className="p-3 text-xs text-neutral-600">Loading…</p>;
  if (error || !url) return <p className="p-3 text-xs text-red-400">Could not load media.</p>;
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-neutral-900 p-4">
      {kind === "video" ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : (
        <audio src={url} controls className="w-full max-w-md" />
      )}
    </div>
  );
};
