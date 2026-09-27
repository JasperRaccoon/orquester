import test from "node:test";
import assert from "node:assert/strict";

import {
  chatEscapeSequenceStep,
  chatEscapeTargetGate,
  isEditableTarget,
  isIdleChatEscape,
  resolveChatEscape,
  type ChatEscapeInput,
  type EscapeTargetLike
} from "./escape-action.ts";
import { composerEscapeAction, composerOwnsEscape } from "./composer/tab-visibility.ts";

const base: ChatEscapeInput = {
  key: "Escape",
  defaultPrevented: false,
  isActiveTab: true,
  blockingLayerOpen: false,
  insideComposer: false,
  editableOutsideChat: false,
  drillInOpen: false,
  turnActive: false,
  repeat: false,
  secondPress: false,
  rewindAvailable: false
};

test("Escape leaves the drill-in — the case a React root handler could not see", () => {
  // The repro: open a drill-in, click a non-focusable row, `activeElement` is
  // `<body>`, and a handler on the chat root never fires again.
  assert.equal(resolveChatEscape({ ...base, drillInOpen: true }), "close-drill-in");
});

test("the drill-in wins over the interrupt", () => {
  // "Take me back", not "stop the agent": leaving a child view is the narrower
  // and reversible action. Getting this backwards is what the two competing
  // window listeners produced.
  assert.equal(
    resolveChatEscape({ ...base, drillInOpen: true, turnActive: true }),
    "close-drill-in"
  );
});

test("Escape interrupts a running turn from anywhere in the tab", () => {
  assert.equal(resolveChatEscape({ ...base, turnActive: true }), "interrupt");
});

test("Escape does nothing with no drill-in and no turn", () => {
  assert.equal(resolveChatEscape(base), "ignore");
});

test("a hidden tab never acts, whatever it is doing", () => {
  // Every chat tab stays mounted (§7.1), so without this one Escape would stop
  // an agent in a thread the user cannot see.
  assert.equal(
    resolveChatEscape({ ...base, isActiveTab: false, turnActive: true }),
    "ignore"
  );
  assert.equal(
    resolveChatEscape({ ...base, isActiveTab: false, drillInOpen: true }),
    "ignore"
  );
});

test("a blocking layer keeps the key: Escape closes the modal, not the thread", () => {
  assert.equal(
    resolveChatEscape({ ...base, blockingLayerOpen: true, turnActive: true }),
    "ignore"
  );
});

test("focus inside the composer belongs to the composer's own arm, not this one", () => {
  assert.equal(
    resolveChatEscape({ ...base, insideComposer: true, turnActive: true }),
    "ignore"
  );
  assert.equal(
    resolveChatEscape({ ...base, insideComposer: true, drillInOpen: true }),
    "ignore"
  );
});

test("an event another listener already handled is not handled twice", () => {
  assert.equal(
    resolveChatEscape({ ...base, defaultPrevented: true, turnActive: true }),
    "ignore"
  );
});

test("a held Escape is one press: its auto-repeat never stops the turn the first press spared", () => {
  // Hold Escape to close the output viewer: the first keydown is the viewer's,
  // and ~500 ms later the repeats arrive with nothing left open — each one
  // stopped the running turn. The same after leaving a drill-in: the child
  // closed, then the repeat stopped the parent.
  assert.equal(resolveChatEscape({ ...base, repeat: true, turnActive: true }), "ignore");
  assert.equal(resolveChatEscape({ ...base, repeat: true, drillInOpen: true }), "ignore");
  assert.equal(
    resolveChatEscape({ ...base, repeat: true, drillInOpen: true, turnActive: true }),
    "ignore"
  );
});

test("only Escape", () => {
  for (const key of ["Enter", "Esc", "escape", "a", ""]) {
    assert.equal(resolveChatEscape({ ...base, key, drillInOpen: true }), "ignore", key);
  }
});

// ---------------------------------------------------------------------------
// The double Escape — the CLI's "jump to a previous message" (§5.5)
// ---------------------------------------------------------------------------

const rewindReady: ChatEscapeInput = { ...base, secondPress: true, rewindAvailable: true };

test("a second idle Escape opens the rewind picker", () => {
  assert.equal(resolveChatEscape(rewindReady), "rewind");
});

