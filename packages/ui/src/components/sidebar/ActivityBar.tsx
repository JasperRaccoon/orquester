import React from "react";
import { Boxes, Settings, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/cn";
import { useAppStore } from "../../store/app";
import { useAgentSessions } from "../attention";
import { RIGHT_RAIL_PANEL_REGISTRY } from "../right-rail/panels";
import { useWorkflowAttention } from "../workflows/runs/WorkflowAttention";
import { setSidebarView, useSidebarView, type SidebarView } from "./sidebar-view";

const ITEMS: ReadonlyArray<{ id: SidebarView; title: string; Icon: LucideIcon }> = [
  { id: "projects", title: "Projects & agents", Icon: Boxes },
  { id: "workflows", title: RIGHT_RAIL_PANEL_REGISTRY.workflows.title, Icon: RIGHT_RAIL_PANEL_REGISTRY.workflows.Icon },
  { id: "profile", title: RIGHT_RAIL_PANEL_REGISTRY.profile.title, Icon: RIGHT_RAIL_PANEL_REGISTRY.profile.Icon }
];

const ActivityButton: React.FC<{
  title: string;
  Icon: LucideIcon;
  active?: boolean;
  /** A dot on the icon: something in a view that is not showing wants the user. */
  badge?: "warn" | "danger" | null;
  onClick: () => void;
}> = ({ title, Icon, active = false, badge = null, onClick }) => (
  <button
    type="button"
    aria-label={title}
    title={title}
    aria-pressed={active}
    onClick={onClick}
    className={cn(
      "relative inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors",
      "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
      active
        ? "bg-neutral-800 text-neutral-50 ring-1 ring-inset ring-neutral-600"
        : "text-neutral-500 hover:bg-neutral-800/60 hover:text-neutral-200"
    )}
  >
    <Icon size={19} aria-hidden />
    {badge && (
      <span
        aria-hidden
        className={cn(
          "absolute right-1.5 top-1.5 h-2 w-2 rounded-full ring-2 ring-neutral-950",
          badge === "warn" ? "bg-warn" : "bg-danger"
        )}
      />
    )}
  </button>
);

/**
 * The desktop sidebar's leftmost column: one button per sidebar view — the
 * projects tree, workflows, the agent profile — and settings at the bottom.
 * A view that is not showing carries a dot when it holds something that wants
 * the user: an agent blocked on them, a failed workflow run.
 */
export const ActivityBar: React.FC = () => {
  const view = useSidebarView();
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const agentWaiting = useAgentSessions().some((entry) => entry.bucket === "attention");
  const workflowFailed = useWorkflowAttention().length > 0;

  const badgeOf = (id: SidebarView): "warn" | "danger" | null => {
    if (id === view) return null;
    if (id === "projects" && agentWaiting) return "warn";
    if (id === "workflows" && workflowFailed) return "danger";
    return null;
  };

  return (
    <nav
      aria-label="Sidebar views"
      className="flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-neutral-800 bg-neutral-950/50 py-3"
    >
      {ITEMS.map(({ id, title, Icon }) => (
        <ActivityButton
          key={id}
          title={title}
          Icon={Icon}
          active={view === id}
          badge={badgeOf(id)}
          onClick={() => setSidebarView(id)}
        />
      ))}
      <div className="flex-1" />
      <ActivityButton title="Settings" Icon={Settings} onClick={() => setSettingsOpen(true)} />
    </nav>
  );
};
