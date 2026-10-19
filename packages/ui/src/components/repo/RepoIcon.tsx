import React from "react";
import { FolderGit2 } from "lucide-react";

import { cn } from "../../lib/cn";
import { useRepoIdentity } from "../../lib/repo-identities/hooks";

/**
 * A repo's icon: its emoji, its image, or the neutral default — a rounded
 * square `size` px wide. `repoKey` absent → the default.
 */
export const RepoIcon: React.FC<{ repoKey?: string; size?: number; className?: string }> = ({
  repoKey,
  size = 24,
  className
}) => {
  const icon = useRepoIdentity(repoKey)?.icon;
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-neutral-800 leading-none text-neutral-400",
        className
      )}
    >
      {icon?.kind === "emoji" ? icon.value : <FolderGit2 size={Math.round(size * 0.6)} />}
    </span>
  );
};
