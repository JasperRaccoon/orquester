import React from "react";
import { Check, Copy, Download, FolderOpen, ImagePlus } from "lucide-react";

import { defaultSavedImagePath } from "../../../lib/agent-chat/chat-images.logic";
import { cn } from "../../../lib/cn";
import { useChatHost } from "../chat-host";
import { ChatIconButton, COPY_FEEDBACK_MS } from "../primitives";
import { useTimelineRowContext } from "../timeline/context";
import type { ChatImageItem } from "./chat-image";
import { copyImageToClipboard, readImageBlob } from "./image-actions";
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
 * before it has loaded. All but Copy are the app's (`ChatHost`): a host that
 * offers none of them shows Copy alone.
 */
export function ChatImageActions(props: {
  item: ChatImageItem;
  url: string | null;
  className?: string;
  /** After an action that takes the user elsewhere (the file browser, the composer). */
  onLeave?: () => void;
}): React.ReactElement | null {
  const { item, url } = props;
  const host = useChatHost();
  const { sessionId, workspaceRoot, readOnly } = useTimelineRowContext();
  const [copied, setCopied] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // An image whose type nobody told us (a Markdown `attachment:<id>`) is
  // named by what its loaded bytes are, so a JPEG is never saved as `.png`.
  const [sniffed, setSniffed] = React.useState<{ url: string; mimeType: string } | null>(null);
  React.useEffect(() => {
    if (url === null || item.mimeType !== undefined) return undefined;
    let live = true;
    readImageBlob(url).then(
      (blob) => {
        if (live) setSniffed({ url, mimeType: blob.type });
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [url, item.mimeType]);
  const mimeType = item.mimeType ?? (sniffed !== null && sniffed.url === url ? sniffed.mimeType : undefined);

  if (url === null) return null;
  const notice = (title: string, message: string) => host.notify?.({ title, message });
  const { saveImageToProject, revealInFiles, attachImageToComposer } = host;
  const attachment = item.source.kind === "attachment" ? item.source : null;
  const canSave = saveImageToProject !== undefined && attachment !== null && workspaceRoot !== undefined;
  const canReveal =
    revealInFiles !== undefined &&
    item.path !== undefined &&
    workspaceRoot !== undefined &&
    item.path.startsWith(`${workspaceRoot}/`);
  const canReference =
    attachImageToComposer !== undefined && attachment !== null && !readOnly && sessionId === attachment.sessionId;
  const name = defaultSavedImagePath({
    ...(item.caption !== undefined ? { caption: item.caption } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(mimeType !== undefined ? { mimeType } : {})
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
            revealInFiles(item.path!);
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
            attachImageToComposer({ sessionId: attachment.sessionId, url, name: fileName }).then(
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
      {saving && canSave ? (
        <SaveImageDialog
          save={saveImageToProject}
          notify={host.notify}
          projectRoot={workspaceRoot}
          url={url}
          defaultPath={name}
          onClose={() => setSaving(false)}
        />
      ) : null}
    </span>
  );
}
