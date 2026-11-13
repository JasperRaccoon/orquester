import React from "react";

import { normalizeProjectRelativePath } from "../../../lib/agent-chat/chat-images.logic";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Modal } from "../../ui/modal";
import type { ChatHost } from "../chat-host";

/**
 * "Save to project…" (design 2026-11-10 §9.1): asks where in the project,
 * proposing the generated-images folder, and saves without ever replacing a
 * file — the name gets `-v2`, `-v3`, … — then says where it landed.
 */
export function SaveImageDialog(props: {
  /** The host's save (`ChatHost.saveImageToProject`). */
  save: NonNullable<ChatHost["saveImageToProject"]>;
  notify: ChatHost["notify"];
  projectRoot: string;
  url: string;
  defaultPath: string;
  onClose: () => void;
}): React.ReactElement {
  const [value, setValue] = React.useState(props.defaultPath);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const relativePath = normalizeProjectRelativePath(value);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    // The name, not the folder or the extension, is what one usually changes.
    const input = inputRef.current;
    if (input === null) return;
    const start = props.defaultPath.lastIndexOf("/") + 1;
    const dot = props.defaultPath.lastIndexOf(".");
    input.focus();
    input.setSelectionRange(start, dot > start ? dot : props.defaultPath.length);
  }, [props.defaultPath]);

  const save = async (): Promise<void> => {
    if (relativePath === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await props.save({ projectRoot: props.projectRoot, relativePath, url: props.url });
      const shown = saved.startsWith(`${props.projectRoot}/`) ? saved.slice(props.projectRoot.length + 1) : saved;
      props.notify?.({ title: "Image saved", message: shown });
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The image could not be saved.");
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={props.onClose} className="max-w-md" ariaLabel="Save image to project">
      <form
        className="w-full p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="mb-1 text-sm font-medium text-neutral-100">Save to project</p>
        <p className="mb-3 text-xs text-neutral-500">
          A path inside the project. An existing file is never replaced; the name gets -v2, -v3, … instead.
        </p>
        <Input
          ref={inputRef}
          aria-label="Path in the project"
          value={value}
          spellCheck={false}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
        {relativePath === null && value.trim() !== "" ? (
          <p className="mt-2 text-xs text-danger">Use a file path inside the project, like assets/image.png.</p>
        ) : null}
        {error !== null ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={relativePath === null || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
