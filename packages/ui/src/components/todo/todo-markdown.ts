export interface TodoItem {
  /** Render-only stable key for list/drag. Never serialized; regenerated on each parse. */
  id: string;
  checked: boolean;
  text: string;
}

const TASK_LINE = /^\s*[-*]\s+\[([ xX])\]\s?(.*)$/;

/** Parse GitHub task-list markdown into items. Non-task lines are ignored. */
export function parseTodoMarkdown(body: string): TodoItem[] {
  const items: TodoItem[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    items.push({ id: crypto.randomUUID(), checked: m[1] === "x" || m[1] === "X", text: m[2] });
  }
  return items;
}

/** Serialize items to "- [ ] text" / "- [x] text", one per line, no trailing blank line. */
export function serializeTodoMarkdown(items: TodoItem[]): string {
  return items.map((i) => `- [${i.checked ? "x" : " "}] ${i.text}`).join("\n");
}
