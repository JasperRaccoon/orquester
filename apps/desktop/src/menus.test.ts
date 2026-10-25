import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MenuItemConstructorOptions } from "electron";

import { applicationMenuTemplate, contextMenuTemplate, type ContextMenuInput } from "./menus";

const submenu = (item: MenuItemConstructorOptions | undefined) => item?.submenu as MenuItemConstructorOptions[];
const click = (item: MenuItemConstructorOptions | undefined) => (item?.click as (() => void) | undefined)?.();
const role = (items: MenuItemConstructorOptions[], value: MenuItemConstructorOptions["role"]) => items.find((item) => item.role === value);

describe("the application menu", () => {
  it("provides native shortcuts and routes Settings and logs actions on macOS", () => {
    const calls: string[] = [];
    const template = applicationMenuTemplate("darwin", "Orquester", { openSettings: () => calls.push("settings"), openLogs: () => calls.push("logs") });
    const appMenu = submenu(template.find((item) => item.label === "Orquester"));
    assert.ok(role(appMenu, "quit"));
    const settings = appMenu.find((item) => item.accelerator === "CmdOrCtrl+,");
    assert.ok(settings?.click, "the system Settings shortcut must open settings");
    click(settings);
    const entries = template.flatMap((item) => submenu(item) ?? []);
    for (const required of ["undo", "redo", "cut", "copy", "paste", "selectAll", "close", "reload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut"] as const) {
      assert.ok(role(entries, required), `missing native ${required} action`);
    }
    assert.deepEqual(calls, ["settings"]);
    for (const item of submenu(role(template, "help")) ?? []) click(item);
    assert.ok(calls.includes("logs"), "a Help action must open the logs");
  });

  it("provides the Settings shortcut and Quit on Windows", () => {
    let opened = false;
    const template = applicationMenuTemplate("win32", "Orquester", { openSettings: () => { opened = true; }, openLogs: () => {} });
    const entries = template.flatMap((item) => submenu(item) ?? []);
    assert.ok(role(entries, "quit"));
    click(entries.find((item) => item.accelerator === "CmdOrCtrl+,"));
    assert.equal(opened, true);
  });
});

describe("the context menu", () => {
  const field = (over: Partial<ContextMenuInput> = {}): ContextMenuInput => ({
    isEditable: true,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false },
    ...over
  });
  const actions = { replaceMisspelling: (_word: string) => {}, addToDictionary: (_word: string) => {} };

  it("offers cut, copy, paste and select all in an editable field, enabled as the field allows", () => {
    const template = contextMenuTemplate(field({ editFlags: { ...field().editFlags, canCut: false, canCopy: false } }), actions);
    assert.equal(role(template, "cut")?.enabled, false);
    assert.equal(role(template, "copy")?.enabled, false);
    assert.equal(role(template, "paste")?.enabled, true);
    assert.equal(role(template, "selectAll")?.enabled, true);
  });

  it("replaces a misspelling and adds the original word to the dictionary", () => {
    const calls: string[] = [];
    const suggestions = ["the", "tea", "ten", "tel", "tex", "tee"];
    const template = contextMenuTemplate(field({ misspelledWord: "teh", dictionarySuggestions: suggestions }), {
      replaceMisspelling: (word) => calls.push(`replace:${word}`), addToDictionary: (word) => calls.push(`add:${word}`)
    });
    const suggestion = template.find((item) => item.label === "the");
    assert.ok(suggestion?.click);
    click(suggestion);
    // Suggestions are user-supplied data; the remaining action adds the original word.
    const add = template.find((item) => item.click && !suggestions.includes(item.label ?? ""));
    assert.ok(add);
    click(add);
    assert.deepEqual(calls, ["replace:the", "add:teh"]);
  });

  it("offers Copy over a selection outside a field, and nothing over plain page", () => {
    assert.ok(role(contextMenuTemplate(field({ isEditable: false, selectionText: "some text" }), actions), "copy"));
    assert.deepEqual(contextMenuTemplate(field({ isEditable: false, selectionText: "  " }), actions), []);
    assert.deepEqual(contextMenuTemplate(field({ isEditable: false }), actions), []);
  });
});
