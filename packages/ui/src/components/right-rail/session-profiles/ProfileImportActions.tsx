/**
 * The profile editor's quick actions (agent profiles spec §4.5, §5.2):
 * Import from Global, Git, .zip, Copy from profile — and the Plugins tab's
 * "Add plugin" from a marketplace. Their routes are reserved in
 * `sessionProfileRoutes` (`…/imports/*`, `…/copy-from`, `…/plugins`) and
 * belong to the imports work, so this is the ONE place they plug in:
 *
 * `ProfileEditorView` renders this component only when its container passes
 * `importActions` (it does not yet). Each handler given becomes a button; a
 * handler left out is not drawn at all. `addPlugin` is the Plugins tab's
 * "+ Add plugin". Handlers receive the profile and the kind tab shown.
 */

import React from "react";
import { FolderGit2, Globe, Layers, Package } from "lucide-react";

import type { SessionProfileDetail, SessionProfileItemKind } from "@orquester/api";

import { cn } from "../../../lib/cn";

export interface ProfileImportActionHandlers {
  importFromGlobal?: (profile: SessionProfileDetail, kind: SessionProfileItemKind) => void;
  importFromGit?: (profile: SessionProfileDetail, kind: SessionProfileItemKind) => void;
  importFromZip?: (profile: SessionProfileDetail, kind: SessionProfileItemKind) => void;
  copyFromProfile?: (profile: SessionProfileDetail, kind: SessionProfileItemKind) => void;
  /** The Plugins tab's "+ Add plugin" (from the agent's marketplaces into the profile's plugin cache). */
  addPlugin?: (profile: SessionProfileDetail) => void;
}

export function hasImportActions(handlers: ProfileImportActionHandlers | undefined): boolean {
  if (handlers === undefined) return false;
  return Boolean(handlers.importFromGlobal || handlers.importFromGit || handlers.importFromZip || handlers.copyFromProfile);
}

export const ProfileImportActions: React.FC<{
  profile: SessionProfileDetail;
  kind: SessionProfileItemKind;
  handlers: ProfileImportActionHandlers;
  sheet: boolean;
}> = ({ profile, kind, handlers, sheet }) => {
  const actions: { id: string; label: string; Icon: typeof Globe; run: () => void }[] = [];
  if (handlers.importFromGlobal) actions.push({ id: "global", label: "Import from Global", Icon: Globe, run: () => handlers.importFromGlobal!(profile, kind) });
  if (handlers.importFromGit) actions.push({ id: "git", label: "Git", Icon: FolderGit2, run: () => handlers.importFromGit!(profile, kind) });
  if (handlers.importFromZip) actions.push({ id: "zip", label: ".zip", Icon: Package, run: () => handlers.importFromZip!(profile, kind) });
  if (handlers.copyFromProfile) actions.push({ id: "copy", label: "Copy from profile", Icon: Layers, run: () => handlers.copyFromProfile!(profile, kind) });
  if (actions.length === 0) return null;
  return (
    <div role="group" aria-label="Import" className="flex flex-wrap gap-1.5" data-profile-import-actions="">
      {actions.map(({ id, label, Icon, run }) => (
        <button
          key={id}
          type="button"
          onClick={run}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-neutral-800 px-2 text-xs text-neutral-300 transition-colors",
            "hover:border-neutral-700 hover:bg-neutral-800/60 hover:text-neutral-100",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
            sheet ? "h-10" : "h-7"
          )}
        >
          <Icon size={13} aria-hidden className="text-neutral-500" />
          {label}
        </button>
      ))}
    </div>
  );
};