test("the first idle Escape does nothing — it is only half of the gesture", () => {
  assert.equal(resolveChatEscape({ ...rewindReady, secondPress: false }), "ignore");
});

test("no message to go back to, no picker", () => {
  assert.equal(resolveChatEscape({ ...rewindReady, rewindAvailable: false }), "ignore");
});

test("the double press never outranks leaving a drill-in or stopping a turn", () => {
  // The rewind is what an IDLE Escape does. A second press that lands while a
  // drill-in is open still just leaves it, and one that lands during a turn
  // still just stops it — never both, and never the rewind instead.
  assert.equal(resolveChatEscape({ ...rewindReady, drillInOpen: true }), "close-drill-in");
  assert.equal(resolveChatEscape({ ...rewindReady, turnActive: true }), "interrupt");
  assert.equal(
    resolveChatEscape({ ...rewindReady, drillInOpen: true, turnActive: true }),
    "close-drill-in"
  );
});

test("the rewind obeys every gate the other two do", () => {
  // A hidden tab, a modal, the composer's own scope, an already-handled event
  // and a held key each keep the key away from this side, whatever the
  // sequence says.
  assert.equal(resolveChatEscape({ ...rewindReady, repeat: true }), "ignore");
  assert.equal(resolveChatEscape({ ...rewindReady, isActiveTab: false }), "ignore");
  assert.equal(resolveChatEscape({ ...rewindReady, blockingLayerOpen: true }), "ignore");
  assert.equal(resolveChatEscape({ ...rewindReady, insideComposer: true }), "ignore");
  assert.equal(resolveChatEscape({ ...rewindReady, defaultPrevented: true }), "ignore");
  for (const key of ["Enter", "Esc", "escape", "a", ""]) {
    assert.equal(resolveChatEscape({ ...rewindReady, key }), "ignore", key);
  }
});

/** Every boolean combination of the input (and a non-Escape twin of each). */
function everyEscapeInput(): ChatEscapeInput[] {
  const flags = [
    "defaultPrevented",
    "isActiveTab",
    "blockingLayerOpen",
    "insideComposer",
    "editableOutsideChat",
    "drillInOpen",
    "turnActive",
    "repeat",
    "secondPress",
    "rewindAvailable"
  ] as const;
  const inputs: ChatEscapeInput[] = [];
  for (let mask = 0; mask < 1 << flags.length; mask += 1) {
    const input: ChatEscapeInput = { ...base };
    flags.forEach((flag, bit) => {
      input[flag] = (mask & (1 << bit)) !== 0;
    });
    inputs.push(input, { ...input, key: "Enter" });
  }
  return inputs;
}

test("under an open layer the shell does nothing, whatever the drill-in, the turn or the sequence", () => {
  // `blockingLayerOpen` is `anotherLayerOwnsTheKeyboard()`, which sees every
  // layer that closes on Escape — the output viewer, the context meter's
  // panel, a composer popover, a sheet, a menu (`lib/open-layers.ts`). Before
  // it did, the first Escape under the viewer stopped the turn; in a drill-in
  // it closed the child behind the viewer, and the second stopped the parent.
  for (const input of everyEscapeInput()) {
    if (!input.blockingLayerOpen) continue;
    assert.equal(resolveChatEscape(input), "ignore", JSON.stringify(input));
    assert.equal(
      chatEscapeSequenceStep(input),
      input.repeat ? "keep" : "reset",
      JSON.stringify(input)
    );
  }
});

test("the rewind is returned exactly for an idle second press with somewhere to go", () => {
  for (const input of everyEscapeInput()) {
    assert.equal(
      resolveChatEscape(input) === "rewind",
      isIdleChatEscape(input) && input.secondPress && input.rewindAvailable,
      JSON.stringify(input)
    );
  }
});

test("the two new inputs change nothing but the idle case", () => {
  // Every rule that existed before the double press still answers the same:
  // with the pair switched off the result is never "rewind", and switching it
  // on only ever turns an idle "ignore" into "rewind".
  for (const input of everyEscapeInput()) {
    const without = resolveChatEscape({ ...input, secondPress: false, rewindAvailable: false });
    assert.notEqual(without, "rewind");
    const withPair = resolveChatEscape(input);
    if (withPair !== without) {
      assert.equal(without, "ignore", JSON.stringify(input));
      assert.equal(withPair, "rewind", JSON.stringify(input));
      assert.ok(isIdleChatEscape(input), JSON.stringify(input));
    }
  }
});

