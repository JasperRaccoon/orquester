/**
 * The chat's key listeners stand down for keys that belong to a keyboard
 * surface (`lib/keyboard-surfaces.ts`): the right rail's dock and its mobile
 * sheet, the saved-prompt editor.
 *
 * A SOURCE check, like `components/ui/open-layer-wiring.test.ts`, because
 * the gates are lines inside `window`/`document` listeners that nothing here
 * can fire: there is no DOM under node, and static rendering runs no effect.
 * What has to be prevented is a gate disappearing, or moving below the code
 * it guards — then a Ctrl/Cmd+E typed in the panel's search opens the chat's
 * effort menu behind it, a Ctrl/Cmd+Shift+Enter sends the chat's queued
 * message, and a digit on a focused prompt card answers the chat's question,
 * which cannot be undone. The helpers themselves are tested behaviourally
 * (`lib/keyboard-surfaces.test.ts`); that the dock and the sheet carry the
 * marker is `right-rail-render.check.ts`'s.
 *
 * Comments are stripped before anything is matched, so a commented-out gate
 * never passes for a live one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentChat = join(here, "..", "agent-chat");

/** The code without its comments (the wiring test's own rule). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const code = (...path: string[]): string => stripComments(readFileSync(join(agentChat, ...path), "utf8"));

/**
 * Every listener `name` registered by `registration`: the text from the last
 * `const <name> = (` before each registration up to it — one listener's body,
 * never two.
 */
function listenerBodies(source: string, name: string, registration: string): string[] {
  const bodies: string[] = [];
  for (let from = 0; ; ) {
    const end = source.indexOf(registration, from);
    if (end < 0) return bodies;
    const start = source.lastIndexOf(`const ${name} = (`, end);
    if (start >= 0) bodies.push(source.slice(start, end));
    from = end + registration.length;
  }
}

/** The one listener among them that does `marker`'s work. */
function listenerDoing(source: string, name: string, registration: string, marker: string): string {
  const bodies = listenerBodies(source, name, registration).filter((body) => body.includes(marker));
  assert.equal(bodies.length, 1, `exactly one ${name} listener does ${marker}`);
  return bodies[0]!;
}

/** `if (<gate>(event.target)) return;` — the gate, and that it ends the listener. */
const gateLine = (gate: string): RegExp =>
  new RegExp(`if\\s*\\(\\s*${gate}\\(\\s*event\\.target\\s*\\)\\s*\\)\\s*return\\b`);

/** `import { …, name, … } from "…/lib/keyboard-surfaces"`. */
const importsFromSurfaces = (name: string): RegExp =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"(?:\\.\\./)+lib/keyboard-surfaces"`);

test("stripping comments drops a commented-out gate", () => {
  assert.doesNotMatch(
    stripComments("// if (insideKeyboardSurface(event.target)) return;\n/* insideKeyboardOwner(x) */ a();"),
    /inside/
  );
});

test("the composer's chords stand down in a surface, before any chord is resolved", () => {
  const composer = code("composer", "ChatComposer.tsx");
  assert.match(composer, importsFromSurfaces("insideKeyboardSurface"));
  const listener = listenerDoing(
    composer,
    "onKeyDown",
    'window.addEventListener("keydown", onKeyDown, true)',
    "resolveChatShortcut(event)"
  );
  const gate = gateLine("insideKeyboardSurface").exec(listener);
  assert.ok(gate, "the chord listener calls insideKeyboardSurface(event.target) and returns");
  assert.ok(
    gate.index < listener.indexOf("resolveChatShortcut(event)"),
    "before resolveChatShortcut — Ctrl/Cmd+E, +/, +Shift+M and +Shift+Enter all ride it"
  );
});

test("an Escape a layer takes resets the composer's Esc-Esc count before the surface gate returns", () => {
  // A modal's, a sheet's or the rail dock's Escape is nobody's first press
  // (chat spec §7.4): the textarea never sees it, and the surface gate below
  // returns before the interrupt arm's own reset could run — so, left there,
  // closing a dialog between two Escapes in the composer opened the rewind
  // picker.
  const composer = code("composer", "ChatComposer.tsx");
  const listener = listenerDoing(
    composer,
    "onKeyDown",
    'window.addEventListener("keydown", onKeyDown, true)',
    "resolveChatShortcut(event)"
  );
  const reset =
    /if\s*\(\s*event\.key === "Escape" && anotherLayerOwnsTheKeyboard\(\)\s*\)\s*escapeSequence\.reset\(\)/.exec(
      listener
    );
  assert.ok(reset, "the listener resets the count for an Escape a layer takes");
  const gate = gateLine("insideKeyboardSurface").exec(listener);
  assert.ok(gate, "the surface gate is still there");
  assert.ok(reset.index < gate.index, "the reset runs before the surface gate returns");
});

test("the timeline's Ctrl/Cmd+J stands down in a surface", () => {
  const timeline = code("timeline", "ChatTimeline.tsx");
  assert.match(timeline, importsFromSurfaces("insideKeyboardSurface"));
  const listener = listenerDoing(
    timeline,
    "onKeyDown",
    'window.addEventListener("keydown", onKeyDown, true)',
    '"scroll-to-end"'
  );
  const gate = gateLine("insideKeyboardSurface").exec(listener);
  assert.ok(gate, "the scroll-to-end listener calls insideKeyboardSurface(event.target) and returns");
  assert.ok(gate.index < listener.indexOf("resolveChatShortcut(event)"), "before the chord is resolved");
});

test("the question card's digits stand down for a key some surface owns, before one is read", () => {
  const card = code("banners", "QuestionCard.tsx");
  assert.match(card, importsFromSurfaces("insideKeyboardOwner"));
  const listener = listenerDoing(card, "handler", 'document.addEventListener("keydown", handler)', "questionShortcutOption(");
  const gate = gateLine("insideKeyboardOwner").exec(listener);
  assert.ok(gate, "the digit listener calls insideKeyboardOwner(event.target) and returns");
  assert.ok(gate.index < listener.indexOf("questionShortcutOption("), "before the digit is read — an answer is final");
});
