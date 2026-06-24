import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, GripVertical, ListTodo, Plus, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ConfirmDialog } from "../ui";
import { EmptyState } from "../main/EmptyState";
import { useTodoDoc } from "../../hooks/use-todo-doc";
import type { TodoItem } from "./todo-markdown";

interface TodoViewProps {
  todoId: string;
  active: boolean;
}

/** Sentinel id for the trailing "add a to-do" line in the focus map. */
const ADD = "__add__";

/**
 * A Notion-style checklist. Every row is an always-editable input so the whole
 * list behaves like one text surface:
 *   - Enter splits the current item at the caret and starts a new one below.
 *   - Backspace at the start of a line merges it into the previous line (so
 *     backspacing an empty line deletes it and lands the caret on the one above).
 *   - Arrow Up/Down move the caret between lines.
 *   - Cmd/Ctrl+Enter toggles the checkbox.
 * Focus moves are queued in `pendingFocus` and applied after the relevant
 * render in a layout effect, since item mutations go through async state.
 */
export const TodoView: React.FC<TodoViewProps> = ({ todoId, active }) => {
  const { record, items, setItems, saving } = useTodoDoc(todoId, active);
  const [hideDone, setHideDone] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);

  // Live DOM inputs keyed by item id, plus a queued focus request applied after render.
  const inputs = useRef(new Map<string, HTMLInputElement>());

  // Move the caret to a row that already exists in the DOM, right now. Used for pure
  // navigation (arrows, add-line backspace) that doesn't mutate the list — there's no
  // re-render to hang a deferred focus on, so anything queued would silently never fire.
  const focusNow = (id: string, caret: number | "end") => {
    const el = id === ADD ? addRef.current : inputs.current.get(id);
    if (!el) return;
    el.focus();
    const pos = caret === "end" ? el.value.length : caret;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      /* setSelectionRange throws on some input types; harmless here */
    }
  };

  // Focus that must wait for a setItems-driven re-render: the target row is created or
  // removed by the same edit, so it may not exist (or hold its final value) until after
  // the commit. Queue it; the layout effect applies it once the row is in the DOM.
  const pendingFocus = useRef<{ id: string; caret: number | "end" } | null>(null);
  const focusLater = (id: string, caret: number | "end") => {
    pendingFocus.current = { id, caret };
  };
  useLayoutEffect(() => {
    const req = pendingFocus.current;
    if (!req) return;
    pendingFocus.current = null;
    focusNow(req.id, req.caret);
  });

  // Focus the inline "add a to-do" line when this tab becomes the focused one.
  useEffect(() => {
    if (active) addRef.current?.focus();
  }, [active]);

  const completedCount = useMemo(() => items.filter((i) => i.checked).length, [items]);
  const visible = hideDone ? items.filter((i) => !i.checked) : items;

  if (!record) {
    return <EmptyState icon={<ListTodo size={40} strokeWidth={1.25} />} title="This list was deleted." description="" />;
  }

  const toggle = (id: string) =>
    setItems(items.map((i) => (i.id === id ? { ...i, checked: !i.checked } : i)));
  const remove = (id: string) => setItems(items.filter((i) => i.id !== id));
  const updateText = (id: string, text: string) =>
    setItems(items.map((i) => (i.id === id ? { ...i, text } : i)));
  const reorder = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = [...items];
    const from = next.findIndex((i) => i.id === dragId);
    const to = next.findIndex((i) => i.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next);
  };

  const onItemKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, item: TodoItem) => {
    const el = e.currentTarget;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const visIdx = visible.findIndex((v) => v.id === item.id);

    // Cmd/Ctrl+Enter → toggle done (Notion's shortcut), keep the caret where it is.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      toggle(item.id);
      return;
    }

    // Enter → split at the caret; the text after the caret becomes a new line below.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const before = item.text.slice(0, start);
      const after = item.text.slice(end);
      const newItem: TodoItem = { id: crypto.randomUUID(), checked: false, text: after };
      const idx = items.findIndex((i) => i.id === item.id);
      const next = items.map((i) => (i.id === item.id ? { ...i, text: before } : i));
      next.splice(idx + 1, 0, newItem);
      setItems(next);
      focusLater(newItem.id, 0);
      return;
    }

    // Backspace at the very start → merge this line into the previous one (or, if it's the
    // first line and empty, just delete it and move to the next).
    if (e.key === "Backspace" && start === 0 && end === 0) {
      if (visIdx > 0) {
        e.preventDefault();
        const prev = visible[visIdx - 1];
        const caretPos = prev.text.length;
        const next = items
          .map((i) => (i.id === prev.id ? { ...i, text: prev.text + item.text } : i))
          .filter((i) => i.id !== item.id);
        setItems(next);
        focusLater(prev.id, caretPos);
      } else if (item.text === "") {
        e.preventDefault();
        const nextVisible = visible[visIdx + 1];
        setItems(items.filter((i) => i.id !== item.id));
        focusLater(nextVisible ? nextVisible.id : ADD, nextVisible ? 0 : "end");
      }
      return;
    }

    if (e.key === "ArrowUp" && visIdx > 0) {
      e.preventDefault();
      focusNow(visible[visIdx - 1].id, start);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextVisible = visible[visIdx + 1];
      focusNow(nextVisible ? nextVisible.id : ADD, nextVisible ? start : "end");
    }
  };

  const onAddKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && adding.trim()) {
      e.preventDefault();
      const item: TodoItem = { id: crypto.randomUUID(), checked: false, text: adding.trim() };
      setItems([...items, item]);
      setAdding("");
      focusLater(item.id, "end"); // caret rides into the new to-do (Enter again splits from there)
      return;
    }
    // Empty add line: Backspace or ArrowUp steps back up into the last item.
    if ((e.key === "Backspace" && adding === "") || e.key === "ArrowUp") {
      if (visible.length > 0) {
        e.preventDefault();
        focusNow(visible[visible.length - 1].id, "end");
      }
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-900/40 px-3">
        <ListTodo size={14} className="text-neutral-500" />
        <span className="flex-1 truncate text-sm text-neutral-200">{record.name}</span>
        {saving ? <span className="text-xs text-neutral-600">saving…</span> : null}
        <button
          type="button"
          onClick={() => setHideDone((v) => !v)}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800"
        >
          {hideDone ? <EyeOff size={13} /> : <Eye size={13} />}
          {hideDone ? "Show done" : "Hide done"}
        </button>
        <button
          type="button"
          disabled={completedCount === 0}
          onClick={() => setConfirmClear(true)}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
        >
          Clear completed
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <ul className="flex flex-col">
          {visible.map((item: TodoItem) => (
            <li
              key={item.id}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                reorder(item.id);
                setDragId(null);
              }}
              className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-900"
            >
              <span
                draggable
                onDragStart={() => setDragId(item.id)}
                onDragEnd={() => setDragId(null)}
                className="flex shrink-0 cursor-grab items-center text-neutral-700 opacity-0 group-hover:opacity-100"
              >
                <GripVertical size={13} />
              </span>
              <input
                type="checkbox"
                checked={item.checked}
                onChange={() => toggle(item.id)}
                className="h-3.5 w-3.5 shrink-0 accent-neutral-400"
              />
              <input
                ref={(el) => {
                  if (el) inputs.current.set(item.id, el);
                  else inputs.current.delete(item.id);
                }}
                value={item.text}
                placeholder="To-do"
                onChange={(e) => updateText(item.id, e.target.value)}
                onKeyDown={(e) => onItemKeyDown(e, item)}
                className={cn(
                  "flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-700",
                  item.checked ? "text-neutral-500 line-through" : "text-neutral-200"
                )}
              />
              <button
                type="button"
                aria-label="Delete item"
                onClick={() => remove(item.id)}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-600 opacity-0 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
          <li className="flex items-center gap-2 rounded px-1 py-1">
            <span className="w-3.5 shrink-0" aria-hidden />
            <Plus size={14} className="shrink-0 text-neutral-600" />
            <input
              ref={addRef}
              value={adding}
              placeholder="Add a to-do…"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={onAddKeyDown}
              className="flex-1 bg-transparent text-sm text-neutral-200 outline-none placeholder:text-neutral-600"
            />
          </li>
        </ul>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear completed items"
        message={`Clear ${completedCount} completed ${completedCount === 1 ? "item" : "items"}?`}
        confirmLabel="Clear"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setItems(items.filter((i) => !i.checked));
          setConfirmClear(false);
        }}
      />
    </div>
  );
};
