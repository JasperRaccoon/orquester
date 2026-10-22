# 09: Desktop app, settings, onboarding, and project/workspace management

T3 Code at `ed9b7ca9` (pulled from `e8d87689`, 652 commits) compared with Orquester `main` (`dcab9eed`).
Paths starting `t3/` are under `t3code_codebase/`. Other paths are Orquester paths from the repo root.
"(new)" marks work that landed in the 652 new commits. I checked this with `git cat-file -e e8d87689:<path>` and the commit log.

Scope: the Electron shell, first-run setup, how settings are organised, appearance, usage display, the in-app browser (desktop side), HTML renders, licence screens, and adding, grouping and switching projects. Providers, remote/connect, mobile and CLI ops are covered in reports 02, 04, 05 and 08, so they appear here only where they touch these surfaces.

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (missing/partial, with evidence) | User value | Port effort |
|---|---|---|---|---|
| **Desktop auto-update** (electron-updater, `latest`/`nightly` channels, 4-min poll, release notes, "restart to update", records a failed install) | `t3/apps/desktop/src/updates/DesktopUpdates.ts` (1175 lines; poll constants L52-53), `updateMachine.ts`, `releaseNotes.ts`, `updateChannels.ts`, `electron/ElectronUpdater.ts`; GitHub publish feed in `t3/scripts/build-desktop-artifact.ts:2740-2761,2864-2876`; UI `t3/apps/web/src/components/desktopUpdate.toast.tsx` | **Missing.** `apps/desktop/package.json` has no `electron-updater` dependency and no `publish` block. `apps/desktop/src/main.ts` has no updater code. The web client only has a manual "Reload app" button (`packages/ui/src/components/settings/GeneralSettings.tsx:41-55`). | H | M |
| **"Update everything" button** (desktop app, connected servers and outdated providers in one step, with progress, retry and a restart countdown) | `t3/apps/web/src/components/ServerUpdateAction.tsx`, `ProviderUpdatesAction.tsx`, `t3/apps/desktop/src/updates/DesktopRemoteUpdates.ts`, `remoteUpdateFlow.ts`; doc `t3/docs/user/updating.md` | **Missing.** Servers are updated outside the app with `./deploy.sh deploy` (README "Self-hosting"). Harness "Update" buttons exist one CLI at a time (`packages/ui/src/components/settings/AgentsSettings.tsx:179-206`). | M | L |
| **Client/server version-skew detection** (an app newer or older than its server is refused with a notice that names the side to update) | `t3/apps/web/src/versionSkew.ts`; `t3/docs/user/updating.md` "When versions don't match" | **Missing.** Searching `packages/ui`, `packages/api` and `apps/daemon` for `appVersion\|daemonVersion\|protocolVersion` finds no client↔daemon check. Only the agent-host protocol is versioned (`apps/daemon/src/agent-host/host-protocol.ts`). A desktop app talking to an older VPS daemon fails silently. | M | S |
| **Desktop OS notifications and dock/taskbar badge** | `t3/apps/web/src/components/ThreadNotificationCoordinator.tsx:44-66,222-231` (`new Notification`, `setNotificationBadge`), `t3/apps/desktop/src/ipc/methods/notificationBadge.ts` (dock count, Windows overlay icon, cleared on focus) | **Missing on desktop.** The notifications section renders only for `runtime === "web"` (`GeneralSettings.tsx:96`). The only `Notification` use is Web Push (`packages/ui/src/lib/push.ts:59`). `main.ts` never calls `setBadgeCount` or `setOverlayIcon`. Desktop users get no OS alert when an agent needs them, even though the README's headline is "end-to-end attention signalling". | **H** | S |
| **Native application menu** (About, Check for Updates, Settings… `Cmd+,`, Edit incl. Paste as Text, View zoom/reload/devtools, Window, Help) | `t3/apps/desktop/src/window/DesktopApplicationMenu.ts:166-306` | **Missing.** `main.ts` only builds the tray menu (`main.ts:675-696`) and never calls `Menu.setApplicationMenu`, so the app runs on Electron's default menu. | M | S |
| **Native context menu with spellcheck suggestions, Copy/Save image** | `t3/apps/desktop/src/window/DesktopWindow.ts:541-583`, `window/ContextMenuImage.ts` | **Missing.** `apps/desktop/src` has no `context-menu` handler. Right-clicking a composer textarea in the desktop app shows no Cut/Copy/Paste or spelling fixes. | M | S |
| **Window bounds persistence and multi-display sanity check** | `t3/apps/desktop/src/window/DesktopWindow.ts:59,140-160,480` | **Missing.** The window is always created at a fixed 1320x860 (`main.ts:706-710`). | M | S |
| **Deep links / custom URL scheme** (`t3code://`, Linux `.desktop` handler registration, second-instance argv routing, prompt links `…/new?prompt=`) | `t3/scripts/build-desktop-artifact.ts:2909-2918,2966-2971` (`protocols`), `t3/apps/desktop/src/app/DesktopLinuxUrlHandler.ts`, `DesktopClerk.ts:198-235`, `t3/docs/user/prompt-links.md` | **Missing (one partial).** There is no `setAsDefaultProtocolClient`, `open-url` or `second-instance` handler in `apps/desktop/src`, and no URL routing in `packages/ui` (no `pushState` outside `workflows/phone/back-close.ts`). The one exception: the service worker opens `/?workflow=<id>&run=<id>` (`apps/web/public/sw.js:272-297`). You cannot link to a session, project or draft prompt. | M | M |
| **Use as default browser / open `.html` files** (links from other apps open in the in-app browser panel or a new projectless thread) | `t3/docs/user/default-browser.md`; macOS `CFBundleDocumentTypes` and http/https `protocols` in `t3/scripts/build-desktop-artifact.ts:2899-2918`; `t3/apps/desktop/src/app/DesktopWebLinks.ts` | **Missing.** Orquester's browser is a server-side Chromium (`apps/daemon/src/browsers.ts`), so this would mean "open URL in project browser tab". | L | M |
| **`t3 app` / installable CLI shim** (open the current directory as a thread in the running desktop app; Settings → About → Install `t3` command) | `t3/apps/desktop/src/app/DesktopCliShim.ts`, `DesktopAppActivation.ts`, `DesktopAppActivationBroker.ts`; `t3/apps/web/src/components/settings/CliCommandSettingsRow.tsx`; `t3/docs/user/install.md` "Open a project from a terminal" | **Missing.** `apps/daemon/src/cli.ts` only starts the daemon. There is no user-facing CLI and no "open this dir" handoff. | M | M |
| **SnapShots** (global hotkey captures the frontmost window plus its accessibility tree into the draft; macOS/Windows/Wayland incl. GNOME extension, KDE, Hyprland, Niri) | `t3/apps/desktop/src/snapShot/*` (30 files), `t3/apps/web/src/components/settings/SnapShotSettings.tsx`, `SnapShotSetupDialog.tsx`; `t3/docs/user/snap-shot.md`, `t3/docs/internals/linux-snap-shot.md` | **Missing.** The desktop app has no `globalShortcut` or `desktopCapturer`. The nearest thing is Design Mode's element picker, which only covers Orquester's own headless browser (`apps/daemon/src/browser-pick.ts`). | M | L |
| **Browser profiles and cookie import** (Chrome/Chromium/Firefox/Safari/Helium cookies into the preview browser; Safari Full Disk Access flow) | `t3/apps/desktop/src/preview/BrowserImport/*` (`ChromiumCookies.ts`, `FirefoxCookies.ts`, `SafariCookies.ts`, `LinuxBrowserSecret.ts`), `t3/apps/web/src/components/settings/BrowserImportWizard.tsx`; `t3/docs/user/browser-import.md` | **Missing.** `browsers.ts:428-438` gives each project a persistent `userDataDir`, but there are no named profiles and no import, so every project browser starts signed out. | M | M |
| **First-run welcome wizard** (connect computers → check Claude/Codex install and sign-in with one-click terminal → import projects found in Claude/Codex history, grouped by repo, default-selecting git repos active within 30 days with ≥3 conversations, plus their recent conversations) | `t3/apps/web/src/components/onboarding/WelcomeWizard.tsx` (steps L103), `FirstRunGate.tsx`, `t3/apps/web/src/onboarding/providerReadiness.logic.ts:36-45`, `projectImport.logic.ts:4-26,42-60`, server `t3/apps/server/src/project/AgentSessionScanner.ts` (bounded scan L47-67), `AgentSessionImporter.ts`; `t3/docs/user/welcome-wizard.md`. Bare-repo worktrees offered (new, `acf5f3bd`) | **Missing.** A fresh install lands on `RecentProjects` or "No workspace selected" (`packages/ui/src/components/main/MainView.tsx:134-142`, `RecentProjects.tsx:25`). The building blocks exist separately: the harness installer (`AgentsSettings.tsx`), account linking (`ClaudeOAuthLink.tsx`, `DeviceCodeLink.tsx`), and per-project history listers (`apps/daemon/src/agent-conversations.ts`). Nothing guides a new user through them. | **H** | M |
| **Scoped settings: environment × project overrides with an inheritance chain**, "Mixed" across machines, reset-to-inherit, per-project provider on/off | `t3/apps/web/src/components/settings/settingsScope.ts`, `scopedSettings.ts`, `SettingInheritance.tsx`, `SettingsScopeSentence.tsx`, `useScopedSettings.ts`; `t3/docs/user/project-settings.md` | **Partial.** One per-project override exists: continue-after-restart (`packages/config/src/index.ts:790,814`; `ChatSettings.tsx:27-33`). Everything else is per-daemon (`app.json`) or per-device. | M | L |
| **Project settings page** (name, icon, actions/scripts, checkouts, removal; repo `t3.json` defaults and actions) | `t3/apps/web/src/components/settings/ProjectSettingsPanel.tsx`, `ProjectActionsSettings.tsx`, `ProjectScriptsControl.tsx`; `t3/apps/server/src/project/T3ProjectFileLoader.ts` | **Partial.** The project menu offers Copy path / Archive / Delete (`packages/ui/src/components/sidebar/WorkspaceProjects.tsx:199-226`). Repo icon and label live on the repo group (`RepoGroupSection.tsx`, `RepoIconDialog.tsx`). There are no per-project action buttons and no repo-declared project file. Workflows cover some of the automation. | M | M |
| **Automatic project icon detection plus monogram fallback** (scans ~25 favicon/icon paths in the repo; two-letter coloured monogram; Lucide icon set; image previews in the picker (new, `55b72ff2`)) | `t3/apps/server/src/project/ProjectFaviconResolver.ts:17-60`, `t3/apps/web/src/projectIconOptions.ts`, `ProjectMonogram.tsx`, `ProjectIconPickerDialog.tsx` | **Partial.** Repo icons are emoji, uploaded image, or a typed website's favicon (`packages/config/src/repo-identities.ts:38-47`, `RepoIconDialog.tsx:16-20`). The default is a generic `FolderGit2` glyph for every repo (`packages/ui/src/components/repo/RepoIcon.tsx:36-38`), so there's no zero-config differentiation. | M | S |
| **Add a project to another machine from the "Run on" menu**, copying ignored `.env`-style files (size-capped, opt-out per file) (new, `effb4337`) | `t3/apps/web/src/components/AddProjectToMachineDialog.tsx`, `t3/apps/web/src/lib/addProjectToMachine.ts`, `t3/apps/server/src/workspace/WorkspaceEntries.ts` | **Partial.** `RunsOnRow` places a *new* project in an ephemeral box (`packages/ui/src/components/boxes/location/RunsOnRow.tsx`, used by `NewProjectModal.tsx:32`). Secret Files syncs `.env` between clones (`apps/daemon/src/secret-files/`). There's no "replicate this existing project onto my other daemon", and daemons are only switched one at a time (`components/servers/ServerSwitcher.tsx`). | M | M |
| **Cross-machine project grouping in the sidebar** (the same repo on laptop and server shows as one row with members per environment) | `t3/apps/web/src/sidebarProjectGrouping.ts:1-40`, `logicalProject.ts`; server `bare repositories group with projects of the same remote` (`f7bef383`, new) | **Missing by architecture.** One active connection at a time (`ServerSwitcher.tsx`). Repo grouping works within a daemon (`RepoGroupSection.tsx`). | M | L |
| **Theme engine: custom themes, theme editor with an on-screen colour picker, VS Code / Open VSX theme import, JSON export, server-published themes (`t3 theme set`)**; command-palette theme switching and a shortcut | `t3/apps/web/src/components/settings/ThemeEditorPanel.tsx` (1228 lines), `ThemeImportDialog.tsx`, `t3/apps/web/src/vscodeThemeImport.ts`, `openVsxThemes.ts`, `themePalette.ts`, `t3/apps/server/src/environmentTheme.ts`, `components/CommandPaletteThemeItems.tsx`; fix `7845898c` (new) | **Partial.** Seven built-in schemes × 4 modes (`packages/ui/src/lib/theme.ts:31-45`). There's no custom/imported theme and no palette command (`command-palette/CommandPalette.tsx` lists only sessions, projects and conversation search). | M | M–L |
| **Typography and interface prefs** (UI and mono font family, sizes, font smoothing, word wrap, contrast, glass opacity, diff colours, chat width, panel-animation duration, composer-context toggle, Render-math toggle). Typography and Appearance were split into their own files (new, `568cbb42`, `501f5c57`) | `t3/apps/web/src/components/settings/AppearanceSettingsPanel.tsx:88-423`, `TypographySettings.tsx:209-514`, `FontFamilyPicker.tsx` | **Partial.** Appearance offers mode, scheme and terminal font size only (`packages/ui/src/components/settings/AppearanceSettings.tsx:73-191`). LaTeX always renders (no toggle) via `rehype-katex` (`agent-chat/timeline/markdown/math.ts`). | M | S–M |
| **Per-row settings search** (indexes individual settings, keybindings and source-control hosts with anchor ids; jumps to the row) | `t3/apps/web/src/components/settings/settingsSearch.ts` (1185 lines; labels L74-88, keybinding items L94-108) | **Partial.** Search matches only section label, description and keywords (`packages/ui/src/components/settings/SettingsModal.tsx:212-216`). | M | S |
| **Keybindings editor** | `t3/apps/web/src/components/settings/KeybindingsSettings.tsx`, `t3/apps/web/src/keybindings.ts` | **Missing.** Shortcuts are hard-coded (`packages/ui/src/lib/agent-chat/keybindings.logic.ts`, `components/attention/GlobalShortcutListener.tsx`). Report 06/07 may cover this in more depth. | M | M |
| **Open-source licences screen** generated at build time (SPDX-checked; the build fails on missing licence text; searchable) | `t3/apps/web/src/components/settings/OpenSourceLicenses.tsx`, `t3/scripts/lib/third-party-licenses.ts`, `t3/scripts/sync-third-party-license-notices.ts`, `t3/docs/internals/open-source-licenses.md` | **Missing.** No licence or attribution screen in `packages/ui` and no generator under `scripts/`. This matters more if we port T3 code: MIT requires keeping its copyright notice. | M (compliance) | S |
| **Usage page** (24h/7d/30d/90d; Cost/Tokens/Limits tabs; per-model trend, cache hit rate, $/Mtok; **custom model prices and "Map to"**; pooled limits across accounts and environments; `mod+u`) | `t3/apps/web/src/components/usage/UsagePage.tsx`, `UsagePriceOverrides.tsx`, `UsageLimitsPooled.tsx`, `usageShortcuts.ts`; server `t3/apps/server/src/usage/usagePricing.ts`; `t3/docs/user/usage.md` | **Partial.** There's a top-bar popover with a 14-day cost chart, per-model rows with an input/output/cache split, and per-account quota cards (`packages/ui/src/components/topbar/UsageWidget.tsx:55-150`, `settings/UsageOverview.tsx`). Prices are a hard-coded table (`apps/daemon/src/usage-tokens.ts:9-25`), unknown models show "No pricing data", and there are no user overrides or period selector. | M | S (prices) / M (page) |
| **Connecting splash while the local backend starts** (new, `ce2707b8`) plus "Still connecting / Could not read settings" first-run states | `t3/apps/desktop/src/window/DesktopWindow.ts` (commit `ce2707b8`), `t3/apps/web/src/components/onboarding/FirstRunGate.tsx` | **Missing.** `main.ts:774-796` awaits `startIntegratedDaemon()` *before* `createWindow()`, so a cold start shows nothing until the daemon is up. | M | S |
| **OS-keychain storage of saved-server credentials** | `t3/apps/desktop/src/settings/DesktopSavedEnvironments.ts:229-273` (`safeStorage`), `t3/apps/desktop/src/linuxSecretStorage.ts` | **Partial.** The raw password never persists, but the derived bearer hash sits in renderer `localStorage` (`packages/ui/src/lib/auth.ts:83`), which on desktop is an unencrypted Chromium LevelDB file. | M | S |
| **Release packaging**: macOS dmg+zip for arm64/x64/universal, signed and notarised, with camera, mic and screen-capture entitlements (`b232fa9f`, new); Windows NSIS x64+arm64 with jsign; Linux AppImage with static FUSE runtime plus `.deb` with deps and metainfo; winget/brew/AUR; CI release workflows | `t3/scripts/build-desktop-artifact.ts:160-177,2878-3000`, `t3/scripts/sign-macos.ts`, `t3/.github/workflows/release-desktop.yml`, `t3/docs/user/install.md` "Desktop app" | **Partial.** `apps/desktop/package.json` `build` has dmg, NSIS x64 only, and AppImage. There's no signing, notarisation, arm64, deb, publish feed or `.github/workflows`. Electron is **^33.4.11**, long out of support. T3 is on 44.9.3 and bumped it in the new commits (`61e2747f`) to block compromised CA keys. | H (security + reach) | M |
| **Hold-to-quit (`Cmd+Q`) guard** | `t3/apps/desktop/src/window/QuitHold.ts`, `t3/apps/web/src/components/QuitHoldOverlay.tsx` | **Missing.** Less important here because Orquester's tray and run-in-background keep the daemon alive. | L | S |
| **Diagnostics settings** (startup crash log, resource telemetry, DB-space notice, `t3 doctor` to reclaim space) | `t3/apps/web/src/components/settings/DiagnosticsSettings.tsx`, `ResourceTelemetryDiagnostics.tsx`, `DatabaseStorageNotice.tsx` | **Equivalent or better** for resources: `components/system/TaskManager.tsx`, `HostResourceCards.tsx`, Settings → Host status. No DB reclaim is needed: state is JSON and the only SQLite file is a disposable cache. | L | — |

