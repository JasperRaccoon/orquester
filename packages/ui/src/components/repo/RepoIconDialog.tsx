import React from "react";

/**
 * "Change icon…" for one repo: an emoji, an uploaded image (shrunk to fit
 * first) or a website's favicon (spec 2026-10-18 §3, §3a, §3b).
 *
 * INTERFACE STUB — renders nothing until implemented.
 */
export const RepoIconDialog: React.FC<{
  open: boolean;
  repoKey: string;
  /** The repo's label as shown (its custom label or `owner/repo`), for the title. */
  repoLabel: string;
  onClose: () => void;
}> = () => null;
