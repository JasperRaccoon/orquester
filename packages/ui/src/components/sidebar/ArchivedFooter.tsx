import React, { useContext, useEffect, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import {
  AdaptiveMenu,
  DropdownContext,
  DropdownEmpty,
  DropdownItem,
  DropdownLabel,
  PasswordVerify
} from "../ui";
import { useAppStore } from "../../store/app";

/** Which archived items an entry lists. */
export type ArchivedScope = "workspaces" | "projects";

/**
 * Muted sidebar entry for archived items: the archived workspaces (under the
 * workspace list), or the open workspace's archived projects (inside its
 * expanded row). Hidden entirely when nothing is archived in that scope.
 * Rows are inert except Unarchive — no navigation into archived items (spec). With "Protect archived data" on, the panel body demands the
 * password on every open: the dropdown/sheet unmounts its children on close,
 * so the `verified` state below cannot outlive one open.
 */
export const ArchivedFooter: React.FC<{ scope: ArchivedScope }> = ({ scope }) => {
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);

  const count =
    scope === "projects"
      ? projects.filter((p) => p.isArchived).length
      : workspaces.filter((w) => w.isArchived).length;

  if (count === 0) {
    return null;
  }

  const trigger = (
    <span className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-neutral-500 transition-colors hover:text-neutral-300">
      <Archive size={13} className="shrink-0" />
      <span className="flex-1 truncate text-xs">
        {scope === "projects" ? "Archived projects" : "Archived workspaces"} ({count})
      </span>
    </span>
  );

  return (
    <AdaptiveMenu title="Archived" trigger={trigger} width="w-64" triggerClassName="flex w-full">
      <ArchivedPanel scope={scope} />
    </AdaptiveMenu>
  );
};

const ArchivedPanel: React.FC<{ scope: ArchivedScope }> = ({ scope }) => {
  // Dismissing the gate closes the whole menu (dropdown on desktop, bottom
  // sheet on mobile) — both provide this context.
  const { close } = useContext(DropdownContext);
  const protectArchived = useAppStore((s) => s.protectArchived);
  const protectArchivedLoaded = useAppStore((s) => s.protectArchivedLoaded);
  const loadProtectArchived = useAppStore((s) => s.loadProtectArchived);
  // Fresh mount per open ⇒ the gate re-asks every time (spec decision #5).
  // "Not yet known" counts as protected: connect() races this fetch against the
  // workspace load, so the footer can be clickable before the flag lands, and a
  // failed fetch leaves it unknown for the rest of the session. Failing open in
  // either window is exactly what the curtain exists to prevent. (On a local
  // unix-socket connection PasswordVerify is inert and auto-passes, so nothing
  // is locked there.)
  const [verified, setVerified] = useState(protectArchivedLoaded && !protectArchived);

  // Self-heal a failed/in-flight connect-time load instead of staying gated all
  // session; lift the gate as soon as the daemon confirms protection is off.
  useEffect(() => {
    if (!protectArchivedLoaded) {
      void loadProtectArchived();
    } else if (!protectArchived) {
      setVerified(true);
    }
  }, [protectArchivedLoaded, protectArchived, loadProtectArchived]);

  if (!verified) {
    return (
      <>
        <DropdownLabel>Archived</DropdownLabel>
        <PasswordVerify
          autoFocus
          message="Enter your password to view archived items."
          onVerified={() => setVerified(true)}
          onCancel={close}
        />
      </>
    );
  }
  return <ArchivedList scope={scope} />;
};

const ArchivedList: React.FC<{ scope: ArchivedScope }> = ({ scope }) => {
  const workspaces = useAppStore((s) => s.workspaces);
  const projects = useAppStore((s) => s.projects);
  const setWorkspaceArchived = useAppStore((s) => s.setWorkspaceArchived);
  const setProjectArchived = useAppStore((s) => s.setProjectArchived);

  const rows =
    scope === "projects"
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
        {scope === "projects" ? "Archived projects" : "Archived workspaces"}
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
