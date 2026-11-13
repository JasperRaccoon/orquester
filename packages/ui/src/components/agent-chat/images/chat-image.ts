/**
 * Images in the chat (design 2026-11-10 §9): what one shown image is, and how
 * its bytes are read — a stored attachment of the chat being viewed, through
 * the chat's attachment route, or a file a Markdown image names, through the
 * file API. Both are read through the chat's host (`useChatHost`): in the
 * app they ride the bearer-authed binary channel, so a remote client reads
 * them as the desktop does; a host that reads no files shows a file image as
 * unavailable.
 */

import React from "react";

import { useObjectUrl, type ObjectUrlState } from "../../../hooks/use-object-url";
import { detectFileKind } from "../../../lib/file-kind";
import { useChatHost } from "../chat-host";

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

/**
 * The image's bytes, read once per call (the actions read the loaded object
 * URL instead) — `null` when the host has no way to read them (a file image
 * where the host reads no files).
 */
export function useChatImageFetcher(source: ChatImageSource): {
  fetchBytes: ((key: string, signal?: AbortSignal) => Promise<ArrayBuffer>) | null;
  key: string;
} {
  const { fetchAttachment, readFileBytes } = useChatHost();
  const sessionId = source.kind === "attachment" ? source.sessionId : null;
  const key = source.kind === "attachment" ? source.attachmentId : source.path;
  const fetchBytes = React.useMemo(
    () =>
      sessionId !== null
        ? (value: string, signal?: AbortSignal) => fetchAttachment(sessionId, value, signal)
        : readFileBytes !== undefined
          ? (value: string, signal?: AbortSignal) => readFileBytes(value, signal)
          : null,
    [fetchAttachment, readFileBytes, sessionId]
  );
  return { fetchBytes, key };
}

const NEVER_READ = (): Promise<never> => Promise.reject(new Error("Not readable here."));

/**
 * The image as an object URL, revoked when the image changes and on unmount.
 * A file that is no image by its name, or that the host cannot read, is never
 * read (`error`).
 */
export function useChatImageUrl(item: ChatImageItem): ObjectUrlState & { isImage: boolean } {
  const { fetchBytes, key } = useChatImageFetcher(item.source);
  const fileKind = item.source.kind === "file" ? detectFileKind(item.source.path) : null;
  const isImage = fileKind === null || fileKind.kind === "image";
  const readable = isImage && fetchBytes !== null;
  // The browser sniffs an image whatever type its blob says; the type only
  // matters to what is read back from the URL, which the actions sniff again.
  const mime = item.mimeType ?? fileKind?.mime ?? "image/png";
  const state = useObjectUrl(fetchBytes ?? NEVER_READ, key, mime, readable);
  return { ...state, isImage, ...(readable ? {} : { error: true }) };
}
