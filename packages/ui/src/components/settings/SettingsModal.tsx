import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Github,
  MessageSquare,
  Palette,
  Search,
  Server,
  SlidersHorizontal,
  Users,
  X
} from "lucide-react";
import { cn } from "../../lib/cn";
import { Modal, ModalCloseButton } from "../ui";
import { useIsDesktop } from "../../hooks";
import { useAppStore } from "../../store/app";
import { AgentAccountsSettings } from "./AgentAccountsSettings";
import { AgentsSettings } from "./AgentsSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { ChatSettings } from "./ChatSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitHostingSettings } from "./GitHostingSettings";
import { HostStatusSettings } from "./HostStatusSettings";
import { ServerSettings } from "./ServerSettings";
import { SettingsPageTitleContext } from "./primitives";
import { UsageSettings } from "./UsageSettings";

type SectionId =
  | "general"
  | "appearance"
  | "chat"
  | "agents"
  | "accounts"
  | "usage"
  | "git-hosting"
  | "server"
  | "system";

type GroupId = "personal" | "agents" | "integrations" | "server";

interface SectionDef {
  id: SectionId;
  group: GroupId;
  label: string;
  icon: React.ReactNode;
  desc: string;
  /** Extra search terms: the settings a page holds, so search finds them. */
  keywords: string[];
  render: () => React.ReactNode;
}

const GROUPS: { id: GroupId; label: string }[] = [
  { id: "personal", label: "Personal" },
  { id: "agents", label: "Agents" },
  { id: "integrations", label: "Integrations" },
  { id: "server", label: "Server" }
];

const SECTIONS: SectionDef[] = [
  {
    id: "general",
    group: "personal",
    label: "General",
    icon: <SlidersHorizontal size={15} />,
    desc: "Window, tabs, notifications and app version",
    keywords: ["app", "titlebar", "confirm", "close", "background", "tray", "push", "notifications", "reload", "runtime", "version", "about"],
    render: () => <GeneralSettings />
  },
  {
    id: "appearance",
    group: "personal",
    label: "Appearance",
    icon: <Palette size={15} />,
    desc: "Colour scheme, light/dark mode and terminal font",
    keywords: ["theme", "color", "colour", "dark", "light", "mode", "scheme", "font", "terminal", "size"],
    render: () => <AppearanceSettings />
  },
  {
    id: "chat",
    group: "personal",
    label: "Agent chat",
    icon: <MessageSquare size={15} />,
    desc: "Composer behaviour and resuming interrupted turns",
    keywords: ["composer", "steer", "queue", "enter", "skills", "slash", "continue", "restart", "resume", "interrupted"],
    render: () => <ChatSettings />
  },
  {
    id: "agents",
    group: "agents",
    label: "Harnesses",
    icon: <Boxes size={15} />,
    desc: "Install and update agent CLIs, harness options",
    keywords: ["agents", "install", "update", "version", "claude", "codex", "grok", "timeout", "stream", "cli"],
    render: () => <AgentsSettings />
  },
  {
    id: "accounts",
    group: "agents",
    label: "Accounts",
    icon: <Users size={15} />,
    desc: "Managed Claude, Codex & Grok logins",
    keywords: ["login", "credentials", "auth", "import", "default", "device", "claude", "codex", "grok", "reauth"],
    render: () => <AgentAccountsSettings />
  },
  {
    id: "usage",
    group: "agents",
    label: "Usage",
    icon: <Gauge size={15} />,
    desc: "Quota overview and the top-bar usage chip",
    keywords: ["quota", "limits", "rate", "chip", "top bar", "reset", "plan"],
    render: () => <UsageSettings />
  },
  {
    id: "git-hosting",
    group: "integrations",
    label: "Git hosting",
    icon: <Github size={15} />,
    desc: "GitHub & Bitbucket accounts, SSH keys and repo access",
    keywords: ["github", "bitbucket", "data center", "token", "pat", "ssh", "key", "repo", "identity", "git"],
    render: () => <GitHostingSettings />
  },
  {
    id: "server",
    group: "server",
    label: "Server",
    icon: <Server size={15} />,
    desc: "Workspaces directory, remote access and archived data",
    keywords: ["daemon", "workspaces", "directory", "http", "host", "port", "password", "remote", "archived", "protect"],
    render: () => <ServerSettings />
  },
  {
    id: "system",
    group: "server",
    label: "Host status",
    icon: <Activity size={15} />,
    desc: "CPU, memory, disk, processes and listening ports",
    keywords: ["system", "cpu", "memory", "ram", "disk", "processes", "ports", "kill", "resources"],
    render: () => <HostStatusSettings />
  }
];

/**
 * Old section ids other code (or an older bookmark of the store) may still ask
 * for, mapped onto their new home.
 */
const SECTION_ALIASES: Record<string, SectionId> = { app: "general", daemon: "server" };

const findSection = (id: string | null | undefined): SectionDef | undefined => {
  if (!id) return undefined;
  const resolved = SECTION_ALIASES[id] ?? id;
  return SECTIONS.find((s) => s.id === resolved);
};

const matches = (section: SectionDef, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [section.label, section.desc, ...section.keywords].some((t) => t.toLowerCase().includes(q));
};

/** Nav entries grouped under their headers, filtered by the search box. */
const useGroupedSections = (query: string) =>
  useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        sections: SECTIONS.filter((s) => s.group === g.id && matches(s, query))
      })).filter((g) => g.sections.length > 0),
    [query]
  );

