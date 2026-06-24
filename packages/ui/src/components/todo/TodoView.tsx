import React, { useEffect, useMemo, useRef, useState } from "react";
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

export const TodoView: React.FC<TodoViewProps> = ({ todoId, active }) => {
  const { record, items, setItems, saving } = useTodoDoc(todoId, active);
  const [hideDone, setHideDone] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const addRef = useRef<HTMLInputElement>(null);

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
  const commitEdit = (id: string, text: string) => {
    const t = text.trim();
    setItems(t ? items.map((i) => (i.id === id ? { ...i, text: t } : i)) : items.filter((i) => i.id !== id));
    setEditingId(null);
  };
  const addItem = (text: string) => {
    const t = text.trim();
    if (!t) return;
    setItems([...items, { id: crypto.randomUUID(), checked: false, text: t }]);
  };
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
                draggable={editingId !== item.id}
                onDragStart={() => setDragId(item.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => { reorder(item.id); setDragId(null); }}
                className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-900"
              >
                <GripVertical size={13} className="shrink-0 cursor-grab text-neutral-700 opacity-0 group-hover:opacity-100" />
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={() => toggle(item.id)}
                  className="h-3.5 w-3.5 shrink-0 accent-neutral-400"
                />
                {editingId === item.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(item.id, draft)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(item.id, draft);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-1 text-sm text-neutral-100 outline-none"
                  />
                ) : (
                  <span
                    onClick={() => { setEditingId(item.id); setDraft(item.text); }}
                    className={cn(
                      "flex-1 cursor-text truncate text-sm",
                      item.checked ? "text-neutral-500 line-through" : "text-neutral-200"
                    )}
                  >
                    {item.text}
                  </span>
                )}
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
                onKeyDown={(e) => {
                  if (e.key === "Enter" && adding.trim()) {
                    addItem(adding);
                    setAdding("");
                  }
                }}
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