test("an idle Escape is exactly the one this side would otherwise ignore for doing nothing", () => {
  assert.equal(isIdleChatEscape(base), true);
  assert.equal(isIdleChatEscape({ ...base, key: "Enter" }), false);
  assert.equal(isIdleChatEscape({ ...base, defaultPrevented: true }), false);
  assert.equal(isIdleChatEscape({ ...base, isActiveTab: false }), false);
  assert.equal(isIdleChatEscape({ ...base, blockingLayerOpen: true }), false);
  assert.equal(isIdleChatEscape({ ...base, insideComposer: true }), false);
  assert.equal(isIdleChatEscape({ ...base, editableOutsideChat: true }), false);
  assert.equal(isIdleChatEscape({ ...base, drillInOpen: true }), false);
  assert.equal(isIdleChatEscape({ ...base, turnActive: true }), false);
  // A held key's repeat is not a new Escape at all, idle or not.
  assert.equal(isIdleChatEscape({ ...base, repeat: true }), false);
});

const step = (overrides: Partial<Parameters<typeof chatEscapeSequenceStep>[0]>) =>
  chatEscapeSequenceStep({ ...base, ...overrides });

test("only an idle Escape is pressed into the double-press sequence", () => {
  assert.equal(step({}), "press");
});

test("an Escape that did something else starts the count over", () => {
  // Stopping a turn and then, a moment later, pressing Escape on the settled
  // thread is not a double press — the first one was the interrupt.
  assert.equal(step({ turnActive: true }), "reset");
  assert.equal(step({ drillInOpen: true }), "reset");
  assert.equal(step({ blockingLayerOpen: true }), "reset");
  assert.equal(step({ defaultPrevented: true }), "reset");
  assert.equal(step({ isActiveTab: false }), "reset");
  // The composer counts its own Escapes; this side never counts them too.
  assert.equal(step({ insideComposer: true }), "reset");
});

test("an Escape a composer popover takes to close itself is not half of a rewind", () => {
  // The panel is portaled to <body>, outside the composer shell, so by its
  // target it looks idle — but the popover is an open layer, and the layer
  // gate is what says so (it used to be a selector on the target).
  assert.equal(step({ blockingLayerOpen: true }), "reset");
  assert.equal(resolveChatEscape({ ...rewindReady, blockingLayerOpen: true }), "ignore");
});

test("any other key between two Escapes breaks the sequence", () => {
  assert.equal(step({ key: "a" }), "reset");
  assert.equal(step({ key: "Enter" }), "reset");
});

test("holding Escape is one press, and its auto-repeat breaks nothing either", () => {
  assert.equal(step({ repeat: true }), "keep");
  assert.equal(step({ repeat: true, key: "a" }), "keep");
  assert.equal(step({ repeat: true, turnActive: true }), "keep");
});

// ---------------------------------------------------------------------------
// Where the Escape landed: a field outside this chat is that field's own
// ---------------------------------------------------------------------------

/** The chat whose shell is asking; "thread-2" sits in the next grid cell. */
const THIS_CHAT = "thread-1";

/**
 * An element as the gate reads one: its tag, an input's type, whether it sits
 * in an editing host, and the chat root and composer shell around it, each
 * carrying its thread id as the DOM does (`data-agent-chat`,
 * `data-agent-chat-composer-shell`). Its `closest` walks those ancestors,
 * nearest first, the way the DOM's does for an attribute selector — and
 * refuses any other selector, so a change in what the gate asks shows here.
 */
