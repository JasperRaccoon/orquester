/**
 * Every portaled overlay that closes on Escape holds a keyboard layer while it
 * is open (`lib/keyboard-layers.ts`), and the chat's popovers close when the
 * visible chat tab changes (fix rounds 1–2, final wave).
 *
 * A SOURCE check, like `agent-chat/command-rejections.check.ts`, because the
 * wiring is made of effects and nothing here can run one: there is no DOM
 * under node, and static rendering runs no effect (and cannot render a portal
 * at all). What has to be prevented is the wiring disappearing — then an
 * Escape meant for the overlay goes back to interrupting a running chat turn
 * and the overlay stays open, or a thread's popover strands over the next
 * tab. The registry, the gate, the resolvers and the dismiss subscription are
 * tested behaviourally (`lib/keyboard-layers.test.ts`,
 * `agent-chat/escape-layers.test.ts`, `ui/dropdown-logic.test.ts`).
 *
 * Comments are stripped before anything is matched, so a commented-out call
 * never passes for a live one.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|check)\.tsx?$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The code without its comments: block comments, then line comments (not the
 * `//` of a `scheme://` inside a string, which is the one `//` these files
 * could plausibly hold in code).
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const code = (path: string): string => stripComments(readFileSync(path, "utf8"));
const posix = (path: string): string => relative(srcRoot, path).split("\\").join("/");

/**
 * How each overlay holds its layer: with its own open state — or `true` for
 * the one mounted only while open. An overlay not listed here must hold it
 * with its open state too.
 */
const LAYER_ARGUMENT: Readonly<Record<string, "open" | "true">> = {
  "components/agent-chat/composer/ComposerPopover.tsx": "open",
  "components/ui/context-menu.tsx": "true",
  "components/ui/dropdown.tsx": "open",
  "components/ui/modal.tsx": "open",
  "components/ui/sheet.tsx": "open"
};

/** Exactly the calls a file makes, argument by argument. */
const layerCalls = (source: string): string[] =>
  [...source.matchAll(/\buseKeyboardLayer\(\s*([^)]*?)\s*\)/g)].map((match) => match[1]!);

test("stripping comments leaves code and drops both kinds of comment", () => {
  assert.equal(
    stripComments('a(); // useKeyboardLayer(open);\n/* useKeyboardLayer(open); */ b("http://x");'),
    'a(); \n b("http://x");'
  );
});

test("the hook holds the layer while open and releases it on close and on unmount", () => {
  // The effect returns the registration's own release as its cleanup, keyed
  // on `open`: closing (open → false) and unmounting both run it.
  const hook = code(join(srcRoot, "hooks", "use-keyboard-layer.ts"));
  assert.match(hook, /useEffect\(\(\) => \(open \? openKeyboardLayer\(\) : undefined\), \[open\]\)/);
});

test("each overlay holds its layer with the right argument — one live call, never commented out", () => {
  for (const [file, argument] of Object.entries(LAYER_ARGUMENT)) {
    assert.deepEqual(layerCalls(code(join(srcRoot, file))), [argument], `${file} holds useKeyboardLayer(${argument})`);
  }
});

test("every portaled overlay that closes on Escape holds one — the palette is read by the gate by name", () => {
  const overlays = sourceFiles(srcRoot).filter((file) => {
    const text = code(file);
    return text.includes("createPortal(") && /["']Escape["']/.test(text);
  });
  const names = overlays.map(posix).sort();
  // A rename or a refactor must not empty the set silently.
  for (const expected of Object.keys(LAYER_ARGUMENT)) {
    assert.ok(names.includes(expected), `${expected} is still recognised as an overlay`);
  }
  const gate = code(join(srcRoot, "components", "attention", "GlobalShortcutListener.tsx"));
  assert.match(gate, /isCommandPaletteOpen\(\)/, "the palette is on the gate's list by name");
  assert.match(gate, /keyboardLayerOpen\(\)/, "and so is every registered layer");
  const wrong = overlays
    .filter((file) => !file.endsWith("CommandPalette.tsx"))
    .filter((file) => {
      const expected = LAYER_ARGUMENT[posix(file)] ?? "open";
      const calls = layerCalls(code(file));
      return calls.length !== 1 || calls[0] !== expected;
    })
    .map(posix);
  assert.deepEqual(wrong, [], "an overlay that closes on Escape without holding its keyboard layer");
});

test("final wave (2): the Dropdown closes on its dismiss event while open, and the chat's popovers ask for it", () => {
  const dropdown = code(join(here, "dropdown.tsx"));
  assert.match(
    dropdown,
    /useEffect\(\s*\(\) => dropdownDismissSubscription\(open, dismissOn, dismissQuietly\),\s*\[open, dismissOn, dismissQuietly\]\s*\)/,
    "subscribed while open, unsubscribed on close and unmount"
  );
  // The goal popover asks through `goalPopoverProps(sessionId)`
  // (goal-chip.test.ts); the context meter, whose Compact button is bound to
  // its own thread, asks here — both for the tab being LEFT (micro-fix), and
  // the status line hands both their session.
  const status = join(srcRoot, "components", "agent-chat", "status");
  assert.match(code(join(status, "ContextMeter.tsx")), /dismissWhenChatTabLeaves\(sessionId \?\? null\)/);
  assert.match(code(join(status, "GoalChip.tsx")), /goalPopoverProps\(sessionId \?\? null\)/);
  const line = code(join(status, "ChatStatusLine.tsx"));
  assert.match(line, /<GoalChip\s[^>]*sessionId=\{sessionId\}/);
  assert.match(line, /<ContextMeter\s[^>]*sessionId=\{sessionId\}/);
});

test("micro-fix: the composer's popover closes on its thread being LEFT — the same rule", () => {
  const popover = code(join(srcRoot, "components", "agent-chat", "composer", "ComposerPopover.tsx"));
  assert.match(popover, /dismissWhenChatTabLeaves\(ownChatSessionOf\(triggerRef\.current\)\)/);
  assert.doesNotMatch(popover, /subscribeActiveChatTab\(/, "no bare subscription left behind");
});
