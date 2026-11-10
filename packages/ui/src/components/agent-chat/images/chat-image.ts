/**
 * Images in the chat (design 2026-11-10 §9): what one shown image is, and how
 * its bytes are read — a stored attachment of the chat being viewed, through
 * the chat's attachment route, or a file a Markdown image names, through the
 * file API. Both ride the bearer-authed binary channel, so a remote client
 * reads them as the desktop does.
 */

import React from "react";

import { useApi } from "../../../context/orquester-context";
import { useObjectUrl, type ObjectUrlState } from "../../../hooks";
import { detectFileKind } from "../../../lib/file-kind";

/** Where one image's bytes come from. */
export type ChatImageSource =
  | { kind: "attachment"; sessionId: string; attachmentId: string }
  | { kind: "file"; path: string };

/** One image the chat shows: in an inline image row, or a Markdown image. */
export interface ChatImageItem {
  /** Stable within its row: the attachment id, or the file path. */
  key: string;
  source: ChatImageSource;
  /** The image's accessible text. */
  alt: string;
  caption?: string;
  /** The row's title, which names a saved copy when the image has no caption. */
  title?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  /** The project file it is (or was also written to), for "Reveal in files". */
  path?: string;
}

/** The image's bytes, read once per call (the actions read the loaded object URL instead). */
export function useChatImageFetcher(source: ChatImageSource): {
  fetchBytes: (key: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  key: string;
} {
  const api = useApi();
  const sessionId = source.kind === "attachment" ? source.sessionId : null;
  const key = source.kind === "attachment" ? source.attachmentId : source.path;
  const kind = source.kind;
  const fetchBytes = React.useCallback(
    (value: string, signal?: AbortSignal) =>
      kind === "attachment" && sessionId !== null
        ? api.agentChat.fetchAttachment(sessionId, value, signal)
        : api.readFileBytes(value, signal),
    [api, kind, sessionId]
  );
  return { fetchBytes, key };
}

/**
 * The image as an object URL, revoked when the image changes and on unmount.
 * A file that is no image by its name is never read (`error`).
 */
export function useChatImageUrl(item: ChatImageItem): ObjectUrlState & { isImage: boolean } {
  const { fetchBytes, key } = useChatImageFetcher(item.source);
  const fileKind = item.source.kind === "file" ? detectFileKind(item.source.path) : null;
  const isImage = fileKind === null || fileKind.kind === "image";
  // The browser sniffs an image whatever type its blob says; the type only
  // matters to what is read back from the URL, which the actions sniff again.
  const mime = item.mimeType ?? fileKind?.mime ?? "image/png";
  const state = useObjectUrl(fetchBytes, key, mime, isImage);
  return { ...state, isImage, ...(isImage ? {} : { error: true }) };
}