function element(
  tagName: string,
  options: { type?: string; contentEditable?: boolean; chat?: string; composer?: string } = {}
): EscapeTargetLike {
  const ancestors: Array<Record<string, string>> = [
    ...(options.composer !== undefined
      ? [{ "data-agent-chat-composer-shell": options.composer }]
      : []),
    ...(options.chat !== undefined ? [{ "data-agent-chat": options.chat }] : [])
  ];
  return {
    tagName,
    ...(options.type !== undefined ? { type: options.type } : {}),
    isContentEditable: options.contentEditable === true,
    closest: (selector: string) => {
      const attribute = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
      if (attribute === undefined) throw new Error(`unexpected selector ${selector}`);
      const found = ancestors.find((attributes) => attribute in attributes);
      return found ? { getAttribute: (name: string) => found[name] ?? null } : null;
    }
  };
}

/** The gate for an Escape landing on `target` in this chat, with the rest of the state given. */
function gateAt(
  target: EscapeTargetLike | null,
  state: Partial<ChatEscapeInput> = {}
): ChatEscapeInput {
  return { ...base, ...chatEscapeTargetGate(target, THIS_CHAT), ...state };
}

/** Every thing the shell could otherwise do: leave, stop, rewind. */
const ACTIVE_STATES: ReadonlyArray<Partial<ChatEscapeInput>> = [
  { turnActive: true },
  { drillInOpen: true },
  { drillInOpen: true, turnActive: true },
  { secondPress: true, rewindAvailable: true }
];

test("a text field, a select or an editor takes its own keys; a button, a checkbox or the page does not", () => {
  const editable: Array<[string, EscapeTargetLike]> = [
    ["an input with no type", element("INPUT")],
    ["a text input", element("INPUT", { type: "text" })],
    ["a search input", element("INPUT", { type: "search" })],
    ["a password input", element("INPUT", { type: "password" })],
    ["a textarea (xterm's helper included)", element("TEXTAREA")],
    ["a select", element("SELECT")],
    ["an editing host (CodeMirror's .cm-content)", element("DIV", { contentEditable: true })],
    ["an element inside an editing host", element("SPAN", { contentEditable: true })]
  ];
  for (const [name, target] of editable) {
    assert.equal(isEditableTarget(target), true, name);
  }
  const notEditable: Array<[string, EscapeTargetLike | null]> = [
    ["the page", element("BODY")],
    ["a button", element("BUTTON")],
    ["a plain div", element("DIV")],
    ["no target", null]
  ];
  for (const [name, target] of notEditable) {
    assert.equal(isEditableTarget(target), false, name);
  }
});

test("an input that takes no text is not a field, whatever its type", () => {
  // Every type the HTML spec gives an <input> that no one types text into.
  // Escape means nothing to any of them, so the chat keeps it — and a type
  // dropped from the classifier's list would silently start swallowing it.
  for (const type of [
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit"
  ]) {
    assert.equal(isEditableTarget(element("INPUT", { type })), false, type);
  }
});

test("an Escape typed into a field outside this chat is that field's: nothing here, and Esc Esc starts over", () => {
  // The tab strip's rename box, the sidebar's name field, a terminal, a file
  // editor. This listener runs first and stops the event when it acts, so
  // Escape in the rename box stopped the running turn (or left the drill-in)
  // and the box never cancelled.
  const fields: Array<[string, EscapeTargetLike]> = [
    ["the tab strip's rename box", element("INPUT", { type: "text" })],
    ["a terminal's textarea", element("TEXTAREA")],
    ["a file editor", element("DIV", { contentEditable: true })]
  ];
  for (const [name, field] of fields) {
    assert.deepEqual(
      chatEscapeTargetGate(field, THIS_CHAT),
      { insideComposer: false, editableOutsideChat: true },
      name
    );
    for (const state of ACTIVE_STATES) {
      const input = gateAt(field, state);
      assert.equal(resolveChatEscape(input), "ignore", `${name} ${JSON.stringify(state)}`);
      assert.equal(chatEscapeSequenceStep(input), "reset", `${name} ${JSON.stringify(state)}`);
    }
  }
});

