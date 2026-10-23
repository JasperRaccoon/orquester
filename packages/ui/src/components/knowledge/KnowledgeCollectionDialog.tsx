// Create or edit a collection (name, one-line description, colour), and delete
// one after a confirmation that says what happens to its entries.

import React, { useEffect, useId, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  KNOWLEDGE_COLLECTION_DESCRIPTION_MAX,
  KNOWLEDGE_COLLECTION_NAME_MAX,
  KNOWLEDGE_COLORS,
  type KnowledgeCollectionView
} from "@orquester/api";

import { Button, Input, Modal, ModalCloseButton } from "../ui";
// Directly, not through `../ui`: that index and confirm-dialog import each other, which a lazy chunk cannot split.
import { ConfirmDialog } from "../ui/confirm-dialog";
import { cn } from "../../lib/cn";
import {
  createKnowledgeCollection,
  deleteKnowledgeCollection,
  updateKnowledgeCollection,
  type KnowledgeApi
} from "../../lib/knowledge/store";
import { ErrorLine } from "./parts";
import {
  collectionFormError,
  deleteCollectionMessage,
  knowledgeColorCss,
  knowledgeErrorText,
  nextKnowledgeColor,
  type CollectionForm
} from "./knowledge.logic";

export interface KnowledgeCollectionDialogProps {
  api: KnowledgeApi | null;
  open: boolean;
  /** The collection to edit; null creates one. */
  collection: KnowledgeCollectionView | null;
  collections: readonly KnowledgeCollectionView[];
  onClose: () => void;
}

export const KnowledgeCollectionDialog: React.FC<KnowledgeCollectionDialogProps> = ({ api, open, collection, collections, onClose }) => {
  const id = useId();
  const [form, setForm] = useState<CollectionForm>({ name: "", description: "", color: KNOWLEDGE_COLORS[0]! });
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(
      collection
        ? { name: collection.name, description: collection.description, color: collection.color }
        : { name: "", description: "", color: nextKnowledgeColor(collections, KNOWLEDGE_COLORS) }
    );
    setTouched(false);
    setBusy(false);
    setError(null);
    setConfirmDelete(false);
    // The form starts over each time the dialog opens, not when the list refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collection?.id]);

  const invalid = collectionFormError(form, collections, collection?.id ?? null);

  const submit = async () => {
    setTouched(true);
    if (invalid || !api) return;
    setBusy(true);
    setError(null);
    const name = form.name.trim();
    const description = form.description.trim();
    try {
      if (collection) {
        const patch: { name?: string; description?: string; color?: typeof form.color } = {};
        if (name !== collection.name) patch.name = name;
        if (description !== collection.description) patch.description = description;
        if (form.color !== collection.color) patch.color = form.color;
        if (Object.keys(patch).length > 0) await updateKnowledgeCollection(api, collection.id, patch);
      } else {
        await createKnowledgeCollection(api, { name, description, color: form.color });
      }
      onClose();
    } catch (err) {
      setError(knowledgeErrorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!api || !collection) return;
    setConfirmDelete(false);
    setBusy(true);
    setError(null);
    try {
      await deleteKnowledgeCollection(api, collection.id);
      onClose();
    } catch (err) {
      setError(knowledgeErrorText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal open={open && !confirmDelete} onClose={onClose} className="max-w-md">
        <form
          aria-label={collection ? "Edit collection" : "New collection"}
          className="w-full space-y-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-neutral-100">{collection ? "Edit collection" : "New collection"}</h2>
            <ModalCloseButton onClose={onClose} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="block text-xs font-medium text-neutral-300">
              Name
            </label>
            <Input
              id={`${id}-name`}
              autoFocus
              maxLength={KNOWLEDGE_COLLECTION_NAME_MAX}
              placeholder="SEO"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-description`} className="block text-xs font-medium text-neutral-300">
              Description
            </label>
            <Input
              id={`${id}-description`}
              maxLength={KNOWLEDGE_COLLECTION_DESCRIPTION_MAX}
              placeholder="What belongs here, in one line (agents read it to choose)"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <p className="text-[11px] text-neutral-500">
              {form.description.trim().length}/{KNOWLEDGE_COLLECTION_DESCRIPTION_MAX}
            </p>
          </div>
          <div role="radiogroup" aria-label="Colour" className="flex items-center gap-2">
            <span className="mr-1 text-xs font-medium text-neutral-300">Colour</span>
            {KNOWLEDGE_COLORS.map((color, i) => (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={form.color === color}
                aria-label={`Colour ${i + 1}`}
                onClick={() => setForm((f) => ({ ...f, color }))}
                className={cn(
                  "h-5 w-5 rounded-full ring-offset-2 ring-offset-neutral-900 transition-shadow",
                  form.color === color ? "ring-2 ring-neutral-300" : "hover:ring-1 hover:ring-neutral-600"
                )}
                style={{ backgroundColor: knowledgeColorCss(color) }}
              />
            ))}
          </div>
          {touched && invalid && <ErrorLine>{invalid}</ErrorLine>}
          {error && <ErrorLine>{error}</ErrorLine>}
          <div className="flex items-center gap-2 pt-1">
            {collection && (
              <Button type="button" size="sm" variant="ghost" className="text-danger hover:text-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={12} /> Delete
              </Button>
            )}
            <span className="flex-1" />
            <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !api}>
              {busy && <Loader2 size={12} className="motion-safe:animate-spin" />} {collection ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>
      {collection && (
        <ConfirmDialog
          open={open && confirmDelete}
          title="Delete collection?"
          message={deleteCollectionMessage(collection)}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
};