---

## 2. They do it better

1. **Settings organisation and scope.**
   - **T3:** Settings are routed pages (`/settings/<section>`, `settingsSearch.ts:74-88`) with a sentence at the top saying which project and environment a change applies to (`SettingsScopeSentence.tsx`). A layers icon on each row explains where the value comes from (`SettingInheritance.tsx`). Search reaches individual rows and keybindings.
   - **Orquester:** Settings are a modal with 12 sections in 4 groups (`SettingsModal.tsx:70-190`), searched by section keyword only (L212-216). Per-project overrides exist for exactly one setting.
   - **Why it matters:** As Orquester grows (Agent Profiles, plugins, boxes, workflows), users need T3's per-row search and an explicit scope line to answer "where is X, and does it apply here?".

2. **First-run experience.**
   - **T3:** Detects installed and signed-in agents and offers a terminal with the right install or login command (`providerReadiness.logic.ts:36-45` quotes the binary per shell). It finds the user's real projects from their agent history and imports recent conversations, capped and bounded (`AgentSessionScanner.ts:47-67`).
   - **Orquester:** Everything is there (one-click harness install, OAuth and device-code account linking, conversation listers), but it's scattered across Settings → Harnesses, Settings → Accounts and the right rail. A new user sees "No workspace selected".

3. **Electron shell polish.**
   - **T3:** About 140 desktop source files. They cover application menu, context menu with spellcheck, bounds persistence, single-instance argv routing, quit guard, splash, OS notifications and badge, keychain secrets, updater, URL handlers, Windows foreground focus workarounds, and macOS permission helpers.
   - **Orquester:** `main.ts` is 821 lines and essentially a transport bridge, a tray and the `orq-visual://` scheme.
   - **A bug found while checking:** `useTitlebar` can be switched off in Settings (`GeneralSettings.tsx:85-93`), which hides the in-app window controls (`TopBar.tsx:112-113`). But `main.ts:713-714` always creates the window with `frame: false, titleBarStyle: "hidden"` and never reads `useTitlebar`. On Windows and Linux, switching it off leaves a frameless window with **no close/minimise/maximise controls at all**.

