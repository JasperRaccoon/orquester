import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

// --- Native menus ---
//
// Templates only; main.ts builds and installs them. The Edit roles are what
// make the system copy/paste/undo shortcuts reach the page on macOS, and the
// View roles the reload, zoom and DevTools shortcuts everywhere.

export interface ApplicationMenuActions {
  /** Settings… — the renderer opens its Settings dialog. */
  openSettings(): void;
  /** Help → Open Logs Folder. */
  openLogs(): void;
}

// Adapted from T3 Code (MIT): apps/desktop/src/window/DesktopApplicationMenu.ts
export function applicationMenuTemplate(
  platform: NodeJS.Platform,
  appName: string,
  actions: ApplicationMenuActions
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const settings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => actions.openSettings()
  };
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: appName,
      submenu: [
        { role: "about", label: `About ${appName}` },
        { type: "separator" },
        settings,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Hide ${appName}` },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit", label: `Quit ${appName}` }
      ]
    });
  }
  template.push(
    {
      label: "File",
      submenu: mac ? [{ role: "close" }] : [settings, { type: "separator" }, { role: "quit" }]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
        ...(mac
          ? ([
              { type: "separator" },
              { label: "Speech", submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }] }
            ] satisfies MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: "Open Logs Folder", click: () => actions.openLogs() }]
    }
  );
  return template;
}

/** The fields of Electron's `context-menu` params the menu reads. */
export type ContextMenuInput = Pick<
  ContextMenuParams,
  "isEditable" | "selectionText" | "misspelledWord" | "dictionarySuggestions" | "editFlags"
>;

export interface ContextMenuActions {
  replaceMisspelling(word: string): void;
  addToDictionary(word: string): void;
}

const MAX_SUGGESTIONS = 5;

/**
 * The right-click menu: spelling fixes and "Add to Dictionary" over a
 * misspelled word, then cut/copy/paste/select all in an editable field, or
 * Copy over a selection elsewhere. Empty (no menu) anywhere else — a page's
 * own context menu cancels the event before it gets here.
 */
// Adapted from T3 Code (MIT): apps/desktop/src/window/DesktopWindow.ts
export function contextMenuTemplate(params: ContextMenuInput, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const word = params.misspelledWord;
  if (word) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    for (const suggestion of suggestions) {
      template.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    }
    if (suggestions.length === 0) template.push({ label: "No Suggestions", enabled: false });
    template.push({ type: "separator" }, { label: "Add to Dictionary", click: () => actions.addToDictionary(word) });
  }
  if (params.isEditable) {
    if (template.length > 0) template.push({ type: "separator" });
    template.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll }
    );
  } else if (params.selectionText.trim() !== "") {
    template.push({ role: "copy", enabled: params.editFlags.canCopy });
  }
  return template;
}
