/**
 * Forge links rendered where the chat shows text: assistant markdown (autolinks
 * become short-label pills, a link with the author's words keeps them, a badge
 * image link and other links stay as they were) and a user's plain-text bubble.
 * Rendered, not mounted, and with no API client: nothing is read. (Server
 * rendering reads the store's initial state, which has no projects, so every
 * label here carries its owner/repo; the DOM test covers the project's own repo.)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChatMarkdown } from "../timeline/markdown/ChatMarkdown";
import { TimelineRowContext, type TimelineRowContextValue } from "../timeline/context";
import { UserMessageRow } from "../timeline/rows/MessageRows";

const P = "/w/ws/app";

test("assistant autolinks become pills with short labels", () => {
  const text = [
    "See https://github.com/acme/app/pull/12 and https://github.com/other/lib/issues/3.",
    "",
    "Commit <https://github.com/acme/app/commit/0123456789abcdef0123456789abcdef01234567>."
  ].join("\n");
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text }));
  assert.match(html, /<a href="https:\/\/github.com\/acme\/app\/pull\/12" target="_blank" rel="noopener noreferrer" data-forge-link="pull"/);
  assert.match(html, />acme\/app#12</);
  assert.match(html, />other\/lib#3</);
  assert.match(html, />acme\/app@0123456</);
  // The sentence's period stays outside the link.
  assert.match(html, /issues\/3"[^>]*>[\s\S]*?<\/a>\./);
});

test("a link with the author's words keeps them and gains the icon", () => {
  const html = renderToStaticMarkup(createElement(ChatMarkdown, { text: "Merged in [the parser fix](https://github.com/acme/app/pull/12)." }));
  assert.match(html, /data-forge-link="pull"[^>]*>[\s\S]*<svg[\s\S]*the parser fix<\/a>/);
  assert.doesNotMatch(html, /acme\/app#12/);
});

test("badge images, other hosts and look-alikes stay ordinary links", () => {
  const html = renderToStaticMarkup(
    createElement(ChatMarkdown, {
      text: [
        "[![CI](https://example.com/badge.svg)](https://github.com/acme/app/actions/runs/1)",
        "https://example.com/acme/app/pull/1",
        "https://github.com.evil.example/acme/app/pull/1"
      ].join("\n\n")
    })
  );
  assert.doesNotMatch(html, /data-forge-link/);
  assert.match(html, /<img src="https:\/\/example.com\/badge.svg"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("GitLab and Bitbucket change requests are pills too", () => {
  const html = renderToStaticMarkup(
    createElement(ChatMarkdown, { text: "https://gitlab.com/g/p/-/merge_requests/4 https://bitbucket.org/w/r/pull-requests/5" })
  );
  assert.match(html, /data-forge-link="gitlab"[\s\S]*?>g\/p!4</);
  assert.match(html, /data-forge-link="bitbucket"[\s\S]*?>w\/r#5</);
});

test("a user's plain-text message turns its GitHub URLs into pills and keeps the rest as typed", () => {
  const text = "Please look at https://github.com/acme/app/issues/9, then $review it. https://example.com/x stays text.";
  const row = {
    kind: "message",
    id: "r1",
    createdAt: "2026-10-14T00:00:00.000Z",
    message: { kind: "message", id: "m1", role: "user", text, turnId: "t1", streaming: false, createdAt: "t", updatedAt: "t" }
  };
  const context = {
    workspaceRoot: P,
    readOnly: true,
    canRevert: false,
    revertBusy: false,
    startedTurnCount: 1,
    skills: ["review"],
    onFork: null
  } as unknown as TimelineRowContextValue;
  const html = renderToStaticMarkup(
    createElement(TimelineRowContext.Provider, { value: context }, createElement(UserMessageRow, { row: row as never }))
  );
  assert.match(html, /Please look at <a href="https:\/\/github.com\/acme\/app\/issues\/9"[^>]*data-forge-link="issue"/);
  assert.match(html, />acme\/app#9</);
  assert.match(html, /<\/a>, then /);
  assert.match(html, /title="Skill: review"/);
  assert.match(html, /https:\/\/example.com\/x stays text\./);
});