4. **Agent CLI updates.**
   - **T3:** Provider cards show the *available* version and a known-incompatible warning. "Update now" uses the installer that owns the CLI: brew, npm, pnpm, Yarn, Bun, Volta, Vite+ or mise (`t3/docs/user/install.md` "Providers"; `ProviderUpdateLaunchNotification*.tsx`). Model discovery refreshes after an update.
   - **Orquester:** Shows the installed version and a blind "Update" (`AgentsSettings.tsx:187-206`). `latestVersion` or `updateAvailable` appear nowhere in `apps/daemon/src/registry.ts` or `packages/api`.
   - Report 02 likely goes deeper on this.

5. **Usage cost accuracy.**
   - **T3:** Lets users set or override any model's price per environment and map a preview model onto a released one (`UsagePriceOverrides.tsx`, `usagePricing.ts`).
   - **Orquester:** The price table is hard-coded and must be edited in source whenever a model ships (`usage-tokens.ts:6-25`, "Update when models ship"). An unknown model silently costs `null`.

6. **Project icons without effort.**
   - **T3:** Shows a recognisable icon for every project on day one, from the repo's own favicon or logo, or else a deterministic monogram and colour.
   - **Orquester:** Every repo group shows the same `FolderGit2` until the user picks an emoji, image or domain.

