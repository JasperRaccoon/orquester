import React from "react";
import { Sidebar } from "../sidebar";
import { TopBar } from "../topbar";
import { MainView } from "../main";
import { SettingsModal } from "../settings";
import { AuthModal } from "../auth";
import { MobileKeyBar } from "../terminal";
import { ToastStack } from "../status";
import { CommandPalette } from "../command-palette";
import { GlobalShortcutListener } from "../attention";
import { RightRailEditorHost, RightRailFrame } from "../right-rail";
import { CloseSessionConfirm } from "./CloseSessionConfirm";

/**
 * Primary layout: full-height sidebar on the left, and a main column whose top
 * bar occupies the titlebar region above the content area. Below the top bar,
 * the tab content shares a row with the right rail (desktop, a project open):
 * `[MainView | docked panel | icon rail]`.
 */
export const AppShell: React.FC = () => (
  <div className="flex min-h-0 flex-1">
    <Sidebar />
    <div className="flex min-w-0 flex-1 flex-col">
      <TopBar />
      <RightRailFrame>
        <MainView />
      </RightRailFrame>
      <MobileKeyBar />
    </div>
    <SettingsModal />
    <AuthModal />
    <CloseSessionConfirm />
    <ToastStack />
    <CommandPalette />
    <GlobalShortcutListener />
    <RightRailEditorHost />
  </div>
);
