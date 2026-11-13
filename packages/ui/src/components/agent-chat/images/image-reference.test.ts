import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AttachmentRef } from "@orquester/api/agent-chat";

import { readPersistedDrafts } from "../../../lib/agent-chat/composer.logic";
import type { ApiClient } from "../../../lib/api-client";
import { registerComposerHandle, type ComposerHandle } from "../composer/composer-bridge";
import { attachImageAsReference } from "./image-reference";

/** A 1×1 PNG's signature and header: enough for the bytes to read as one. */
const PNG_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const REF: AttachmentRef = {
  type: "image",
  id: "s1-0f8fad5b-d9cb-469f-a165-70867728950e-png",
  name: "dog.png",
  mimeType: "image/png",
  sizeBytes: 68,
  path: "/appdir/threads/s1/attachments/dog.png"
};

describe("Use as reference", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key)
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it("keeps the uploaded image in the chat's draft when its composer goes away during the upload", async () => {
    const unregister = registerComposerHandle("s1", {
      stageAttachment: () => true,
      insertText: () => undefined
    } as unknown as ComposerHandle);
    const api = {
      agentChat: {
        upload: async () => {
          // The tab switched away while the bytes were on their way.
          unregister();
          return REF;
        }
      }
    } as unknown as ApiClient;

    await attachImageAsReference({ api, sessionId: "s1", url: PNG_URL, name: "dog.png" });
    assert.deepEqual(readPersistedDrafts().s1?.attachments.map((attachment) => attachment.id), [REF.id]);
  });
});
