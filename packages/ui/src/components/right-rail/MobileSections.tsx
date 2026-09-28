/**
 * The right rail on a phone: no rail and no dock, but a bar of sections pinned
 * to the bottom of the app — the tab content first, then every rail panel —
 * and the section picked there shown full screen over the tab content.
 *
 * - **The bar** (`MobileSectionBar`) is in the layout flow under the tab
 *   content, like the terminal key bar, so it takes its height from the tab
 *   content instead of covering it. It hides while the on-screen keyboard is
 *   up (every row of the screen is worth more to the field being typed in),
 *   and shows at most {@link MOBILE_SECTION_BAR_MAX} items: past that, the
 *   last slot is "More", a bottom sheet listing the rest. A new panel added to
 *   `panels.ts` shows up here by itself.
 * - **A section** (`MobileSectionView`) covers the tab content inside the same
 *   row (`RightRailRow`), never replacing it in the tree: moving `MainView`
 *   would remount every tab, every terminal and chat stream with it. It is a
 *   fixed box the panel fills and scrolls inside, so nothing around it
 *   scrolls. An Insert or a Send that landed, "Jump to" and a rewind go back to
 *   the tab content (`onDelivered`), where their result is.
 * - **Keys**: the section is a keyboard surface (the chat's chords stand down
 *   for keys typed in it) and an open layer while it shows (the chat's Escape
 *   — interrupt, Esc-Esc rewind — stands down; the chat is not on screen).
 *   Escape inside it goes back to the tab content, unless something in it
 *   took the key first (the search box clearing itself stops it).
 */

import React from "react";
import { AppWindow, MessageSquare, MoreHorizontal, type LucideIcon } from "lucide-react";

import { useIsDesktop } from "../../hooks";
import { useOpenLayer } from "../../hooks/use-open-layer";
import { useSoftKeyboardOpen } from "../../hooks/use-soft-keyboard-open";
import { cn } from "../../lib/cn";
import { KEYBOARD_SURFACE_PROPS } from "../../lib/keyboard-surfaces";
import { useCurrentContext } from "../../store/app";
import { DropdownItem } from "../ui/dropdown";
import { BottomSheet } from "../ui/sheet";
import { useActiveChatTarget } from "./chat-target";
import { setMobileSection, useMobileSection } from "./mobile-section";
import { RIGHT_RAIL_PANEL_ORDER, RIGHT_RAIL_PANEL_REGISTRY, type RightRailPanelRegistry } from "./panels";
import type { RightRailPanelId } from "./types";

/** The most items the bar shows side by side, "More" included. */
export const MOBILE_SECTION_BAR_MAX = 5;

/* ── A section, full screen ─────────────────────────────────────────────── */

export interface MobileSectionViewProps {
  section: RightRailPanelId;
  projectPath: string;
  /** Back to the tab content. */
  onLeave: () => void;
  /** The panels by id (the real ones unless a check passes fakes). */
  panels?: RightRailPanelRegistry;
}

export const MobileSectionView: React.FC<MobileSectionViewProps> = ({
  section,
  projectPath,
  onLeave,
  panels = RIGHT_RAIL_PANEL_REGISTRY
}) => {
  const sessionId = useActiveChatTarget();
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  useOpenLayer(true);

  React.useEffect(() => {
    // On `document`, like every layer's: a key the panel stopped (the search
    // box clearing itself) never gets here. Only a key typed in this section
    // (or on nothing): a modal over it — the prompt editor — owns its own.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      const inside =
        target === document.body ||
        (target instanceof Node && rootRef.current !== null && rootRef.current.contains(target));
      if (inside) onLeave();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onLeave]);

  const { Component, title } = panels[section];
  return (
    <div
      ref={rootRef}
      {...KEYBOARD_SURFACE_PROPS}
      role="region"
      aria-label={title}
      data-mobile-section={section}
      className="absolute inset-0 z-10 flex min-h-0 flex-col bg-neutral-950 px-1 pt-2 text-sm"
    >
      <Component sessionId={sessionId} projectPath={projectPath} variant="sheet" onDelivered={onLeave} />
    </div>
  );
};

/**
 * {@link MobileSectionView} wired to the app: a section picked, shown while
 * `projectPath` is the open project on a phone (`RightRailFrame` passes
 * `null` on a desktop viewport and without a project).
 */
export const MobileSectionOverlay: React.FC<{ projectPath: string | null }> = ({ projectPath }) => {
  const section = useMobileSection();
  const available = projectPath !== null;
  React.useEffect(() => {
    // Nothing to show a section over (the landing view, a workspace's to-dos)
    // or no bar to leave it by (a desktop viewport): back to the tab content,
    // so it does not come back by itself later.
    if (!available) setMobileSection(null);
  }, [available]);
  if (!available || section === null || projectPath === null) return null;
  return <MobileSectionView section={section} projectPath={projectPath} onLeave={leaveSection} />;
};

