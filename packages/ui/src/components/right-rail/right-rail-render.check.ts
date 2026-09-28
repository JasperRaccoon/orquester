/**
 * Render smoke checks for the right rail's shell: the icon rail, the dock, a
 * phone's section bar and section, and the row that places them beside the tab content.
 *
 * `right-rail-state.test.ts` owns persistence and `dock-keyboard.test.ts` the
 * keyboard rules; this exists because "each button is labelled and reports
 * whether its panel is open", "the dock's header names the panel", "the panel
 * receives the chat, the project and its variant" and "the tab content stays
 * first in the row" are claims about MARKUP — a prop mistake typechecks
 * perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The panels are fakes that print the props they received, so the check never
 * depends on the real panels' own needs; the registry is checked to point at
 * the real ones separately.
 */

import assert from "node:assert/strict";
import { createElement, type FC, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { setActiveChatTab } from "../../lib/agent-chat-active-tab";
import type { TabContext } from "../../store/app";
import { PromptHistoryPanel } from "./history/PromptHistoryPanel";
import { RIGHT_RAIL_PANEL_REGISTRY, type RightRailPanelRegistry } from "./panels";
import { RightRail } from "./RightRail";
import { RightRailDock } from "./RightRailDock";
import { openProjectPathOf, RightRailRow } from "./RightRailFrame";
import { MOBILE_SECTION_BAR_MAX, MobileSectionBar, MobileSectionView, splitSectionItems } from "./MobileSections";
import { __resetRightRailStoreForTests } from "./right-rail-state";
import { SavedPromptsPanel } from "./saved-prompts/SavedPromptsPanel";
import type { RightRailPanelId, RightRailPanelProps } from "./types";

const NOOP = (): void => {};
const render = (element: ReactElement): string => renderToStaticMarkup(element);

/** A panel that prints what it was given. */
const fakePanel =
  (name: string): FC<RightRailPanelProps> =>
  (props) =>
    createElement("div", {
      "data-fake-panel": name,
      "data-variant": props.variant,
      "data-project": props.projectPath,
      "data-session": String(props.sessionId),
      "data-delivered": typeof props.onDelivered
    });

const FAKES: RightRailPanelRegistry = {
  prompts: { ...RIGHT_RAIL_PANEL_REGISTRY.prompts, Component: fakePanel("prompts") },
  history: { ...RIGHT_RAIL_PANEL_REGISTRY.history, Component: fakePanel("history") }
};

// No storage under node: the rail's state lives in memory for this script.
__resetRightRailStoreForTests({ storage: null });

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

assert.equal(RIGHT_RAIL_PANEL_REGISTRY.prompts.Component, SavedPromptsPanel, "Saved prompts renders the real panel");
assert.equal(RIGHT_RAIL_PANEL_REGISTRY.history.Component, PromptHistoryPanel, "History renders the real panel");
assert.equal(RIGHT_RAIL_PANEL_REGISTRY.prompts.title, "Saved prompts");
assert.equal(RIGHT_RAIL_PANEL_REGISTRY.history.title, "History & checkpoints");

// ---------------------------------------------------------------------------
// The icon rail
// ---------------------------------------------------------------------------

/** Each button's opening tag, top to bottom. */
const buttons = (html: string): string[] => html.match(/<button[^>]*>/g) ?? [];

{
  const html = render(createElement(RightRail, { open: "prompts", onToggle: NOOP }));
  const [prompts, history, ...rest] = buttons(html);
  assert.equal(rest.length, 0, "exactly two buttons");
  assert.ok(prompts?.includes('aria-label="Saved prompts"'), "Saved prompts comes first");
  assert.ok(prompts?.includes('title="Saved prompts"'), "with its tooltip");
  assert.ok(history?.includes('aria-label="History &amp; checkpoints"'), "then History & checkpoints");
  assert.ok(history?.includes('title="History &amp; checkpoints"'));
  assert.ok(prompts?.includes('aria-pressed="true"'), "the open panel's button is pressed");
  assert.ok(history?.includes('aria-pressed="false"'), "the other is not");
  assert.ok(prompts?.includes('aria-controls="right-rail-dock"'), "the pressed one controls the dock");
  assert.ok(!history?.includes("aria-controls"), "the other controls nothing on screen");
  assert.ok(/class="[^"]*\bbg-neutral-800\b[^"]*\bring-1\b/.test(prompts ?? ""), "pressed reads as a raised square");
  assert.ok(/class="[^"]*\btext-neutral-500\b/.test(history ?? ""), "the other stays muted");
  assert.ok(/aria-label="Side panels"[^>]*class="[^"]*\bw-11\b/.test(html), "a labelled w-11 column");
  assert.equal((html.match(/<svg/g) ?? []).length, 2, "one icon per button");
}

