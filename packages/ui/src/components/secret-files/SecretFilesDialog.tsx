import React from "react";

/**
 * "Secret files…" for one repo in one workspace (spec §6): first setup (file
 * selection, source per file) and, once the vault exists, file management and
 * every clone's per-file state with Push / Reset / Compare.
 *
 * INTERFACE STUB — renders nothing until implemented.
 */
export const SecretFilesDialog: React.FC<{
  open: boolean;
  workspace: string;
  repoKey: string;
  /** The repo's label as shown, for the title. */
  repoLabel: string;
  onClose: () => void;
}> = () => null;
