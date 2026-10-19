import React from "react";
import { FolderGit2 } from "lucide-react";

import { cn } from "../../lib/cn";
import { useRepoIconImage, useRepoIdentity } from "../../lib/repo-identities/hooks";

/**
 * A repo's icon: its emoji, its image, or the neutral default — a rounded
 * square `size` px wide (14–16px on agent cards and search hits, 24px on group
 * headers). `repoKey` absent → the default.
 *
 * The box is sized up front, so nothing shifts while an image loads (it shows
 * the empty box meanwhile). An image comes from the shared, authenticated
 * blob-URL cache and is only ever shown through `<img>`, so an SVG can't run
 * script; one that failed to load shows the default.
 */
export const RepoIcon: React.FC<{ repoKey?: string; size?: number; className?: string }> = ({
  repoKey,
  size = 24,
  className
}) => {
  const icon = useRepoIdentity(repoKey)?.icon;
  const image = useRepoIconImage(repoKey, icon);
  let content: React.ReactNode;
  if (icon?.kind === "emoji") {
    content = (
      <span className="select-none" style={{ fontSize: Math.round(size * 0.78), lineHeight: 1 }}>
        {icon.value}
      </span>
    );
  } else if (icon?.kind === "image" && image?.status !== "failed") {
    content =
      image?.status === "ready" && image.url !== null ? (
        <img src={image.url} alt="" draggable={false} decoding="async" className="h-full w-full object-cover" />
      ) : null;
  } else {
    content = <FolderGit2 size={Math.max(8, Math.round(size * 0.6))} />;
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.22)) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden bg-neutral-800 leading-none text-neutral-400",
        className
      )}
    >
      {content}
    </span>
  );
};
