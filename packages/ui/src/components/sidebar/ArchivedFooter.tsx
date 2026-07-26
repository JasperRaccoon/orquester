import React, { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { AdaptiveMenu, DropdownEmpty, DropdownItem, DropdownLabel, PasswordVerify } from "../ui";
import { useAppStore } from "../../store/app";

/**
 * Muted sidebar-footer entry for archived items. Context-sensitive: at the top
 * level it lists archived workspaces; inside a workspace, that workspace's
 * archived projects. Hidden entirely when nothing is archived in the current
 * context. Rows are inert except Unarchive — no navigation into archived
 * items (spec). With "Protect archived data" on, the panel body demands the
 * password on every open: the dropdown/sheet unmounts its children on close,
 * so the `verified` state below cannot outlive one open.
 */
export const ArchivedFooter: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);

  const count = currentWorkspace
    ? projects.filter((p) => p.isArchived).length
    : workspaces.filter((w) => w.isArchived).length;

  if (count === 0) {
    return null;
  }

  const trigger = (
    <span className="flex w-full items-center gap-2 px-1 py-0.5 text-left text-neutral-600 transition-colors hover:text-neutral-400">
      <Archive size={13} className="shrink-0" />
      <span className="flex-1 truncate text-xs">Archived · {count}</span>
    </span>
  );

  return (
    <div className="px-2 pb-1">
      <AdaptiveMenu title="Archived" trigger={trigger} width="w-64">
        <ArchivedPanel />
      </AdaptiveMenu>
    </div>
  );
};

const ArchivedPanel: React.FC = () => {
  const protectArchived = useAppStore((s) => s.protectArchived);
  // Fresh mount per open ⇒ the gate re-asks every time (spec decision #5).
  const [verified, setVerified] = useState(!protectArchived);

  if (!verified) {
    return (
      <>
        <DropdownLabel>Archived</DropdownLabel>
        <PasswordVerify
          autoFocus
          message="Enter your password to view archived items."
          onVerified={() => setVerified(true)}
        />
      </>
    );
  }
  return <ArchivedList />;
};

const ArchivedList: React.FC = () => {
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);
  const setProjectArchived = useAppStore((s) => s.setProjectArchived);

  const rows = currentWorkspace
    ? projects
        .filter((p) => p.isArchived)
        .map((p) => ({
          key: p.path,
          name: p.name,
          unarchive: () => void setProjectArchived(p, false)
        }))
    : workspaces
        .filter((w) => w.isArchived)
        .map((w) => ({
          key: w.path,
          name: w.name,
          unarchive: () => void setWorkspaceArchived(w.name, false)
        }));

  return (
    <>
      <DropdownLabel>
        {currentWorkspace ? "Archived projects" : "Archived workspaces"}
      </DropdownLabel>
      {rows.length === 0 && <DropdownEmpty>Nothing archived</DropdownEmpty>}
      {rows.map((row) => (
        <DropdownItem
          key={row.key}
          keepOpen
          icon={<ArchiveRestore size={14} />}
          onClick={row.unarchive}
        >
          {row.name}
        </DropdownItem>
      ))}
    </>
  );
};
