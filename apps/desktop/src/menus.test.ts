import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import { applicationMenuTemplate, contextMenuTemplate, type ContextMenuInput } from "./menus";

const roles = (items: MenuItemConstructorOptions[] | undefined) =>
  (items ?? []).map((item) => item.role ?? item.label ?? item.type);
const submenu = (item: MenuItemConstructorOptions | undefined) => item?.submenu as MenuItemConstructorOptions[];
/** Electron's click signature, for the tests' direct calls. */
const click = (item: MenuItemConstructorOptions | undefined) =>
  (item?.click as (() => void) | undefined)?.();

describe("the application menu", () => {
  const calls: string[] = [];
  const actions = { openSettings: () => calls.push("settings"), openLogs: () => calls.push("logs") };

  it("on macOS: an app menu with Settings… and quit, then File, Edit, View, Window and Help", () => {
    const template = applicationMenuTemplate("darwin", "Orquester", actions);
    assert.deepEqual(
      template.map((item) => item.label ?? item.role),
      ["Orquester", "File", "Edit", "View", "windowMenu", "help"]
    );
    const appMenu = submenu(template[0]);
    assert.deepEqual(roles(appMenu), [
      "about",
      "separator",
      "Settings…",
      "separator",
      "services",
      "separator",
      "hide",
      "hideOthers",
      "unhide",
      "separator",
      "quit"
    ]);
    const settings = appMenu.find((item) => item.label === "Settings…");
    assert.equal(settings?.accelerator, "CmdOrCtrl+,");
    click(settings);
    assert.deepEqual(roles(submenu(template[1])), ["close"]);
    // The Edit roles carry the system copy/paste/undo shortcuts to the page.
    assert.deepEqual(roles(submenu(template[2])).slice(0, 10), [
      "undo",
      "redo",
      "separator",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "separator",
      "selectAll"
    ]);
    assert.deepEqual(roles(submenu(template[3])), [
      "reload",
      "forceReload",
      "toggleDevTools",
      "separator",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "separator",
      "togglefullscreen"
    ]);
    click(submenu(template[5])[0]);
    assert.deepEqual(calls.splice(0), ["settings", "logs"]);
  });

  it("elsewhere: Settings… and Quit live in File, and Edit has no Speech", () => {
    const template = applicationMenuTemplate("win32", "Orquester", actions);
    assert.deepEqual(
      template.map((item) => item.label ?? item.role),
      ["File", "Edit", "View", "windowMenu", "help"]
    );
    assert.deepEqual(roles(submenu(template[0])), ["Settings…", "separator", "quit"]);
    assert.equal(roles(submenu(template[1])).includes("Speech"), false);
  });
});

describe("the context menu", () => {
  const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  const field = (over: Partial<ContextMenuInput> = {}): ContextMenuInput => ({
    isEditable: true,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: { ...flags, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false },
    ...over
  });
  const calls: string[] = [];
  const actions = {
    replaceMisspelling: (word: string) => calls.push(`replace:${word}`),
    addToDictionary: (word: string) => calls.push(`add:${word}`)
  };

  it("offers cut, copy, paste and select all in an editable field, enabled as the field allows", () => {
    const template = contextMenuTemplate(field({ editFlags: { ...field().editFlags, canCut: false, canCopy: false } }), actions);
    assert.deepEqual(roles(template), ["cut", "copy", "paste", "separator", "selectAll"]);
    assert.deepEqual(template.map((item) => item.enabled), [false, false, true, undefined, true]);
  });

  it("puts up to five spelling suggestions and Add to Dictionary first over a misspelled word", () => {
    const template = contextMenuTemplate(
      field({ misspelledWord: "teh", dictionarySuggestions: ["the", "tea", "ten", "tel", "tex", "tee"] }),
      actions
    );
    assert.deepEqual(roles(template), [
      "the",
      "tea",
      "ten",
      "tel",
      "tex",
      "separator",
      "Add to Dictionary",
      "separator",
      "cut",
      "copy",
      "paste",
      "separator",
      "selectAll"
    ]);
    click(template[0]);
    click(template[6]);
    assert.deepEqual(calls.splice(0), ["replace:the", "add:teh"]);
    const none = contextMenuTemplate(field({ misspelledWord: "qzx" }), actions);
    assert.deepEqual(none.slice(0, 3).map((item) => [item.label ?? item.type, item.enabled]), [
      ["No Suggestions", false],
      ["separator", undefined],
      ["Add to Dictionary", undefined]
    ]);
  });

  it("offers Copy over a selection outside a field, and nothing over plain page", () => {
    assert.deepEqual(roles(contextMenuTemplate(field({ isEditable: false, selectionText: "some text" }), actions)), ["copy"]);
    assert.deepEqual(contextMenuTemplate(field({ isEditable: false, selectionText: "  " }), actions), []);
    assert.deepEqual(contextMenuTemplate(field({ isEditable: false }), actions), []);
  });
});
