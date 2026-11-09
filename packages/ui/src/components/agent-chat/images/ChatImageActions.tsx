import React from "react";
import { Check, Copy, Download, FolderOpen, ImagePlus } from "lucide-react";

import { useApi } from "../../../context/orquester-context";
import { defaultSavedImagePath } from "../../../lib/agent-chat/chat-images.logic";
import { cn } from "../../../lib/cn";
import { useAppStore } from "../../../store/app";
import { ChatIconButton, COPY_FEEDBACK_MS } from "../primitives";
import { useTimelineRowContext } from "../timeline/context";
import type { ChatImageItem } from "./chat-image";
import { attachImageAsReference, copyImageToClipboard } from "./image-actions";
import { SaveImageDialog } from "./SaveImageDialog";

function failureMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * The actions on one image (design 2026-11-10 §9.1), on hover over it and in
 * the enlarged view: Copy image; Save to project… (a chat image, in a chat
 * with a project); Reveal in files (only for an image that is a file of this
 * project); Use as reference (a chat image of the chat being viewed, where
 * the chat takes input). Each acts on the loaded image, so none is offered
 * before it has loaded.
 */
export function ChatImageActions(props: {
  item: ChatImageItem;
  url: string | null;
  className?: string;
  /** After an action that takes the user elsewhere (the file browser, the composer). */
  onLeave?: () => void;
}): React.ReactElement | null {
  const { item, url } = props;
  const api = useApi();
  const { sessionId, workspaceRoot, readOnly } = useTimelineRowContext();
  const [copied, setCopied] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  if (url === null) return null;
  const notice = (title: string, message: string) => useAppStore.getState().setNotice({ title, message });
  const attachment = item.source.kind === "attachment" ? item.source : null;
  const canSave = attachment !== null && workspaceRoot !== undefined;
  const canReveal =
    item.path !== undefined && workspaceRoot !== undefined && item.path.startsWith(`${workspaceRoot}/`);
  const canReference = attachment !== null && !readOnly && sessionId === attachment.sessionId;
  const name = defaultSavedImagePath({
    ...(item.caption !== undefined ? { caption: item.caption } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {})
  });

  return (
    <span className={cn("flex items-center gap-0.5", props.className)}>
      <ChatIconButton
        label={copied ? "Copied" : "Copy image"}
        onClick={(event) => {
          event.stopPropagation();
          copyImageToClipboard(url).then(
            () => setCopied(true),
            (cause: unknown) => notice("Couldn't copy the image", failureMessage(cause, "The clipboard refused it."))
          );
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </ChatIconButton>
      {canSave ? (
        <ChatIconButton
          label="Save to project…"
          onClick={(event) => {
            event.stopPropagation();
            setSaving(true);
          }}
        >
          <Download size={14} aria-hidden />
        </ChatIconButton>
      ) : null}
      {canReveal ? (
        <ChatIconButton
          label="Reveal in files"
          onClick={(event) => {
            event.stopPropagation();
            useAppStore.getState().revealInFileBrowser(item.path!);
            props.onLeave?.();
          }}
        >
          <FolderOpen size={14} aria-hidden />
        </ChatIconButton>
      ) : null}
      {canReference ? (
        <ChatIconButton
          label="Use as reference"
          disabled={attaching}
          onClick={(event) => {
            event.stopPropagation();
            setAttaching(true);
            const fileName = name.slice(name.lastIndexOf("/") + 1);
            attachImageAsReference({ api, sessionId: attachment.sessionId, url, name: fileName }).then(
              () => {
                setAttaching(false);
                props.onLeave?.();
              },
              (cause: unknown) => {
                setAttaching(false);
                notice("Couldn't attach the image", failureMessage(cause, "The upload failed."));
              }
            );
          }}
        >
          <ImagePlus size={14} aria-hidden />
        </ChatIconButton>
      ) : null}
      {saving && workspaceRoot !== undefined ? (
        <SaveImageDialog
          projectRoot={workspaceRoot}
          url={url}
          defaultPath={name}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </span>
  );
}
