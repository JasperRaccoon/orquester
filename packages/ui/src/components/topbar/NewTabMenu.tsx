import React, { useState } from "react";
import { FolderTree, GitBranch, Globe, ListTodo, Plus } from "lucide-react";
import { SYSTEM_ACCOUNT_ID, type RegistryEntry } from "@orquester/api";
import {
  AdaptiveMenu,
  DropdownEmpty,
  DropdownItem,
  DropdownLabel,
  DropdownSeparator,
  IconButton
} from "../ui";
import { getRegistryIcon } from "../../icons";
import { useRegistry } from "../../hooks";
import { useAppStore, useCurrentContext } from "../../store/app";

/**
 * One installed-agent row in the "+" menu. When the agent (`claude`/`codex`) has
 * ≥1 managed account, it renders an inline account picker (System + managed
 * accounts, defaulting to that agent's configured default) and passes the chosen
 * account id as the 4th `openTab` argument so the session launches under it. The
 * "System" option carries the SYSTEM_ACCOUNT_ID sentinel (not an empty/omitted
 * value) so it forces the host identity even when a per-agent default is set —
 * an omitted accountId would otherwise resolve back to that default.
 */
const AgentRow: React.FC<{ agent: RegistryEntry }> = ({ agent }) => {
  const openTab = useAppStore((s) => s.openTab);
  const agentAccounts = useAppStore((s) => s.agentAccounts);
  const managed = (agentAccounts?.accounts ?? []).filter((a) => a.agent === agent.id);
  const [picked, setPicked] = useState<string>(
    agentAccounts?.defaults[agent.id as "claude" | "codex"] ?? SYSTEM_ACCOUNT_ID
  );

  return (
    <>
      <DropdownItem
        icon={getRegistryIcon("agent", agent.id, 14)}
        onClick={() => void openTab("agent", agent.id, agent.name, picked)}
      >
        {agent.name}
      </DropdownItem>
      {managed.length > 0 ? (
        <select
          value={picked}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setPicked(event.target.value)}
          className="mb-1 ml-8 mr-2 w-[calc(100%-2.75rem)] rounded bg-neutral-900 px-1 py-0.5 text-xs text-neutral-300 outline-none ring-1 ring-neutral-700"
        >
          <option value={SYSTEM_ACCOUNT_ID}>System</option>
          {managed.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      ) : null}
    </>
  );
};

/**
 * The "+" new-tab button. In a project it lists detected shells and INSTALLED
 * agents (manage installs in Settings → Agents / Harnesses) plus built-in tools
 * and to-do lists; in a workspace context it offers only to-do lists. Choosing
 * an entry opens a tab in the current context.
 */
export const NewTabMenu: React.FC = () => {
  const openTab = useAppStore((s) => s.openTab);
  const openFileBrowser = useAppStore((s) => s.openFileBrowser);
  const openGit = useAppStore((s) => s.openGit);
  const openBrowser = useAppStore((s) => s.openBrowser);
  const api = useAppStore((s) => s.api);
  const ctx = useCurrentContext();
  const todos = useAppStore((s) => s.todos);
  const createTodo = useAppStore((s) => s.createTodo);
  const openTodo = useAppStore((s) => s.openTodo);
  const registry = useRegistry();

  const shells = registry.shells.filter((s) => s.enabled);
  const agents = registry.agents.filter((a) => a.enabled);
  // Browser tabs need BOTH chromium detected on the host AND a transport that can
  // stream frames. The desktop unix socket has no browserChannel, so a browser
  // record would open a dead blank tab — gate the entry on the channel too.
  const browserHasChannel = !!api?.browserChannel();
  const browserHostReady = registry.browsers.some((b) => b.enabled);

  const trigger = (
    <IconButton label="New tab" className="app-no-drag">
      <Plus size={16} />
    </IconButton>
  );

  if (ctx?.kind === "workspace") {
    const workspaceTodos = todos.filter((t) => t.scope === "workspace" && t.refKey === ctx.key);
    return (
      <AdaptiveMenu title="New tab" trigger={trigger} width="w-60">
        <DropdownLabel>To-do lists</DropdownLabel>
        <DropdownItem icon={<ListTodo size={14} />} onClick={() => void createTodo("workspace", ctx.key)}>
          New to-do list
        </DropdownItem>
        {workspaceTodos.map((rec) => (
          <DropdownItem key={rec.id} icon={<ListTodo size={14} />} onClick={() => openTodo(rec)}>
            {rec.name}
          </DropdownItem>
        ))}
      </AdaptiveMenu>
    );
  }

  const projectTodos = ctx ? todos.filter((t) => t.scope === "project" && t.refKey === ctx.key) : [];

  return (
    <AdaptiveMenu title="New tab" trigger={trigger} width="w-60">
      <DropdownLabel>Shells</DropdownLabel>
      {shells.length === 0 && <DropdownEmpty>No shells detected</DropdownEmpty>}
      {shells.map((shell) => (
        <DropdownItem
          key={shell.id}
          icon={getRegistryIcon("shell", shell.id, 14)}
          onClick={() => void openTab("shell", shell.id, shell.name)}
        >
          {shell.name}
        </DropdownItem>
      ))}

      <DropdownSeparator />

      <DropdownLabel>Tools</DropdownLabel>
      <DropdownItem icon={<FolderTree size={14} />} onClick={() => openFileBrowser()}>
        File Browser
      </DropdownItem>
      <DropdownItem icon={<GitBranch size={14} />} onClick={() => openGit()}>
        Git
      </DropdownItem>
      {browserHasChannel && browserHostReady ? (
        <DropdownItem icon={<Globe size={14} />} onClick={() => void openBrowser()}>
          Browser
        </DropdownItem>
      ) : !browserHasChannel ? (
        <DropdownEmpty>Browser — needs a remote (HTTP) connection</DropdownEmpty>
      ) : (
        <DropdownEmpty>Browser — install chromium on the host</DropdownEmpty>
      )}
      <DropdownItem
        icon={<ListTodo size={14} />}
        onClick={() => ctx && void createTodo("project", ctx.key, "to-dos")}
      >
        New to-do list
      </DropdownItem>
      {projectTodos.map((rec) => (
        <DropdownItem key={rec.id} icon={<ListTodo size={14} />} onClick={() => openTodo(rec)}>
          {rec.name}
        </DropdownItem>
      ))}

      <DropdownSeparator />

      <DropdownLabel>Agents</DropdownLabel>
      {agents.length === 0 && <DropdownEmpty>No agents installed</DropdownEmpty>}
      {agents.map((agent) => (
        <AgentRow key={agent.id} agent={agent} />
      ))}
    </AdaptiveMenu>
  );
};