function leaveSection(): void {
  setMobileSection(null);
}

/* ── The bar ────────────────────────────────────────────────────────────── */

interface BarItem {
  id: RightRailPanelId | null;
  label: string;
  title: string;
  Icon: LucideIcon;
}

export interface MobileSectionBarProps {
  /** The section showing: `null` is the tab content. */
  active: RightRailPanelId | null;
  onSelect: (section: RightRailPanelId | null) => void;
  /** The visible tab is a chat: the first item says "Chat" rather than "Tab". */
  chatTab: boolean;
  panels?: RightRailPanelRegistry;
  order?: readonly RightRailPanelId[];
}

/**
 * The items of the bar, in order: the tab content, then the panels. When they
 * do not all fit, the first `max - 1` and the rest behind "More".
 */
export function splitSectionItems<T>(items: readonly T[], max = MOBILE_SECTION_BAR_MAX): {
  shown: T[];
  more: T[];
} {
  if (items.length <= max) return { shown: [...items], more: [] };
  return { shown: items.slice(0, max - 1), more: items.slice(max - 1) };
}

const ITEM =
  "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium " +
  "transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-neutral-500";

const BarButton: React.FC<{
  label: string;
  title: string;
  Icon: BarItem["Icon"];
  active: boolean;
  onClick: () => void;
  haspopup?: boolean;
}> = ({ label, title, Icon, active, onClick, haspopup }) => (
  <button
    type="button"
    title={title}
    aria-current={active ? "page" : undefined}
    aria-haspopup={haspopup ? "dialog" : undefined}
    onClick={onClick}
    className={cn(ITEM, active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300")}
  >
    <span
      className={cn(
        "flex h-7 w-14 items-center justify-center rounded-full transition-colors",
        active && "bg-neutral-800"
      )}
    >
      <Icon size={18} aria-hidden />
    </span>
    <span className="max-w-full truncate px-1">{label}</span>
  </button>
);

export const MobileSectionBar: React.FC<MobileSectionBarProps> = ({
  active,
  onSelect,
  chatTab,
  panels = RIGHT_RAIL_PANEL_REGISTRY,
  order = RIGHT_RAIL_PANEL_ORDER
}) => {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const closeMore = React.useCallback(() => setMoreOpen(false), []);
  const items: BarItem[] = [
    {
      id: null,
      label: chatTab ? "Chat" : "Tab",
      title: chatTab ? "Back to the chat" : "Back to the tab",
      Icon: chatTab ? MessageSquare : AppWindow
    },
    ...order.map((id) => ({
      id,
      label: panels[id].shortTitle,
      title: panels[id].title,
      Icon: panels[id].Icon
    }))
  ];
  const { shown, more } = splitSectionItems(items);
  const moreActive = more.some((item) => item.id === active);
  return (
    <nav
      aria-label="Sections"
      className="flex h-14 shrink-0 items-stretch gap-1 border-t border-neutral-800 bg-neutral-900/60 px-1 py-1"
    >
      {shown.map((item) => (
        <BarButton
          key={item.id ?? "tab"}
          label={item.label}
          title={item.title}
          Icon={item.Icon}
          active={item.id === active}
          onClick={() => onSelect(item.id)}
        />
      ))}
      {more.length > 0 ? (
        <>
          <BarButton
            label="More"
            title="More sections"
            Icon={MoreHorizontal}
            active={moreActive}
            haspopup
            onClick={() => setMoreOpen(true)}
          />
          <BottomSheet open={moreOpen} onClose={closeMore} title="Sections">
            {more.map((item) => (
              <DropdownItem
                key={item.id ?? "tab"}
                icon={<item.Icon size={16} aria-hidden />}
                aria-current={item.id === active ? "page" : undefined}
                onClick={() => onSelect(item.id)}
                className={cn("py-3", item.id === active && "bg-neutral-800 text-neutral-100")}
              >
                {item.title}
              </DropdownItem>
            ))}
          </BottomSheet>
        </>
      ) : null}
    </nav>
  );
};

/**
 * {@link MobileSectionBar} wired to the app: a phone with a project open, the
 * on-screen keyboard down. The terminal key bar sits above it
 * (`AppShell`) and hides while a section covers the terminal.
 */
export const MobileSectionNav: React.FC = () => {
  const isDesktop = useIsDesktop();
  const projectOpen = useCurrentContext()?.kind === "project";
  const section = useMobileSection();
  const chatTab = useActiveChatTarget() !== null;
  const keyboardOpen = useSoftKeyboardOpen();
  if (isDesktop || !projectOpen || keyboardOpen) return null;
  return <MobileSectionBar active={section} onSelect={setMobileSection} chatTab={chatTab} />;
};