{
  const closed = buttons(render(createElement(RightRail, { open: null, onToggle: NOOP })));
  assert.ok(closed.every((tag) => tag.includes('aria-pressed="false"')), "with the dock closed nothing is pressed");
  const history = buttons(render(createElement(RightRail, { open: "history", onToggle: NOOP })));
  assert.ok(history[0]?.includes('aria-pressed="false"') && history[1]?.includes('aria-pressed="true"'));
}

// ---------------------------------------------------------------------------
// The dock
// ---------------------------------------------------------------------------

setActiveChatTab("chat-1");
{
  const html = render(
    createElement(RightRailDock, { panel: "prompts", projectPath: "/w/orquester", width: 333, panels: FAKES })
  );
  assert.ok(
    /<h2 id="right-rail-dock-title"[^>]*>Saved prompts<\/h2>/.test(html),
    "the header names the panel"
  );
  assert.ok(
    /<aside[^>]*id="right-rail-dock"[^>]*aria-labelledby="right-rail-dock-title"/.test(html),
    "the dock is the region its title names, and the id the rail button controls"
  );
  assert.ok(/<aside[^>]*tabindex="-1"/.test(html), "focusable, so a click inside keeps the keyboard in it");
  assert.ok(
    /<aside[^>]*class="[^"]*\bfocus-visible:ring-1\b[^"]*\bfocus-visible:ring-inset\b/.test(html),
    "and focus pulled back to it shows"
  );
  assert.ok(/<aside[^>]*data-keyboard-surface=""/.test(html), "a keyboard surface: the chat's chords stand down in it");
  assert.ok(
    html.includes(
      'style="width:333px;min-width:max(0px, min(260px, 100% - 404px));max-width:max(0px, min(560px, 100% - 404px))"'
    ),
    "its width is the stored one, bounded against the row — the content's floor winning over the dock's minimum"
  );
  const separator = html.indexOf('role="separator"');
  assert.ok(
    separator > html.indexOf("<aside") && separator < html.indexOf("<header"),
    "the resize handle sits INSIDE the dock, first: the dock's overflow-hidden clips its grip"
  );
  assert.ok(/<aside[^>]*class="relative [^"]*\boverflow-hidden\b/.test(html), "the dock positions and clips it");
  assert.ok(/role="separator"[^>]*aria-label="Resize side panel"/.test(html));
  const handle = /<div class="([^"]*)"><span aria-hidden="true"[^>]*><\/span><div role="separator"/.exec(html)?.[1] ?? "";
  for (const token of [
    "absolute",
    "inset-y-0",
    "left-0",
    "[&amp;&gt;[role=separator]]:left-0",
    "[&amp;&gt;[role=separator]]:translate-x-0"
  ]) {
    assert.ok(handle.split(" ").includes(token), `the handle's root: ${token}`);
  }
  assert.ok(
    !handle.split(" ").includes("relative"),
    "its grip starts at the dock's left edge and runs into the dock — never over the tab content's scrollbar"
  );
  assert.ok(/<header class="[^"]*\bpx-3\b/.test(html), "the header lines up with the panels' px-3");
  assert.ok(
    /<div class="flex min-h-0 flex-1 flex-col text-sm"><div data-fake-panel="prompts"/.test(html),
    "the panel fills a flex-1 column body"
  );
  const panel = html.match(/<div data-fake-panel="prompts"[^>]*>/)?.[0] ?? "";
  assert.ok(panel.includes('data-variant="docked"'), "docked");
  assert.ok(panel.includes('data-project="/w/orquester"'), "the open project");
  assert.ok(panel.includes('data-session="chat-1"'), "the visible chat");
  assert.ok(panel.includes('data-delivered="undefined"'), "and no onDelivered — the dock never closes itself");
  assert.ok(!html.includes('data-fake-panel="history"'), "only the active panel is mounted");
}

setActiveChatTab(null);
{
  const html = render(
    createElement(RightRailDock, { panel: "history", projectPath: "/w/orquester", width: 320, panels: FAKES })
  );
  assert.ok(/<h2[^>]*>History &amp; checkpoints<\/h2>/.test(html), "the other panel's title");
  assert.ok(html.includes('data-fake-panel="history"') && !html.includes('data-fake-panel="prompts"'));
  assert.ok(html.includes('data-session="null"'), "no chat on screen reaches the panel as null");
}

// ---------------------------------------------------------------------------
// A phone: the section bar and a section, full screen
// ---------------------------------------------------------------------------