---

## 3. Worth copying (ranked by value ÷ effort)

### 1. Desktop OS notifications and dock/taskbar badge (H value, S effort)
- **Where:** `packages/ui/src/components/attention/agent-sessions.ts` already knows which sessions are waiting or finished. Add a `desktopNotify`/`setBadge` hook on the desktop bridge (`apps/desktop/src/preload.cjs`, `apps/desktop/src/main.ts`). The main process calls `app.setBadgeCount` on macOS/Linux and `setOverlayIcon` on Windows, and clears on `browser-window-focus`. In the renderer use `new Notification(...)`; on click, reveal the window and activate the tab.
- **Settings:** Show `NotificationsSection` for desktop too (`GeneralSettings.tsx:96`), with a mode select (all / when unfocused / off).
- **Crib:** `t3/apps/web/src/components/ThreadNotificationCoordinator.tsx` (pending set, badge sync, focus clear), `t3/apps/desktop/src/ipc/methods/notificationBadge.ts` (payload validation, Windows overlay).

### 2. Electron basics pack (M–H value, S effort): app menu, context menu, bounds, single instance, honour `useTitlebar`
- **Where:** All in `apps/desktop/src/main.ts`, or a new `apps/desktop/src/window.ts` if `main.ts` gets crowded.
  - `Menu.setApplicationMenu` with Settings… (`Cmd+,` sends an IPC that opens `SettingsModal`), Edit, View zoom and reload, and Window.
  - `webContents.on("context-menu")` with spelling suggestions and cut/copy/paste.
  - Persist bounds to `<appdir>/app/window-state.json`. Follow the existing `window-theme.json` pattern at `main.ts:198-278`: device-local, owned by the main process, validated field by field.
  - `requestSingleInstanceLock` and focus on `second-instance`.
  - Read `useTitlebar` at window creation (`frame: !useTitlebar`) to fix the missing-controls bug in §2.3.
