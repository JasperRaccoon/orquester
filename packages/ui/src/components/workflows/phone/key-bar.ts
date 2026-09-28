/**
 * The key bar over a phone's soft keyboard (workflows spec §7.4): the
 * characters a code, shell or prompt editor needs that a phone keyboard hides
 * behind a layer switch, plus `{{` for a template expression and Tab. Pure:
 * what a key inserts and where the caret lands.
 */

export interface KeyBarKey {
  id: string;
  /** What the button shows. */
  label: string;
  /** Its accessible name. */
  title: string;
}

const CHARS = ["{", "}", "(", ")", "[", "]", ";", ":", '"', "'", "=", "<", ">", "/", "\\", "|", "$"];

const NAMES: Record<string, string> = {
  "{": "Open brace",
  "}": "Close brace",
  "(": "Open parenthesis",
  ")": "Close parenthesis",
  "[": "Open bracket",
  "]": "Close bracket",
  ";": "Semicolon",
  ":": "Colon",
  '"': "Double quote",
  "'": "Single quote",
  "=": "Equals",
  "<": "Less than",
  ">": "Greater than",
  "/": "Slash",
  "\\": "Backslash",
  "|": "Pipe",
  $: "Dollar"
};

/** The keys, in order: Tab, the `{{ }}` expression, then the characters. */
export function keyBarKeys(options: { templates?: boolean } = {}): KeyBarKey[] {
  const keys: KeyBarKey[] = [{ id: "tab", label: "Tab", title: "Tab (indent)" }];
  if (options.templates !== false) keys.push({ id: "expr", label: "{{ }}", title: "Insert a {{ expression }}" });
  for (const char of CHARS) keys.push({ id: char, label: char, title: NAMES[char] ?? char });
  return keys;
}

/** What a key inserts: the text, and where in it the caret goes. */
export function keyBarInsertion(id: string, indent = "  "): { text: string; caret: number } {
  if (id === "tab") return { text: indent, caret: indent.length };
  if (id === "expr") return { text: "{{  }}", caret: 3 };
  return { text: id, caret: id.length };
}

/**
 * The edit a key makes to `text` with the selection `[from, to)`: the
 * selection is replaced — except that `{{ }}` wraps a selection, the caret
 * then after it.
 */
export function applyKeyBarKey(
  text: string,
  from: number,
  to: number,
  id: string,
  indent = "  "
): { text: string; selection: number } {
  const start = Math.max(0, Math.min(from, to, text.length));
  const end = Math.min(text.length, Math.max(from, to));
  if (id === "expr" && end > start) {
    const inner = text.slice(start, end);
    const wrapped = `{{ ${inner} }}`;
    return { text: text.slice(0, start) + wrapped + text.slice(end), selection: start + wrapped.length };
  }
  const insertion = keyBarInsertion(id, indent);
  return { text: text.slice(0, start) + insertion.text + text.slice(end), selection: start + insertion.caret };
}
