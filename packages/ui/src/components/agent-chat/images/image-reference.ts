/**
 * "Use as reference" on a chat image (design 2026-11-10 §9.1): the composer's
 * own upload (`POST /api/sessions/:id/upload`) staged as a chip through the
 * composer bridge, as a browser pick is. The app's alone — it needs the
 * composer — so the image actions reach it through the chat host
 * (`chat-host-app.tsx`), never by import.
 */

import type { ApiClient } from "../../../lib/api-client";
import { updateThreadDraft } from "../../../lib/agent-chat/store";
import { composerTextForDelivery } from "../../../lib/composer-inbox";
import {
  COMPOSER_NOT_MOUNTED_REASON,
  composerHandle,
  insertComposerText,
  stageComposerAttachment
} from "../composer/composer-bridge";
import { persistedDraftAfterReturn } from "../composer/composer-draft";
import { readImageBlob } from "./image-actions";

/**
 * Attach the image to the chat's composer for the next message: uploaded as
 * a new attachment of the chat, as a pasted image is, and staged as a chip.
 * Rejects, before anything is uploaded, when no composer shows the chat.
 * Once uploaded the image is never dropped: where the composer refuses the
 * chip (its attachment bound) its path goes into the draft, as the bridge
 * asks, and where the composer went away during the upload it goes into the
 * chat's saved draft, which the composer's next mount stages
 * (`persistedDraftAfterReturn`, as a message returned to an unmounted
 * composer does).
 */
export async function attachImageAsReference(input: {
  api: ApiClient;
  sessionId: string;
  url: string;
  name: string;
}): Promise<void> {
  if (composerHandle(input.sessionId) === null) throw new Error(COMPOSER_NOT_MOUNTED_REASON);
  const blob = await readImageBlob(input.url);
  const ref = await input.api.agentChat.upload(input.sessionId, blob, { name: input.name, type: blob.type });
  if (stageComposerAttachment(input.sessionId, ref)) return;
  if (composerHandle(input.sessionId) !== null) {
    insertComposerText(input.sessionId, composerTextForDelivery({ text: "", attachments: [ref] }), "append");
    return;
  }
  const message = { text: "", attachments: [ref], context: [] };
  updateThreadDraft(input.sessionId, (draft) => persistedDraftAfterReturn({ persisted: draft, message }));
}
