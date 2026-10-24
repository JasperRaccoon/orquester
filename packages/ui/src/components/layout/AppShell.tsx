import React from "react";
import { Sidebar } from "../sidebar";
import { TopBar } from "../topbar";
import { MainView } from "../main";
import { AuthModal } from "../auth";
import { MobileKeyBar } from "../terminal";
import { ToastStack } from "../status";
import { CommandPalette } from "../command-palette";
import { GlobalShortcutListener } from "../attention";
import { SessionDeepLinkHost } from "../attention/SessionDeepLinkHost";
// Not the rail's barrel: it also exports the panels, which load lazily.
import { MobileSectionNav } from "../right-rail/MobileSections";
import { useMobileSection } from "../right-rail/mobile-section";
import { RightRailEditorHost, RightRailFrame } from "../right-rail/RightRailFrame";
import { WorkflowsHost } from "../workflows/WorkflowsHost";
import { CloseSessionConfirm } from "./CloseSessionConfirm";
import { LazyBoundary, LoadingOverlay, lazyNamed, useOpenedOnce } from "../ui/lazy";
import { useAppStore } from "../../store/app";

// Settings and the desktop's launch dialog load the first time they open.
const SettingsModal = lazyNamed(() => import("../settings/SettingsModal"), "SettingsModal");
const LaunchAppDialog = lazyNamed(() => import("../desktop/LaunchAppDialog"), "LaunchAppDialog");

/** Settings, mounted from its first opening on (it keeps its page across a close). */
const SettingsModalHost: React.FC = () => {
  const open = useAppStore((s) => s.settingsOpen);
  const opened = useOpenedOnce(open);
  return opened ? (
    <LazyBoundary inline={false} fallback={open ? <LoadingOverlay /> : null}>
      <SettingsModal />
    </LazyBoundary>
  ) : null;
};

const LaunchAppDialogHost: React.FC = () => {
  const open = useAppStore((s) => s.launchDialog !== null);
  return open ? (
    <LazyBoundary inline={false} fallback={<LoadingOverlay />}>
      <LaunchAppDialog />
    </LazyBoundary>
  ) : null;
};

/**
 * Primary layout: full-height sidebar on the left, and a main column whose top
 * bar occupies the titlebar region above the content area. Below the top bar,
 * the tab content shares a row with the right rail (desktop, a project open):
 * `[MainView | docked panel | icon rail]`. A phone has a bar of sections at
 * the bottom instead, under the terminal key bar, which a section hides (it
 * covers the terminal).
 */
const MobileBottomBars: React.FC = () => {
  const section = useMobileSection();
  return (
    <>
      {section === null && <MobileKeyBar />}
      <MobileSectionNav />
    </>
  );
};

export const AppShell: React.FC = () => (
  <div className="flex min-h-0 flex-1">
    <Sidebar />
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <RightRailFrame>
        <MainView />
      </RightRailFrame>
      <MobileBottomBars />
    </div>
    <SettingsModalHost />
    <AuthModal />
    <CloseSessionConfirm />
    <LaunchAppDialogHost />
    <ToastStack />
    <CommandPalette />
    <GlobalShortcutListener />
    <RightRailEditorHost />
    <WorkflowsHost />
    <SessionDeepLinkHost />
  </div>
);
