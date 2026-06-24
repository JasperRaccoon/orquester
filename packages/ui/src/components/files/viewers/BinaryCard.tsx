import React, { useState } from "react";
import { Download, FileQuestion } from "lucide-react";
import { Button } from "../../ui";
import { downloadBlob } from "../../../lib/files";

const fmtSize = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;

export interface BinaryCardProps {
  path: string;
  name: string;
  size: number;
  mime: string;
  title: string;
  /** True when size <= the download ceiling (download button shown). */
  downloadable: boolean;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

export const BinaryCard: React.FC<BinaryCardProps> = ({ path, name, size, mime, title, downloadable, fetchBytes }) => {
  const [busy, setBusy] = useState(false);
  const onDownload = async () => {
    setBusy(true);
    try {
      const bytes = await fetchBytes(path);
      downloadBlob(name, new Blob([bytes], { type: mime }));
    } catch {
      /* ignore — leaves the button re-enabled */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion size={32} className="text-neutral-600" />
      <div>
        <p className="text-sm text-neutral-300">{title}</p>
        <p className="text-xs text-neutral-600">
          {name} · {fmtSize(size)}
        </p>
      </div>
      {downloadable ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void onDownload()}>
          <Download size={13} />
          {busy ? "Downloading…" : "Download"}
        </Button>
      ) : (
        <p className="text-[11px] text-neutral-600">Too large for in-app download — use a terminal.</p>
      )}
    </div>
  );
};
