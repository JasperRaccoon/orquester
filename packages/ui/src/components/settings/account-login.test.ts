import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentAccount, UsageAccount } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { OrquesterProvider, type OrquesterProviderProps } from "../../context/orquester-context";
import { buildChatAccountOptions } from "../../lib/agent-chat/account-switch";
import { subscribeUsageTick } from "../../lib/usage-display";
import { AccountChip } from "../agent-chat/composer/ComposerChips";
import { UsageAccountCard } from "../topbar/UsageAccountCard";
import { normalizeUsageWindows } from "../topbar/usage-format";
import { AgentAccountsSettings } from "./AgentAccountsSettings";
import { UsageOverview } from "./UsageOverview";

const account: AgentAccount = {
  id: "a", agent: "claude", label: "Work", email: null, plan: "max", needsReauth: false,
  createdAt: "2026-09-01T00:00:00Z", importedAt: "2026-09-01T00:00:00Z", loginExpiresAt: "2026-10-01T00:00:00Z"
};
const reading: UsageAccount = {
  id: "a", label: "Work", available: true, stale: true, session: null, weekly: null,
  loginExpiresAt: account.loginExpiresAt,
  lastKnown: {
    session: { percent: 37, resetsAt: "2026-09-28T12:00:00Z" },
    weekly: { percent: 98, resetsAt: "2026-10-01T00:00:00Z" },
    asOf: "2026-09-28T10:00:00Z"
  }
};

test("a historical quota card shows the readings, observation time and expired-login warning", () => {
  const html = renderToStaticMarkup(createElement(UsageAccountCard, {
    name: "Work", windows: normalizeUsageWindows("claude", reading.lastKnown!), muted: true,
    resetFormat: "relative", now: Date.parse("2026-10-12T12:00:00Z"),
    login: reading, lastKnown: true, asOf: reading.lastKnown!.asOf
  }));
  assert.match(html, /Last known usage/);
  assert.match(html, /37%/);
  assert.match(html, /98%/);
  assert.match(html, /Login expired, please re-login/);
  assert.match(html, /text-warn/);
  assert.doesNotMatch(html, /No reading yet|Resets now/);
});

test("usage settings, account settings and the selected composer account carry the warning", (t) => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-12T12:00:00Z"));
  t.after(subscribeUsageTick(() => {}));
  // Zustand uses its initial snapshot for server rendering.
  const initial = useAppStore.getInitialState();
  const previous = { ...initial };
  t.after(() => Object.assign(initial, previous));
  Object.assign(initial, {
    agentAccounts: { accounts: [account], defaults: { claude: "a", codex: null, grok: null } },
    usage: { agents: [{ id: "claude", available: true, stale: true, session: null, weekly: null, accounts: [reading] }] }
  });
  const context = { useTitlebar: false, api: {} } as unknown as OrquesterProviderProps;
  const settings = renderToStaticMarkup(createElement(OrquesterProvider, { ...context, children: createElement(AgentAccountsSettings) }));
  assert.match(settings, /Login expired, please re-login/);
  const usage = renderToStaticMarkup(createElement(UsageOverview, { refreshing: false, onRefresh() {} }));
  assert.match(usage, /Last known usage/);
  assert.match(usage, /98%/);
  assert.match(usage, /Login expired, please re-login/);
  const options = buildChatAccountOptions({ refId: "claude", accounts: [account], shortLabel: (s) => s });
  const composer = renderToStaticMarkup(createElement(AccountChip, {
    label: "Work", options, selectedId: "a", canSwitch: false, onChange() {}
  }));
  assert.match(composer, /Login expired, please re-login/);
});
