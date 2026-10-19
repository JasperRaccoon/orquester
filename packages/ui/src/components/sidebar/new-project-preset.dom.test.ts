/**
 * The new-project modal opened by a repo group's "+" (spec 2026-10-18 §4): the
 * repo is fixed, only a fresh, unused name is asked for, and the submit goes
 * through the existing server-side clone or typed `git clone` paths. Without
 * a preset it opens as it always did.
 */

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { CreateProjectRequest } from "@orquester/api";

import { ApiError } from "../../lib/api-client";
import { useAppStore, type CreateProjectWithCommandOptions } from "../../store/app";
import type { NewProjectPreset } from "./NewProjectModal";

// Loaded once the DOM globals exist: react-dom decides at load time which DOM events it can use.
let act: typeof import("react-dom/test-utils").act;
let createRoot: typeof import("react-dom/client").createRoot;
let NewProjectModal: typeof import("./NewProjectModal").NewProjectModal;

let dom: JSDOM;
const globals = ["window", "document", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "navigator", "KeyboardEvent", "MouseEvent", "Event"] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  dom = new JSDOM("<!doctype html><body></body>", { url: "http://localhost/" });
  for (const name of globals) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true
    });
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ act } = await import("react-dom/test-utils"));
  ({ createRoot } = await import("react-dom/client"));
  ({ NewProjectModal } = await import("./NewProjectModal"));
});

