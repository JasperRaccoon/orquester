import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  CreateSavedPromptRequest,
  SavedPrompt,
  UpdateSavedPromptRequest
} from "@orquester/api";

import type { SavedPromptResult } from "../../../lib/saved-prompts/store.ts";
import type { SavedPromptEditorRequest } from "./editor-bridge.ts";
import { initialDraft } from "./editor.logic.ts";
import { createSavedPromptSaver, type SavedPromptSaverDeps } from "./editor-save.ts";

const PROJECT = "/w/acme/app";

function prompt(overrides: Partial<SavedPrompt> = {}): SavedPrompt {
  return {
    id: "p1",
    title: "Review",
    description: "",
    body: "Review {diff}",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakes(answer: () => Promise<SavedPromptResult>) {
  const calls = {
    created: [] as CreateSavedPromptRequest[],
    updated: [] as { id: string; patch: UpdateSavedPromptRequest }[],
    saved: [] as SavedPrompt[],
    lateFailures: [] as string[]
  };
  const deps: SavedPromptSaverDeps = {
    create: (request) => {
      calls.created.push(request);
      return answer();
    },
    update: (id, patch) => {
      calls.updated.push({ id, patch });
      return answer();
    },
    onSaved: (saved) => {
      calls.saved.push(saved);
    },
    onFailedAfterClose: (error) => {
      calls.lateFailures.push(error);
    }
  };
  return { calls, deps };
}

const CREATE: SavedPromptEditorRequest = { mode: "create", projectPath: PROJECT };
const draftOf = (request: SavedPromptEditorRequest) => ({ ...initialDraft(request), title: "Fix tests", body: "Run them" });

describe("the editor's save", () => {
  it("an edit that changes nothing sends nothing, and closes", async () => {
    const { calls, deps } = fakes(async () => ({ ok: true, prompt: null }));
    const editing: SavedPromptEditorRequest = { mode: "edit", projectPath: PROJECT, prompt: prompt() };
    assert.deepEqual(await createSavedPromptSaver(deps).save(editing, initialDraft(editing)), {
      status: "unchanged"
    });
    assert.deepEqual(calls.updated, []);
  });

  it("an invalid draft is not sent", async () => {
    const { calls, deps } = fakes(async () => ({ ok: true, prompt: null }));
    assert.deepEqual(await createSavedPromptSaver(deps).save(CREATE, initialDraft(CREATE)), { status: "invalid" });
    assert.deepEqual(calls.created, []);
  });

  it("one save at a time: a second while the first is in flight is not sent", async () => {
    const answer = deferred<SavedPromptResult>();
    const { calls, deps } = fakes(() => answer.promise);
    const saver = createSavedPromptSaver(deps);
    const first = saver.save(CREATE, draftOf(CREATE));
    assert.equal(saver.saving, true);
    assert.deepEqual(await saver.save(CREATE, draftOf(CREATE)), { status: "busy" });
    answer.resolve({ ok: true, prompt: null });
    assert.equal((await first).status, "saved");
    assert.equal(saver.saving, false);
    assert.equal(calls.created.length, 1);
  });

  it("closed while saving: a success still lands and is revealed", async () => {
    const answer = deferred<SavedPromptResult>();
    const created = prompt({ id: "late" });
    const { calls, deps } = fakes(() => answer.promise);
    const saver = createSavedPromptSaver(deps);
    const pending = saver.save(CREATE, draftOf(CREATE));
    saver.close();
    answer.resolve({ ok: true, prompt: created });
    assert.equal((await pending).status, "saved");
    assert.deepEqual(calls.saved, [created]);
    assert.deepEqual(calls.lateFailures, []);
  });

  it("closed while saving: a failure becomes the panel's notice", async () => {
    const answer = deferred<SavedPromptResult>();
    const { calls, deps } = fakes(() => answer.promise);
    const saver = createSavedPromptSaver(deps);
    const pending = saver.save(CREATE, draftOf(CREATE));
    saver.close();
    answer.resolve({ ok: false, error: "Saved prompts are full" });
    assert.equal((await pending).status, "failed");
    assert.deepEqual(calls.lateFailures, ["Saved prompts are full"]);
  });

  it("a request that throws is a failure, and the guard is released", async () => {
    const { deps } = fakes(async () => {
      throw new Error("socket closed");
    });
    const saver = createSavedPromptSaver(deps);
    assert.deepEqual(await saver.save(CREATE, draftOf(CREATE)), { status: "failed", error: "socket closed" });
    assert.equal(saver.saving, false);
  });
});