- **Crib:** `t3/apps/desktop/src/window/DesktopApplicationMenu.ts:160-310`, `DesktopWindow.ts:140-160,480,541-583`.

### 3. Electron upgrade and auto-update with a client/daemon skew check (H value, M effort)
- **Upgrade:** Move Electron from 33 to a supported major first. That's a security fix by itself.
- **Updater:** Add `electron-updater` with a GitHub `publish` block in `apps/desktop/package.json` `build`. Add an `apps/desktop/src/updates.ts` state machine (idle → checking → downloading → ready → error) exposed over the preload bridge, and a toast in `packages/ui`.
- **Skew check:** Add `appVersion`/`apiVersion` to `GET /api/config/daemon` (`packages/api` contract first), and have the UI warn when the connected daemon is older or newer. This matters most for desktop → VPS.
- **Crib:** `t3/apps/desktop/src/updates/updateMachine.ts` (states), `DesktopUpdates.ts` (startup delay, poll interval, install-record file to detect "restarted on old version"), `releaseNotes.ts`, `t3/apps/web/src/versionSkew.ts`, publish config in `t3/scripts/build-desktop-artifact.ts:2740-2761`.
- **Caveat:** A real release pipeline (signing, notarisation, CI) is the bulk of the effort.

### 4. First-run welcome flow (H value, M effort)
- **Where:**
  - New `packages/ui/src/components/onboarding/WelcomeFlow.tsx`, shown when the daemon has no workspaces and no `onboardingDone` flag. Store the flag in `appConfigSchema`, `packages/config/src/index.ts:884`, tolerating its absence.
  - **Step 1, Agents:** Reuse `AgentsSettings` rows and the `ClaudeOAuthLink`/`DeviceCodeLink` components, with a readiness state per harness: checking / install / sign-in / ready.
  - **Step 2, Workspace:** Create the first workspace (`NewWorkspaceModal.tsx`) and connect a git identity (`GitHostingSettings.tsx`).
  - **Step 3, Import:** A new daemon route `GET /api/onboarding/project-candidates`. It walks Claude (`~/.claude/projects/*`) and Codex session dirs using the bounded readers already in `apps/daemon/src/agent-conversations.ts`, groups by normalised `origin` (reuse the repo-key logic in `apps/daemon/src/repo-id.ts`), and returns `{remote, paths, threadCount, lastActiveAt}`.
