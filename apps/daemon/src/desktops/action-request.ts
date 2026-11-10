// `POST desktopRoutes.actions` bodies (spec 2026-11-10 §2.4): a DesktopActionRequest checked
// field by field — each action takes only its own fields (as `control_desktop` does), every number
// in its range. What needs the display (bounds, a screenshot's size) is checked when the action runs.

import { z } from "zod";
import {
  DESKTOP_ACTION_KINDS,
  DESKTOP_CLIPBOARD_MAX_BYTES,
  DESKTOP_IDLE_MAX_MS,
  DESKTOP_IDLE_MIN_MS,
  DESKTOP_SCREENSHOT_MAX_MAX,
  DESKTOP_SCREENSHOT_MIN_MAX,
  DESKTOP_TYPE_MAX_CHARS,
  DESKTOP_WAIT_MAX_TIMEOUT_MS,
  type DesktopActionKind,
  type DesktopActionRequest,
  isReadOnlyDesktopAction
} from "@orquester/api";
import { DesktopError } from "./errors.ts";

export const DESKTOP_INVALID_ARGUMENT_CODE = "INVALID_ARGUMENT";

const MAX_LABEL_CHARS = 80;
const MAX_KEYS_CHARS = 200;
/** No display is larger (the record schema's bound); coordinates beyond it are nonsense. */
const MAX_COORDINATE = 16_384;

const singleLine = (value: string): boolean => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);

const label = z.string().trim().min(1).max(MAX_LABEL_CHARS).refine(singleLine, "must be a single line");
const coordinate = z.number().finite().min(0).max(MAX_COORDINATE);
const pixel = z.number().int().min(0).max(MAX_COORDINATE);

const requestSchema = z
  .object({
    action: z.enum(DESKTOP_ACTION_KINDS),
    actor: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("chat"), threadId: z.string().min(1).max(200), label }).strict(),
      z.object({ kind: z.literal("external"), label }).strict()
    ]),
    x: coordinate.optional(),
    y: coordinate.optional(),
    screenshotId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "is not a screenshot id").optional(),
    button: z.enum(["left", "middle", "right"]).optional(),
    count: z.number().int().min(1).max(3).optional(),
    modifiers: z.array(z.enum(["ctrl", "shift", "alt", "super"])).max(4).optional(),
    toX: coordinate.optional(),
    toY: coordinate.optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().int().min(1).max(50).optional(),
    keys: z.string().min(1).max(MAX_KEYS_CHARS).refine(singleLine, "must be a single line").optional(),
    repeat: z.number().int().min(1).max(20).optional(),
    text: z.string().optional(),
    region: z.object({ x: pixel, y: pixel, width: pixel.min(1), height: pixel.min(1) }).strict().optional(),
    windowId: z.string().regex(/^0x[0-9a-f]{1,8}$/i, "is not a window id (0x… hex)").optional(),
    maxSize: z.number().int().min(DESKTOP_SCREENSHOT_MIN_MAX).max(DESKTOP_SCREENSHOT_MAX_MAX).optional(),
    for: z.enum(["idle", "change"]).optional(),
    idleMs: z.number().int().min(DESKTOP_IDLE_MIN_MS).max(DESKTOP_IDLE_MAX_MS).optional(),
    since: z.number().int().min(0).optional(),
    timeoutMs: z.number().int().min(1).max(DESKTOP_WAIT_MAX_TIMEOUT_MS).optional(),
    screenshot: z.boolean().optional()
  })
  .strict();

type Field = Exclude<keyof DesktopActionRequest, "action" | "actor">;

/** After an input action: the screen once it settled. */
const SETTLED_SHOT: readonly Field[] = ["screenshot", "maxSize"];
const POINT: readonly Field[] = ["x", "y", "screenshotId"];

/** The fields each action takes (required, then allowed) — anything else given is refused. */
const ACTION_FIELDS: Readonly<Record<DesktopActionKind, { required: readonly Field[]; allowed: readonly Field[] }>> = {
  screenshot: { required: [], allowed: ["region", "windowId", "maxSize"] },
  wait: { required: [], allowed: ["for", "idleMs", "since", "region", "timeoutMs"] },
  move: { required: ["x", "y"], allowed: ["screenshotId", ...SETTLED_SHOT] },
  click: { required: [], allowed: [...POINT, "button", "count", "modifiers", ...SETTLED_SHOT] },
  mouse_down: { required: [], allowed: [...POINT, "button", ...SETTLED_SHOT] },
  mouse_up: { required: [], allowed: [...POINT, "button", ...SETTLED_SHOT] },
  drag: { required: ["x", "y", "toX", "toY"], allowed: ["screenshotId", "button", "modifiers", ...SETTLED_SHOT] },
  scroll: { required: ["direction"], allowed: [...POINT, "amount", "modifiers", ...SETTLED_SHOT] },
  key: { required: ["keys"], allowed: ["repeat", ...SETTLED_SHOT] },
  type: { required: ["text"], allowed: [...SETTLED_SHOT] },
  clipboard_get: { required: [], allowed: [] },
  clipboard_set: { required: ["text"], allowed: [] }
};

function invalid(message: string): DesktopError {
  return new DesktopError(400, DESKTOP_INVALID_ARGUMENT_CODE, message);
}

/** A body as a valid request, or a 400 INVALID_ARGUMENT naming the first problem. */
export function parseDesktopActionRequest(body: unknown): DesktopActionRequest {
  const parsed = requestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(`${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`);
  }
  const request = parsed.data as DesktopActionRequest;
  const { action } = request;
  const fields = ACTION_FIELDS[action];
  for (const key of fields.required) {
    if (request[key] === undefined) throw invalid(`${action} needs ${key}.`);
  }
  for (const key of Object.keys(request) as (keyof DesktopActionRequest)[]) {
    if (key === "action" || key === "actor" || request[key] === undefined) continue;
    if (!fields.required.includes(key) && !fields.allowed.includes(key)) throw invalid(`${action} takes no ${key}.`);
  }
  if ((request.x === undefined) !== (request.y === undefined)) throw invalid("x and y go together.");
  if (request.screenshotId !== undefined && request.x === undefined) throw invalid("screenshotId names the space of x and y: pass them too.");
  if (request.region !== undefined && request.windowId !== undefined) throw invalid("Pass region or windowId, not both.");
  if (!isReadOnlyDesktopAction(action) && request.maxSize !== undefined && request.screenshot !== true) {
    throw invalid("maxSize goes with screenshot: true.");
  }
  if (action === "wait") {
    const kind = request.for ?? "idle";
    if (kind === "idle" && request.since !== undefined) throw invalid("since goes with for: \"change\".");
    if (kind === "change" && request.idleMs !== undefined) throw invalid("idleMs goes with for: \"idle\".");
  }
  if (action === "type") {
    const text = request.text!;
    if (text.length === 0) throw invalid("type needs some text.");
    if ([...text].length > DESKTOP_TYPE_MAX_CHARS) throw invalid(`text is longer than ${DESKTOP_TYPE_MAX_CHARS} characters.`);
    // \n types Return and \t Tab; no other control character has a key.
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) throw invalid("text may hold no control characters but newlines and tabs.");
  }
  if (action === "clipboard_set" && Buffer.byteLength(request.text!, "utf8") > DESKTOP_CLIPBOARD_MAX_BYTES) {
    throw invalid(`text is larger than ${DESKTOP_CLIPBOARD_MAX_BYTES} bytes.`);
  }
  return request;
}
