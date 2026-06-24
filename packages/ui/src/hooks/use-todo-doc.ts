import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoListRecord } from "@orquester/api";
import { useAppStore } from "../store/app";
import { parseTodoMarkdown, serializeTodoMarkdown, type TodoItem } from "../components/todo/todo-markdown";

const DEBOUNCE_MS = 400;

export function useTodoDoc(todoId: string): {
  record: TodoListRecord | undefined;
  items: TodoItem[];
  setItems: (next: TodoItem[]) => void;
  saving: boolean;
} {
  const record = useAppStore((s) => s.todos.find((t) => t.id === todoId));
  const saveTodoBody = useAppStore((s) => s.saveTodoBody);

  const [items, setItemsState] = useState<TodoItem[]>(() => parseTodoMarkdown(record?.body ?? ""));
  const [saving, setSaving] = useState(false);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string | null>(null); // serialized body waiting to be saved
  const lastSynced = useRef<string>(record?.body ?? "");

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (pending.current === null) return;
    const body = pending.current;
    pending.current = null;
    setSaving(true);
    try {
      await saveTodoBody(todoId, body);
      lastSynced.current = body;
    } finally {
      setSaving(false);
    }
  }, [saveTodoBody, todoId]);

  const setItems = useCallback(
    (next: TodoItem[]) => {
      setItemsState(next);
      const body = serializeTodoMarkdown(next);
      pending.current = body;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush]
  );

  // Reconcile an external body change (another client) only when there's no pending local edit.
  useEffect(() => {
    const body = record?.body ?? "";
    if (pending.current === null && body !== lastSynced.current) {
      lastSynced.current = body;
      setItemsState(parseTodoMarkdown(body));
    }
  }, [record?.body]);

  // Flush any pending save on unmount.
  useEffect(() => () => void flush(), [flush]);

  return { record, items, setItems, saving };
}
