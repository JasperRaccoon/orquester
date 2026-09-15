import React from "react";
import { cn } from "../../lib/cn";
import type { UploadProgress } from "../../lib/upload-progress";
import { formatBytes } from "../system/system-format";

export interface UploadProgressBarProps {
  progress: UploadProgress;
  /** Leading label; defaults to "Uploading". */
  label?: string;
  className?: string;
}

/**
 * The one upload progress bar. Three rows so it stays legible in a 280px
 * strip as well as a full-width bar: label + "2 of 5" against the percent, the
 * slim track, then the file name against the byte counter. The fill eases to
 * its new width and carries a soft sheen while bytes are still moving, so a
 * stalled link reads differently from a slow one. Styled on the neutral scale
 * + the `info` token so it sits in every colour scheme without branching.
 */
export const UploadProgressBar: React.FC<UploadProgressBarProps> = ({ progress, label = "Uploading", className }) => {
  const pct = Math.max(0, Math.min(100, Math.round(progress.fraction * 100)));
  const many = progress.fileCount > 1;
  return (
    <div className={cn("min-w-0", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="flex items-baseline gap-2 text-[11px] leading-4">
        <span className="font-medium text-neutral-200">{label}</span>
        {many && (
          <span className="tabular-nums text-neutral-500">
            {progress.fileIndex} of {progress.fileCount}
          </span>
        )}
        <span className="ml-auto tabular-nums font-medium text-neutral-200">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-neutral-800">
        <div
          className="relative h-full overflow-hidden rounded-full bg-info transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        >
          {pct < 100 && (
            <div className="upload-sheen absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
          )}
        </div>
      </div>
      <div className="mt-1 flex items-baseline gap-2 text-[11px] leading-4">
        <span className="min-w-0 flex-1 truncate text-neutral-400" title={progress.fileName}>
          {progress.fileName}
        </span>
        <span className="shrink-0 tabular-nums text-neutral-500">
          {formatBytes(progress.sent)}
          <span className="text-neutral-700"> / </span>
          {formatBytes(progress.total)}
        </span>
      </div>
    </div>
  );
};