- **Projects outside the workspaces root:** Orquester's sandbox requires `<workspaces>/<ws>/<project>` (`apps/daemon/src/recent-projects.ts:22-35`). So the import step should offer "Clone into workspace X" (existing server-side clone in `NewProjectModal.tsx`) rather than registering foreign paths. Past conversations then resume through the existing resume flow.
- **Crib:** `t3/apps/web/src/onboarding/projectImport.logic.ts` (30-day/≥3-thread default selection, grouping by remote key, "Other folders"), `providerReadiness.logic.ts`, `t3/apps/server/src/project/AgentSessionScanner.ts` (limits at L47-67), and the UX copy in `t3/docs/user/welcome-wizard.md`.

### 5. Repo icon auto-detection and monogram fallback (M value, S effort)
- **Where:**
  - `apps/daemon/src/repo-identities/service.ts` gets a `detectIcon(projectPath)` that tries T3's candidate list. Reuse `image-sniff.ts` to validate, and serve through the existing icon blob route.
  - In `packages/ui/src/components/repo/RepoIcon.tsx:36-38`, replace the `FolderGit2` fallback with a deterministic two-letter monogram coloured from a hash of the repo label.
  - Add an "Automatic" choice to `RepoIconDialog.tsx`.
  - Extend `repoIcon` in `packages/config/src/repo-identities.ts` only if the user picks a monogram explicitly; keep `passthrough()` tolerance.