const SearchBox: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}> = ({ value, onChange, onSubmit, inputRef }) => (
  <div className="relative">
    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
    <input
      ref={inputRef}
      type="search"
      aria-label="Search settings"
      placeholder="Search settings"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit();
        // Clear first; a second Escape falls through to the modal and closes it.
        if (e.key === "Escape" && value) {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onChange("");
        }
      }}
      className={cn(
        "h-8 w-full rounded-md border border-neutral-800 bg-neutral-900 pl-8 pr-7 text-sm text-neutral-100",
        "placeholder:text-neutral-500 focus:border-neutral-600 focus:outline-none",
        "[&::-webkit-search-cancel-button]:hidden"
      )}
    />
    {value && (
      <button
        type="button"
        aria-label="Clear search"
        onClick={() => onChange("")}
        className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
      >
        <X size={12} />
      </button>
    )}
  </div>
);

export const SettingsModal: React.FC = () => {
  const open = useAppStore((s) => s.settingsOpen);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const loadAgentAccounts = useAppStore((s) => s.loadAgentAccounts);
  const isDesktop = useIsDesktop();
  const requestedSection = useAppStore((s) => s.settingsSection);
  const [section, setSection] = useState<SectionId | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const grouped = useGroupedSections(query);

  // Mobile resets to the category list each time it closes; the desktop keeps
  // the last page so reopening lands where the user left off. Managed accounts
  // are refreshed on open in case another client changed them.
  //
  // A caller may deep-link a section — the agent-auth toast opens Accounts
  // (§7.7) — so an opening modal honours the request. The name is validated
  // against the real list: it arrives as a plain string so the store stays
  // free of this module's union.
  useEffect(() => {
    if (!open) {
      setQuery("");
      if (!isDesktop) setSection(null);
      return;
    }
    const requested = findSection(requestedSection);
    if (requested) {
      setSection(requested.id);
    }
    void loadAgentAccounts();
  }, [open, requestedSection, loadAgentAccounts, isDesktop]);

  // A new page starts at its top, not wherever the previous one was scrolled.
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const close = () => setOpen(false);
  const firstMatch = grouped[0]?.sections[0];

  // --- Desktop: grouped side nav + content ---
  if (isDesktop) {
    const current = findSection(section) ?? SECTIONS[0];
    return (
      <Modal open={open} onClose={close} className="h-[88vh] max-w-6xl">
        <nav
          aria-label="Settings sections"
          className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40"
        >
          <div className="space-y-3 p-3 pb-2">
            <p className="px-1 text-sm font-semibold text-neutral-100">Settings</p>
            <SearchBox
              value={query}
              onChange={setQuery}
              onSubmit={() => firstMatch && setSection(firstMatch.id)}
              inputRef={searchRef}
            />
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-3 pt-2">
            {grouped.length === 0 && (
              <p className="px-2 py-3 text-xs text-neutral-500">No settings match “{query.trim()}”.</p>
            )}
            {grouped.map((g) => (
              <div key={g.id} className="space-y-0.5">
                <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
                  {g.label}
                </p>
                {g.sections.map((s) => {
                  const active = current.id === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSection(s.id)}
                      title={s.desc}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        "focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500",
                        active
                          ? "bg-neutral-800 text-neutral-100"
                          : "text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200"
                      )}
                    >
                      <span className={active ? "text-neutral-200" : "text-neutral-500"}>{s.icon}</span>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </nav>
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="absolute right-3 top-3 z-10">
            <ModalCloseButton onClose={close} />
          </div>
          <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-8 pb-6 pt-7">
            {current.render()}
          </div>
        </div>
      </Modal>
    );
  }

  // --- Mobile: category list → page with a back button ---
  const currentMobile = findSection(section);
  return (
    <Modal open={open} onClose={close} className="h-[88vh]">
      <div className="flex w-full flex-col">
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
          {currentMobile ? (
            <button
              type="button"
              aria-label="Back"
              onClick={() => setSection(null)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800"
            >
              <ChevronLeft size={18} />
            </button>
          ) : (
            <span className="px-2" />
          )}
          <span className="flex-1 text-sm font-medium text-neutral-100">
            {currentMobile ? currentMobile.label : "Settings"}
          </span>
          <ModalCloseButton onClose={close} />
        </div>

        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto">
          {currentMobile ? (
            <div className="p-4">
              <SettingsPageTitleContext.Provider value={false}>{currentMobile.render()}</SettingsPageTitleContext.Provider>
            </div>
          ) : (
            <div className="space-y-4 p-3">
              <SearchBox
                value={query}
                onChange={setQuery}
                onSubmit={() => firstMatch && setSection(firstMatch.id)}
              />
              {grouped.length === 0 && (
                <p className="px-2 text-xs text-neutral-500">No settings match “{query.trim()}”.</p>
              )}
              {grouped.map((g) => (
                <div key={g.id} className="space-y-1">
                  <p className="px-2 text-[10px] font-medium uppercase tracking-wider text-neutral-500">{g.label}</p>
                  <div className="divide-y divide-neutral-800/80 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
                    {g.sections.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setSection(s.id)}
                        className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-neutral-800/60"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-300">
                          {s.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-neutral-100">{s.label}</span>
                          <span className="block text-xs leading-snug text-neutral-500">{s.desc}</span>
                        </span>
                        <ChevronRight size={16} className="shrink-0 text-neutral-600" />
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
