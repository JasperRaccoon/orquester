/**
 * Desktops — how a chat row of a desktop tool reads and what it links (spec 2026-11-10 R2.6), pure:
 * "Used Firefox · Clicked at 412, 300", "Took a screenshot of Firefox", with **Show desktop** and a
 * kept screenshot's thumbnail.
 *
 * The link comes from the result's `desktopRef` (kept through slimming, so it survives a reload);
 * a live `get_desktops` / `control_desktop` result without one still names its desktop by id.
 * Everything a provider relayed is validated here before a row uses it.
 */

import { isDesktopActionKind, type DesktopActionKind } from "@orquester/api";
import { sessionToolNameOfData, sessionToolReferences } from "@orquester/api/agent-chat";

/** The result key the daemon keeps through slimming (`SESSION_TOOL_REFERENCE_KEYS`). */
export const DESKTOP_TOOL_REFERENCE_KEY = "desktopRef";

/** A row's validated desktop link (`DesktopToolReference`, with `projectPath` unknown for a bare id). */
export interface DesktopRowLink {
  desktopId: string;
  projectPath?: string;
  screenshotId?: string;
  action?: DesktopActionKind;
  /** The action-log line ("Clicked at 412, 300"). */
  summary?: string;
}

/** The desktop's title as the store knows it. */
export type DesktopTitleResolver = (desktopId: string) => string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCREENSHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUMMARY_MAX = 200;

function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : undefined;
}

/** `value` as a desktop link, or undefined when it is not one. */
export function readDesktopRowLink(value: unknown): DesktopRowLink | undefined {
  if (!isRecord(value)) return undefined;
  const { desktopId, projectPath, screenshotId } = value;
  if (typeof desktopId !== "string" || !ID.test(desktopId)) return undefined;
  const link: DesktopRowLink = { desktopId };
  const path = oneLine(projectPath, 4096);
  if (path !== undefined && path.startsWith("/")) link.projectPath = path;
  if (typeof screenshotId === "string" && SCREENSHOT_ID.test(screenshotId)) link.screenshotId = screenshotId;
  if (isDesktopActionKind(value.action)) link.action = value.action;
  const summary = oneLine(value.summary, SUMMARY_MAX);
  if (summary !== undefined) link.summary = summary;
  return link;
}

/** Tools whose live result names a desktop without a `desktopRef`. */
const DESKTOP_TOOLS = new Set(["get_desktops", "control_desktop"]);

/** The desktop a bare result names: `{desktopId}`, `{desktop: {id, projectPath}}` or `{app: {desktopId}}`. */
function desktopNamedBy(data: Record<string, unknown>): DesktopRowLink | undefined {
  const found = sessionToolReferences(data, ["desktopId", "desktop", "app"]);
  if (!found) return undefined;
  if (typeof found.desktopId === "string") return readDesktopRowLink({ desktopId: found.desktopId });
  if (isRecord(found.desktop)) return readDesktopRowLink({ desktopId: found.desktop.id, projectPath: found.desktop.projectPath });
  if (isRecord(found.app)) return readDesktopRowLink({ desktopId: found.app.desktopId });
  return undefined;
}

/**
 * The desktop a session-tool row links to, or undefined (only rows the host marked as its own
 * session tool's). A `desktopRef` without its action's words takes them from the same live result.
 */
export function desktopRowLinkOfActivityData(data: unknown): DesktopRowLink | undefined {
  if (!isRecord(data)) return undefined;
  const tool = sessionToolNameOfData(data);
  if (tool === null) return undefined;
  const reference = readDesktopRowLink(sessionToolReferences(data, [DESKTOP_TOOL_REFERENCE_KEY])?.[DESKTOP_TOOL_REFERENCE_KEY]);
  if (reference) {
    if (reference.action !== undefined && reference.summary !== undefined) return reference;
    const found = sessionToolReferences(data, ["action", "summary"]);
    return readDesktopRowLink({
      ...reference,
      ...(reference.action === undefined && found ? { action: found.action } : {}),
      ...(reference.summary === undefined && found ? { summary: found.summary } : {})
    });
  }
  return DESKTOP_TOOLS.has(tool) ? desktopNamedBy(data) : undefined;
}

const ACTION_WORDS: Readonly<Record<DesktopActionKind, string>> = {
  screenshot: "Took a screenshot",
  wait: "Waited for the screen",
  move: "Moved the pointer",
  click: "Clicked",
  mouse_down: "Pressed the mouse button",
  mouse_up: "Released the mouse button",
  drag: "Dragged",
  scroll: "Scrolled",
  key: "Pressed keys",
  type: "Typed",
  clipboard_get: "Read the clipboard",
  clipboard_set: "Set the clipboard"
};

/**
 * The words of a desktop tool's row, or undefined to keep the tool's generic label (a row without
 * a link, another tool).
 */
export function desktopToolRowLabel(tool: string, link: DesktopRowLink | undefined, resolveTitle?: DesktopTitleResolver): string | undefined {
  if (!link || tool !== "desktop_action") return undefined;
  const title = resolveTitle?.(link.desktopId)?.trim() || undefined;
  if (link.action === "screenshot") return title ? `Took a screenshot of ${title}` : "Took a screenshot of a desktop";
  const what = link.summary ?? (link.action !== undefined ? ACTION_WORDS[link.action] : undefined);
  const where = title ? `Used ${title}` : "Used a desktop";
  return what ? `${where} · ${what}` : where;
}