after(() => {
  for (const name of globals) {
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const URL_ = "https://github.com/JasperRaccoon/JasperEngine.git";
const PRESET: NewProjectPreset = { kind: "clone-repo", url: URL_, repoLabel: "JasperRaccoon/JasperEngine" };

const ACCOUNT = {
  id: "a1",
  label: "Jasper",
  provider: "github",
  login: "jasper",
  githubLogin: "jasper",
  host: "github.com",
  gitName: "Jasper",
  gitEmail: "j@example.com",
  publicKey: "ssh-ed25519 AAAA",
  repoAccess: true
};

describe("the new-project modal with a clone preset", () => {
  let root: Root;
  let created: CreateProjectRequest[];
  let typed: Array<[CreateProjectRequest, string, CreateProjectWithCommandOptions | undefined]>;
  /** What the server-side clone throws, if anything. */
  let cloneFails: Error | null;
  let listed: number;
  const initial = { ...useAppStore.getState() };

  beforeEach(() => {
    // The review step arms its confirm, and the modal hands focus back, on timers.
    mock.timers.enable({ apis: ["setTimeout"] });
    created = [];
    typed = [];
    cloneFails = null;
    listed = 0;
    const mount = document.createElement("div");
    document.body.replaceChildren(mount);
    root = createRoot(mount);
  });

  afterEach(() => {
    act(() => root.unmount());
    mock.timers.runAll();
    mock.timers.reset();
    useAppStore.setState(initial, true);
  });

  const open = async (linked: boolean, preset: NewProjectPreset | null) => {
    useAppStore.setState({
      currentWorkspace: "ws",
      workspaces: [{ name: "ws", path: "/w/ws", projectCount: 2, ...(linked ? { gitAccountId: "a1" } : {}) }],
      accounts: [ACCOUNT],
      projects: [
        { name: "JasperEngine", workspace: "ws", path: "/w/ws/JasperEngine" },
        { name: "Old", workspace: "ws", path: "/w/ws/Old", isArchived: true }
      ],
      listRepos: async () => {
        listed += 1;
        return [];
      },
      listOwners: async () => {
        listed += 1;
        return [];
      },
      createProject: async (req: CreateProjectRequest) => {
        created.push(req);
        if (cloneFails) throw cloneFails;
      },
      createProjectWithCommand: async (
        req: CreateProjectRequest,
        command: string,
        options?: CreateProjectWithCommandOptions
      ) => {
        typed.push([req, command, options]);
      }
    } as never);
    await act(async () => {
      root.render(createElement(NewProjectModal, { open: true, onClose: () => undefined, preset }));
    });
  };

  const buttonNamed = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);
  const nameInput = () => document.querySelector<HTMLInputElement>("#new-clone-name");
  const typeName = async (value: string) => {
    const input = nameInput()!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  it("fixes the repo: titled after it, no mode tabs, URL or picker, the name empty and focused", async () => {
    await open(true, PRESET);
    assert.ok(document.body.textContent?.includes("New clone of JasperRaccoon/JasperEngine"));
    assert.equal(buttonNamed("Empty"), undefined);
    assert.equal(document.querySelectorAll("input").length, 1);
    assert.equal(nameInput()?.value, "");
    assert.equal(document.activeElement, nameInput());
    assert.equal(buttonNamed("Clone")?.disabled, true);
    assert.equal(listed, 0, "nothing to pick, so no repo list is loaded");
  });

  it("flags a name the workspace already has, archived ones included, before submit", async () => {
    await open(true, PRESET);
    await typeName("Old");
    assert.match(document.body.textContent ?? "", /already has a project called\s*Old/);
    assert.equal(buttonNamed("Clone")?.disabled, true);
    await typeName("JasperEngine");
    assert.equal(buttonNamed("Clone")?.disabled, true);
  });

  it("clones server-side with the typed name when the workspace's account can", async () => {
    await open(true, PRESET);
    await typeName(" Shader optimization ");
    await act(async () => buttonNamed("Clone")!.click());
    assert.deepEqual(created, [{ source: "clone", url: URL_, name: "Shader optimization" }]);
    assert.deepEqual(typed, []);
  });

  it("without an account, reviews and types `git clone` into the typed folder", async () => {
    await open(false, PRESET);
    await typeName("Multiplayer");
    await act(async () => buttonNamed("Review")!.click());
    assert.ok(document.body.textContent?.includes(`git clone '${URL_}' .`));
    await act(async () => mock.timers.tick(400));
    await act(async () => buttonNamed("Create & run")!.click());
    assert.deepEqual(typed, [
      [{ source: "empty", name: "Multiplayer" }, `git clone '${URL_}' .`, { followClone: true }]
    ]);
    assert.deepEqual(created, []);
  });

  const text = () => document.body.textContent ?? "";

  it("a server-side clone the account cannot do offers the typed clone, same URL and name", async () => {
    cloneFails = new ApiError(404, "POST", "/api/workspaces/ws/projects", undefined, { message: "Repository not found" });
    await open(true, PRESET);
    await typeName("Multiplayer");
    await act(async () => buttonNamed("Clone")!.click());
    assert.match(text(), /Repository not found/);
    await act(async () => buttonNamed("Clone in a terminal instead")!.click());
    assert.ok(text().includes(`git clone '${URL_}' .`), "straight to the typed clone's review");
    assert.equal(buttonNamed("Clone in a terminal instead"), undefined);
    await act(async () => mock.timers.tick(400));
    await act(async () => buttonNamed("Create & run")!.click());
    assert.deepEqual(typed, [
      [{ source: "empty", name: "Multiplayer" }, `git clone '${URL_}' .`, { followClone: true }]
    ]);
    assert.equal(created.length, 1, "the failed server-side attempt only");
  });

  it("a taken name is not offered the typed clone", async () => {
    cloneFails = new ApiError(409, "POST", "/api/workspaces/ws/projects", undefined, { message: "Folder exists" });
    await open(true, PRESET);
    await typeName("Multiplayer");
    await act(async () => buttonNamed("Clone")!.click());
    assert.match(text(), /Folder exists/);
    assert.equal(buttonNamed("Clone in a terminal instead"), undefined);
  });

  it("types any daemon-supplied URL form, the scp form without a user included", async () => {
    const scp = "github.com:JasperRaccoon/JasperEngine.git";
    await open(false, { ...PRESET, url: scp });
    await typeName("Multiplayer");
    await act(async () => buttonNamed("Review")!.click());
    assert.ok(text().includes(`git clone '${scp}' .`));
    await act(async () => mock.timers.tick(400));
    await act(async () => buttonNamed("Create & run")!.click());
    assert.deepEqual(typed, [[{ source: "empty", name: "Multiplayer" }, `git clone '${scp}' .`, { followClone: true }]]);
  });

  for (const [what, url] of [
    ["a quote", "https://github.com/o/it's.git"],
    ["whitespace", "https://github.com/o/r .git"],
    ["a control character", "https://github.com/o/r\u001b]0;x\u0007.git"]
  ] as const) {
    it(`refuses to type a preset URL with ${what}`, async () => {
      await open(false, { ...PRESET, url });
      await typeName("Multiplayer");
      await act(async () => buttonNamed("Review")!.click());
      assert.match(text(), /cannot be typed into a terminal safely/);
      assert.equal(buttonNamed("Create & run"), undefined, "no review");
      assert.deepEqual(typed, []);
    });
  }

  it("opens as before without a preset", async () => {
    await open(true, null);
    assert.ok(document.body.textContent?.includes("New project"));
    assert.equal(buttonNamed("Empty")?.getAttribute("aria-pressed"), "true");
    assert.equal(nameInput(), null);
  });
});
