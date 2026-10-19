import React from "react";

/**
 * Compare one clone's secret files with the vault (spec §7): per file, the
 * variable names added / removed / changed (or line counts) — never values.
 * `path` absent: every managed file of that clone that isn't synced.
 *
 * INTERFACE STUB — renders nothing until implemented.
 */
export const SecretFileCompareModal: React.FC<{
  open: boolean;
  workspace: string;
  repoKey: string;
  projectPath: string;
  path?: string;
  onClose: () => void;
}> = () => null;
