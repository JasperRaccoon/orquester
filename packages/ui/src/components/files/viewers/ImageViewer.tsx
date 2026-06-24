import React from "react";
import { useObjectUrl } from "../../../hooks";

export interface ViewerProps {
  path: string;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

export const ImageViewer: React.FC<ViewerProps> = ({ path, mime, fetchBytes }) => {
  const { url, loading, error } = useObjectUrl(fetchBytes, path, mime, true);
  if (loading) return <p className="p-3 text-xs text-neutral-600">Loading…</p>;
  if (error || !url) return <p className="p-3 text-xs text-red-400">Could not load image.</p>;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-neutral-900 p-4">
      <img src={url} alt={path} className="max-h-full max-w-full object-contain" />
    </div>
  );
};