test("the same field inside this chat's composer keeps the composer's rules", () => {
  // The composer's own textarea: the shell hands it over as before, and the
  // composer resolves it as it always has — the drill-in first (S6).
  const textarea = element("TEXTAREA", { composer: THIS_CHAT, chat: THIS_CHAT });
  assert.deepEqual(chatEscapeTargetGate(textarea, THIS_CHAT), {
    insideComposer: true,
    editableOutsideChat: false
  });
  for (const state of ACTIVE_STATES) {
    assert.equal(resolveChatEscape(gateAt(textarea, state)), "ignore", JSON.stringify(state));
  }
  const composer = {
    repeat: false,
    menuOpen: false,
    layerOpen: false,
    drillInOpen: false,
    isTurnActive: true
  };
  assert.equal(composerEscapeAction(composer), "interrupt");
  assert.equal(composerEscapeAction({ ...composer, drillInOpen: true }), "leave-drill-in");
  // …and the composer's window arm leaves the textarea to its own handler.
  assert.equal(
    composerOwnsEscape({
      defaultPrevented: false,
      insideComposerShell: true,
      isTextarea: true,
      isTurnActive: true,
      drillInOpen: false,
      layerOpen: false
    }),
    false
  );
});

test("a field inside this chat but outside its composer keeps today's rules", () => {
  // The question card's custom answer, in the banner dock above the composer:
  // it is this chat's own, so Escape there still leaves the drill-in first and
  // otherwise stops the turn.
  const answer = element("INPUT", { type: "text", chat: THIS_CHAT });
  assert.deepEqual(chatEscapeTargetGate(answer, THIS_CHAT), {
    insideComposer: false,
    editableOutsideChat: false
  });
  assert.equal(resolveChatEscape(gateAt(answer, { drillInOpen: true, turnActive: true })), "close-drill-in");
  assert.equal(resolveChatEscape(gateAt(answer, { turnActive: true })), "interrupt");
});

test("in the grid, another chat's composer and answer field are that chat's, not this one's", () => {
  // Two chat tabs side by side; this one is the active tab. Whose chat a
  // field belongs to is decided by its thread id, not by being in some chat:
  // the next cell's composer and question card are outside THIS chat, so an
  // Escape typed there is theirs — it never stops this chat's turn.
  const theirComposer = element("TEXTAREA", { composer: "thread-2", chat: "thread-2" });
  const theirAnswer = element("INPUT", { type: "text", chat: "thread-2" });
  for (const [name, target] of [
    ["their composer", theirComposer],
    ["their answer field", theirAnswer]
  ] as const) {
    assert.deepEqual(
      chatEscapeTargetGate(target, THIS_CHAT),
      { insideComposer: false, editableOutsideChat: true },
      name
    );
    assert.equal(resolveChatEscape(gateAt(target, { turnActive: true })), "ignore", name);
  }
  // To their own chat's shell, each is its own again.
  assert.deepEqual(chatEscapeTargetGate(theirComposer, "thread-2"), {
    insideComposer: true,
    editableOutsideChat: false
  });
  assert.deepEqual(chatEscapeTargetGate(theirAnswer, "thread-2"), {
    insideComposer: false,
    editableOutsideChat: false
  });
});

test("a target that takes no text keeps today's rules, inside this chat or out", () => {
  // The page itself (focus falls to <body> after a click elsewhere), and a
  // timeline button.
  const targets: Array<[string, EscapeTargetLike | null]> = [
    ["the page", element("BODY")],
    ["a timeline button", element("BUTTON", { chat: THIS_CHAT })],
    ["no target", null]
  ];
  for (const [name, target] of targets) {
    assert.deepEqual(
      chatEscapeTargetGate(target, THIS_CHAT),
      { insideComposer: false, editableOutsideChat: false },
      name
    );
    assert.equal(resolveChatEscape(gateAt(target, { drillInOpen: true })), "close-drill-in", name);
    assert.equal(resolveChatEscape(gateAt(target, { turnActive: true })), "interrupt", name);
    assert.equal(
      resolveChatEscape(gateAt(target, { secondPress: true, rewindAvailable: true })),
      "rewind",
      name
    );
    assert.equal(chatEscapeSequenceStep(gateAt(target)), "press", name);
  }
});

test("an Escape a field outside this chat owns is never acted on, whatever else is true", () => {
  for (const input of everyEscapeInput()) {
    if (!input.editableOutsideChat) continue;
    assert.equal(resolveChatEscape(input), "ignore", JSON.stringify(input));
    assert.equal(isIdleChatEscape(input), false, JSON.stringify(input));
  }
});
