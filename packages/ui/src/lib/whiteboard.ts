/**
 * Whiteboard files (the Excalidraw plugin): `.excalidraw` scenes saved in the
 * project, new ones under `<project>/whiteboards/`. Pure helpers with no
 * Excalidraw import, so the menu and the file browser never pull the editor
 * bundle in; the tab loads it lazily.
 */

export const WHITEBOARD_EXTENSION = ".excalidraw";

/**
 * Where the app build serves Excalidraw's fonts from, relative to the app's
 * base URL (the Vite plugin in `packages/ui/vite/excalidraw-assets.ts` puts them there).
 */
export const EXCALIDRAW_ASSETS_DIR = "excalidraw";

/** The project folder new whiteboards are created in and the "+" menu lists. */
export const WHITEBOARDS_DIR = "whiteboards";

/** A new whiteboard's file name; the daemon numbers it ("Untitled (1)") when taken. */
export const NEW_WHITEBOARD_NAME = `Untitled${WHITEBOARD_EXTENSION}`;

export function isWhiteboardFile(name: string): boolean {
  return name.toLowerCase().endsWith(WHITEBOARD_EXTENSION);
}

/** A whiteboard's tab title: its file name without the extension. */
export function whiteboardTitle(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return isWhiteboardFile(name) ? name.slice(0, -WHITEBOARD_EXTENSION.length) || name : name;
}

/** `<project>/whiteboards`, for a project path with or without a trailing slash. */
export function whiteboardsDirOf(projectPath: string): string {
  return `${projectPath.replace(/\/+$/, "")}/${WHITEBOARDS_DIR}`;
}

/**
 * The file a new whiteboard starts as: an empty scene in Excalidraw's own
 * format, so the file opens in excalidraw.com and its editor plugins too.
 */
export function emptyWhiteboardFile(): string {
  return `${JSON.stringify(
    { type: "excalidraw", version: 2, source: "orquester", elements: [], appState: {}, files: {} },
    null,
    2
  )}\n`;
}

/**
 * Whether `text` is an Excalidraw scene file: JSON with `type: "excalidraw"`
 * and an `elements` array. Anything else is refused rather than opened as an
 * empty board, which the next save would write over.
 */
export function isWhiteboardScene(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "excalidraw" &&
      Array.isArray((value as { elements?: unknown }).elements)
    );
  } catch {
    return false;
  }
}

/** A file's text as a whiteboard reads it: an empty file is an empty scene. */
export function whiteboardText(raw: string): string {
  return raw.trim() === "" ? emptyWhiteboardFile() : raw;
}

/** A save refused because the file changed since the board last read or wrote it. */
export class WhiteboardConflictError extends Error {
  constructor() {
    super("The file changed on disk since it was opened here.");
    this.name = "WhiteboardConflictError";
  }
}