- **Crib:** `t3/apps/server/src/project/ProjectFaviconResolver.ts:38-60` (candidate paths and cache TTLs), `t3/apps/web/src/components/ProjectMonogram.tsx`, `projectIconColors.ts`.

### 6. Per-row settings search and deep-linkable sections (M value, S effort)
- **Where:**
  - Give each `SettingRow` in `packages/ui/src/components/settings/primitives.tsx` an optional `searchId`/`keywords`.
  - Build a static index next to `SECTIONS` in `SettingsModal.tsx`. Matching rows show as results and scroll and highlight on select.
  - Reuse the existing section deep-link (`SettingsModal.tsx:288`) for `?settings=<section>#<row>`.
- **Crib:** `t3/apps/web/src/components/settings/settingsSearch.ts` (item shape `{id,title,to,searchTerms,secondary,targetId}`).

### 7. Open-source licences screen (M value for compliance, S effort)
- **Where:**
  - A build step in `apps/web/vite.config.ts` and `apps/desktop/vite.config.ts` that writes `third-party-licenses.json` next to `index.html`.
  - A Settings → General → About row "Open source licences", opening a searchable list in `packages/ui/src/components/settings/`.
  - Add a custom-notice entry for any T3 code ported under MIT.
- **Crib:** `t3/scripts/lib/third-party-licenses.ts`, `t3/apps/web/src/components/settings/OpenSourceLicenses.tsx`, `t3/docs/internals/open-source-licenses.md`. The custom-notices config shape is in the same doc.

### 8. User model prices in Usage (M value, S effort)
- **Where:**
  - Add a `usagePriceOverrides` record (model → `{input, output, cacheRead?, cacheWrite?, mapTo?}`) to daemon config via `packages/config` and the contract in `packages/api`.
  - Merge it over `MODEL_PRICING` in `apps/daemon/src/usage-tokens.ts:9-50` (`resolveModelKey`).
  - Add a "Set price" action on the "No pricing data" row in `packages/ui/src/components/topbar/UsageWidget.tsx:142` and a table in `UsageSettings.tsx`.
