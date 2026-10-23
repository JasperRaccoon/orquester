// Editing one entry: its text, metadata and collections, saved with one PATCH
// of the fields that changed. Nothing is applied before the daemon answers;
// the panel then reads the entry again.

import React, { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import type { KnowledgeCollectionView, KnowledgeEntry } from "@orquester/api";

import { Button, Input } from "../ui";
import { cn } from "../../lib/cn";
import { updateKnowledgeEntry, type KnowledgeApi } from "../../lib/knowledge/store";
import { CollectionChip, ErrorLine } from "./parts";
import {
  KNOWLEDGE_KIND_SUGGESTIONS,
  entryFormOf,
  entryFormPatch,
  knowledgeErrorText,
  patchNeedsLinking,
  type EntryForm
} from "./knowledge.logic";

const Field: React.FC<{ label: string; htmlFor: string; children: React.ReactNode; className?: string }> = ({
  label,
  htmlFor,
  children,
  className
}) => (
  <div className={cn("space-y-1", className)}>
    <label htmlFor={htmlFor} className="block text-[11px] font-medium text-neutral-400">
      {label}
    </label>
    {children}
  </div>
);

export const KnowledgeEntryEditor: React.FC<{
  api: KnowledgeApi | null;
  entry: KnowledgeEntry;
  collections: readonly KnowledgeCollectionView[];
  onDone: () => void;
}> = ({ api, entry, collections, onDone }) => {
  const [form, setForm] = useState<EntryForm>(() => entryFormOf(entry));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const set = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggle = (collectionId: string) =>
    set("collections", form.collections.includes(collectionId) ? form.collections.filter((c) => c !== collectionId) : [...form.collections, collectionId]);

  const result = entryFormPatch(entry, form);
  const patch = "patch" in result ? result.patch : null;
  const changed = patch !== null && Object.keys(patch).length > 0;

  const save = async () => {
    if (!api || !patch || !changed) return;
    setSaving(true);
    setError(null);
    try {
      await updateKnowledgeEntry(api, entry.id, patch);
      onDone();
    } catch (err) {
      setError(knowledgeErrorText(err));
      setSaving(false);
    }
  };

  return (
    <form
      aria-label="Edit entry"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="Title" htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} value={form.title} onChange={(e) => set("title", e.target.value)} />
      </Field>
      <Field label="Text (kept verbatim)" htmlFor={`${id}-body`}>
        <textarea
          id={`${id}-body`}
          value={form.body}
          onChange={(e) => set("body", e.target.value)}
          rows={10}
          className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-[13px] leading-relaxed text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Kind" htmlFor={`${id}-kind`}>
          <Input id={`${id}-kind`} list={`${id}-kinds`} value={form.kind} onChange={(e) => set("kind", e.target.value)} />
          <datalist id={`${id}-kinds`}>
            {KNOWLEDGE_KIND_SUGGESTIONS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
        </Field>
        <Field label="Posted" htmlFor={`${id}-posted`}>
          <Input id={`${id}-posted`} placeholder="YYYY-MM-DD" value={form.postedAt} onChange={(e) => set("postedAt", e.target.value)} />
        </Field>
        <Field label="Author" htmlFor={`${id}-author`}>
          <Input id={`${id}-author`} value={form.author} onChange={(e) => set("author", e.target.value)} />
        </Field>
        <Field label="Handle" htmlFor={`${id}-handle`}>
          <Input id={`${id}-handle`} placeholder="@handle" value={form.handle} onChange={(e) => set("handle", e.target.value)} />
        </Field>
      </div>
      <Field label="URL" htmlFor={`${id}-url`}>
        <Input id={`${id}-url`} placeholder="https://" value={form.url} onChange={(e) => set("url", e.target.value)} />
      </Field>
      <fieldset className="space-y-1">
        <legend className="text-[11px] font-medium text-neutral-400">Collections</legend>
        {collections.length === 0 ? (
          <p className="text-xs text-neutral-500">No collections yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {collections.map((c) => (
              <CollectionChip key={c.id} name={c.name} color={c.color} active={form.collections.includes(c.id)} onClick={() => toggle(c.id)} />
            ))}
          </div>
        )}
        {form.collections.length === 0 && <p className="text-[11px] text-neutral-500">With none it is Unfiled: only Global chats see it.</p>}
      </fieldset>

      {"error" in result && <ErrorLine>{result.error}</ErrorLine>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {patch && changed && patchNeedsLinking(patch) && (
        <p className="text-[11px] text-neutral-500">Saving re-links this entry in the background.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!changed || saving || !api}>
          {saving && <Loader2 size={12} className="motion-safe:animate-spin" />} Save
        </Button>
      </div>
    </form>
  );
};