{
  const html = render(createElement(MobileSectionBar, { active: null, onSelect: NOOP, chatTab: true, panels: FAKES }));
  assert.ok(html.startsWith('<nav aria-label="Sections"'), "a labelled nav");
  const items = buttons(html);
  assert.equal(items.length, 3, "Chat, Prompts, History");
  assert.ok(items[0]?.includes('aria-current="page"'), "the tab content is the current one");
  assert.ok(html.includes(">Chat</span>") && html.includes(">Prompts</span>") && html.includes(">History</span>"));
  assert.ok(!html.includes(">More</span>"), "no More while everything fits");

  const onTerminal = render(createElement(MobileSectionBar, { active: "history", onSelect: NOOP, chatTab: false, panels: FAKES }));
  assert.ok(onTerminal.includes(">Tab</span>") && !onTerminal.includes(">Chat</span>"), "not a chat: Tab");
  const [tab, , history] = buttons(onTerminal);
  assert.ok(!tab?.includes("aria-current") && history?.includes('aria-current="page"'), "the section showing is current");
}

{
  // Past the bar's room, the last slot is More.
  const ids = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(splitSectionItems(ids), { shown: ["a", "b", "c", "d"], more: ["e", "f"] });
  assert.deepEqual(splitSectionItems(ids.slice(0, MOBILE_SECTION_BAR_MAX)), { shown: ids.slice(0, 5), more: [] });
  const many = ["prompts", "history", "prompts", "history", "prompts"] as unknown as RightRailPanelId[];
  const html = render(createElement(MobileSectionBar, { active: null, onSelect: NOOP, chatTab: true, panels: FAKES, order: many }));
  assert.equal(buttons(html).length, MOBILE_SECTION_BAR_MAX, "four items and More");
  assert.ok(html.includes(">More</span>") && html.includes('aria-haspopup="dialog"'));
}

setActiveChatTab("chat-2");
{
  const html = render(
    createElement(MobileSectionView, { section: "prompts", projectPath: "/w/orquester", onLeave: NOOP, panels: FAKES })
  );
  assert.ok(html.startsWith("<div data-keyboard-surface="), "a keyboard surface: the chat's chords stand down in it");
  assert.ok(html.includes('role="region" aria-label="Saved prompts"'), "named after its panel");
  assert.ok(html.includes("absolute inset-0"), "over the tab content, filling it");
  const panel = html.match(/<div data-fake-panel="prompts"[^>]*>/)?.[0] ?? "";
  assert.ok(panel.includes('data-variant="sheet"'), "the touch-sized variant");
  assert.ok(panel.includes('data-delivered="function"'), "with onDelivered, which goes back to the chat");
  assert.ok(panel.includes('data-session="chat-2"') && panel.includes('data-project="/w/orquester"'));
}
setActiveChatTab(null);

// ---------------------------------------------------------------------------
// The row: [tab content | dock | rail]
// ---------------------------------------------------------------------------

const TAB_CONTENT = createElement("main", { "data-tab-content": "" });
const row = (projectPath: string | null, open: RightRailPanelId | null): string =>
  render(createElement(RightRailRow, { projectPath, open, width: 320, panels: FAKES, children: TAB_CONTENT }));
const ALONE = '<div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"><main data-tab-content=""></main></div>';

{
  const html = row("/w/orquester", "prompts");
  const content = html.indexOf("data-tab-content");
  const dock = html.indexOf("<aside");
  const rail = html.indexOf('aria-label="Side panels"');
  assert.ok(content > 0 && content < dock && dock < rail, "the tab content first, then the dock, then the rail");
  assert.ok(html.startsWith('<div class="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"><main'), "in one flex row");
  assert.ok(html.includes('data-project="/w/orquester"'), "the dock serves the open project");

  const closed = row("/w/orquester", null);
  assert.ok(!closed.includes("<aside") && closed.includes('aria-label="Side panels"'), "a closed dock leaves the rail");
  assert.ok(closed.startsWith(ALONE.slice(0, -"</div>".length)), "and the tab content where it was");

  // No project on a desktop viewport, or any phone (`RightRailFrame` passes null).
  assert.equal(row(null, "prompts"), ALONE, "without a project the row holds the tab content alone");
}

const project = (path: string): TabContext => ({
  kind: "project",
  key: path,
  project: { name: "orquester", workspace: "w", path }
});
assert.equal(openProjectPathOf(project("/w/orquester")), "/w/orquester", "a project context has its path");
assert.equal(openProjectPathOf({ kind: "workspace", key: "w", workspace: "w" }), null, "a to-do context none");
assert.equal(openProjectPathOf(null), null, "and the landing view none");

console.log("right-rail render checks passed");