- **Crib:** `t3/apps/web/src/components/usage/UsagePriceOverrides.tsx`, `usagePriceForm.ts`, `usagePriceTable.ts`, `t3/apps/server/src/usage/usagePricing.ts`.

**Runners-up:**
- **Cold-start splash** (S): create the window before `await startIntegratedDaemon()` and show a "Starting daemon…" screen. See `ce2707b8`.
- **Keychain-backed desktop credentials** (S): Electron `safeStorage` for the bearer hash.
- **Session deep links:** `orquester://` plus `/?session=<id>`, extending the existing `?workflow=` boot path in `sw.js`.
- **Custom themes / VS Code import** (M–L): `vscodeThemeImport.ts` maps VS Code tokens onto a palette. Orquester's scheme system is the `--n-*` CSS variables, so an importer would generate a `[data-scheme=custom]` block.

---

## 4. We do it better / they lack

- **Tray and run in background.** A tray icon keeps the daemon and its sessions alive after the window closes. It can switch the remote HTTP transport on or off live, and Quit shuts the daemon down cleanly (`apps/desktop/src/main.ts:637-703,755-761`). T3's desktop has no tray (no `Tray` in `t3/apps/desktop/src`). It relies on `t3 service install` for background hosting.
- **Window painted in the user's colour scheme on launch.** The renderer persists the resolved background to `window-theme.json`, validated, and the main process uses it before first paint (`main.ts:188-278`).
- **"Dynamic" theme mode that follows time of day** (`packages/ui/src/lib/theme.ts:41-45`). T3 offers only System/Light/Dark.
- **Agent config editor for each CLI's own global setup** (MCP servers, skills, plugins, marketplaces, hooks, commands, instruction file) across Claude, Codex, Grok and OpenCode (`AgentConfigSettings.tsx`). T3's settings have no MCP-server or hook editor (`IntegrationsSettings.tsx` covers browser, devices and PR links).
- **Agent Profiles.** Per-chat kits that replace the global setup (`apps/daemon/src/session-profiles/`, right rail). T3 has nothing equivalent.
- **Plugin system with a catalogue and settings** (`apps/daemon/src/plugins/`, `PluginsSettings.tsx`), for example Boxes and Secret Files. T3 ships features in core.
- **Workspaces as a level above projects, each with its own git identity.** Server-generated SSH keys, uploaded keys, `includeIf` (`GitHostingSettings.tsx`, `packages/config` `workspaceMetaSchema`). T3 groups by repo and environment but has no per-group commit identity.
- **New-project flow with templates**, server-side clone from an account repo picker, new-repo creation, and placement in an ephemeral VM (`NewProjectModal.tsx:54,216-238`; `RunsOnRow.tsx`). T3 scaffolds an empty repo (`ManagedProjectFolders.ts:391`) and clones by URL, with no templates.
- **Repo icons from a typed website's favicon**, fetched server-side through a safe fetcher with image sniffing and auto-shrink (`apps/daemon/src/repo-identities/favicon.ts`, `safe-fetch.ts`, `image-sniff.ts`). They are shared across all clients and workspaces.
- **Server-side browser with embedded Chrome DevTools**, streamed to any client including the phone (`apps/daemon/src/browsers.ts`, `devtools.ts`). T3's richest browser features (cookie import, passkeys, PiP) are tied to the Electron desktop.
- **Desktop tabs for Linux GUI apps** (VNC with audio, surviving restarts) (`apps/daemon/src/desktops/`). T3 has no equivalent. Its "devices" stream mobile simulators, a different job.
- **Parity:**
  - HTML renders / agent visuals: sandboxed frame, live theme sync, `orq-visual://` scheme on desktop, `html_render`/`html_preview` tools (`packages/ui/src/components/agent-chat/visual/VisualDocument.tsx`, `apps/daemon/src/html-preview/`).
  - LaTeX rendering with a stricter dollar-sign rule set (`agent-chat/timeline/markdown/math.ts`). It predates T3's LaTeX work (new, `cb0553ea`).
