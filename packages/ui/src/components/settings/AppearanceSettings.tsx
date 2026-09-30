import React from "react";
import { Check, Clock, Minus, Monitor, Moon, Plus, Sun } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  COLOR_SCHEMES,
  THEME_MODES,
  type ColorScheme,
  type ResolvedMode,
  type ThemeMode
} from "../../lib/theme";
import {
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  TERMINAL_FONT_STEP,
  defaultTerminalFontSize
} from "../../lib/terminal-font";
import { Button } from "../ui";
import { useAppStore } from "../../store/app";
import { SettingRow, SettingsCard, SettingsPage, SettingsSection } from "./primitives";

const MODE_ICON: Record<ThemeMode, React.ReactNode> = {
  system: <Monitor size={12} />,
  light: <Sun size={12} />,
  dark: <Moon size={12} />,
  dynamic: <Clock size={12} />
};

/** What each mode follows — shown under its preview card. */
const MODE_HINT: Record<ThemeMode, string> = {
  system: "Follows your OS",
  light: "Always light",
  dark: "Always dark",
  dynamic: "Follows time of day"
};

/** Shared keyboard focus ring for the picker tiles (offset against the card). */
const TILE_FOCUS =
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-900";

/**
 * A miniature of the app painted with a theme's own variables — the same
 * `[data-scheme][data-mode]` selectors the real chrome uses, so a preview can
 * never drift from the theme it advertises.
 */
const ThemePreview: React.FC<{ scheme: ColorScheme; mode: ResolvedMode }> = ({ scheme, mode }) => (
  <span data-scheme={scheme} data-mode={mode} className="flex h-16 w-full bg-neutral-950">
    <span className="flex h-full w-1/3 flex-col gap-1 bg-neutral-900 p-1.5">
      <span className="h-1 w-full rounded-full bg-neutral-700" />
      <span className="h-1 w-3/4 rounded-full bg-neutral-800" />
      <span className="h-1 w-2/3 rounded-full bg-neutral-800" />
    </span>
    <span className="flex h-full flex-1 flex-col gap-1 p-1.5">
      <span className="h-1.5 w-1/2 rounded-full bg-neutral-300" />
      <span className="h-1 w-full rounded-full bg-neutral-700" />
      <span className="h-1 w-4/5 rounded-full bg-neutral-800" />
    </span>
  </span>
);

/** Same trick as {@link ThemePreview}: a gradient across the scheme's own steps. */
const ThemeSwatch: React.FC<{ scheme: ColorScheme; mode: ResolvedMode }> = ({ scheme, mode }) => (
  <span
    data-scheme={scheme}
    data-mode={mode}
    className="relative flex h-11 w-11 overflow-hidden rounded-full ring-1 ring-inset ring-neutral-400/40"
    style={{
      background:
        "linear-gradient(135deg, rgb(var(--n-200)) 0%, rgb(var(--n-400)) 30%, rgb(var(--n-700)) 62%, rgb(var(--n-950)) 100%)"
    }}
  />
);

export const AppearanceSettings: React.FC = () => {
  const scheme = useAppStore((s) => s.colorScheme);
  const themeMode = useAppStore((s) => s.themeMode);
  const resolvedMode = useAppStore((s) => s.resolvedMode);
  const setColorScheme = useAppStore((s) => s.setColorScheme);
  const setThemeMode = useAppStore((s) => s.setThemeMode);

  return (
    <SettingsPage title="Appearance" description="Theme and terminal text size. Saved on this device.">
      <SettingsSection title="Mode" description="Light, dark, or let the OS or the time of day decide." bare>
        <div role="radiogroup" aria-label="Colour mode" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {THEME_MODES.map((m) => {
            const selected = m.id === themeMode;
            // System/dynamic preview whatever they currently resolve to.
            const previewMode: ResolvedMode =
              m.id === "light" ? "light" : m.id === "dark" ? "dark" : resolvedMode;
            const follows = m.id === "system" || m.id === "dynamic";
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setThemeMode(m.id)}
                className={cn(
                  "overflow-hidden rounded-xl border text-left transition-colors",
                  TILE_FOCUS,
                  selected
                    ? "border-neutral-300 ring-1 ring-neutral-300"
                    : "border-neutral-800 hover:border-neutral-600"
                )}
              >
                <span className="relative block">
                  <ThemePreview scheme={scheme} mode={previewMode} />
                  <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900/80 text-neutral-300">
                    {MODE_ICON[m.id]}
                  </span>
                </span>
                <span className="flex items-start justify-between gap-1 border-t border-neutral-800 bg-neutral-900/40 px-2.5 py-2">
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-xs font-medium",
                        selected ? "text-neutral-100" : "text-neutral-300"
                      )}
                    >
                      {m.label}
                    </span>
                    <span className="block truncate text-[11px] text-neutral-500">
                      {selected && follows ? `Now ${resolvedMode}` : MODE_HINT[m.id]}
                    </span>
                  </span>
                  {selected && (
                    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-900">
                      <Check size={10} strokeWidth={3} />
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Colour scheme"
        description="Repaints the whole app; the code editor follows light/dark. Only the terminal keeps its own dark palette."
        bare
      >
        <SettingsCard className="p-2">
          <div role="radiogroup" aria-label="Colour scheme" className="flex flex-wrap gap-1">
            {COLOR_SCHEMES.map((s) => {
              const selected = s.id === scheme;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setColorScheme(s.id)}
                  className={cn(
                    "group flex w-[5.25rem] flex-col items-center gap-2 rounded-lg px-1 py-2.5 transition-colors",
                    TILE_FOCUS,
                    !selected && "hover:bg-neutral-800/40"
                  )}
                >
                  <span
                    className={cn(
                      "relative rounded-full ring-offset-2 ring-offset-neutral-900 transition-shadow",
                      selected ? "ring-2 ring-neutral-200" : "ring-0"
                    )}
                  >
                    <ThemeSwatch scheme={s.id} mode={resolvedMode} />
                    {selected && (
                      <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-neutral-100 text-neutral-900 ring-2 ring-neutral-900">
                        <Check size={10} strokeWidth={3} />
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-[11px]",
                      selected ? "font-medium text-neutral-100" : "text-neutral-400 group-hover:text-neutral-200"
                    )}
                  >
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Terminal">
        <TerminalFontSizeRow />
      </SettingsSection>
    </SettingsPage>
  );
};

/**
 * Terminal font size stepper. The store only exposes a clamped, persisting
 * `nudgeTerminalFontSize(delta)`, so "Reset" nudges by the distance to this
 * device's default rather than writing an absolute value.
 */
const TerminalFontSizeRow: React.FC = () => {
  const size = useAppStore((s) => s.terminalFontSize);
  const nudge = useAppStore((s) => s.nudgeTerminalFontSize);
  // Device-dependent (phones default smaller), so read it per render.
  const fallback = defaultTerminalFontSize();

  return (
    <SettingRow
      label="Font size"
      description={`Per device, so a phone can stay smaller than a desktop. Default here: ${fallback} px.`}
    >
      <div className="inline-flex items-center rounded-lg border border-neutral-800 bg-neutral-900/60">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Decrease terminal font size"
          disabled={size <= TERMINAL_FONT_MIN}
          onClick={() => nudge(-TERMINAL_FONT_STEP)}
        >
          <Minus size={13} />
        </Button>
        <span aria-live="polite" className="w-12 text-center text-xs tabular-nums text-neutral-200">
          {size} px
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Increase terminal font size"
          disabled={size >= TERMINAL_FONT_MAX}
          onClick={() => nudge(TERMINAL_FONT_STEP)}
        >
          <Plus size={13} />
        </Button>
      </div>
      <Button size="sm" variant="ghost" disabled={size === fallback} onClick={() => nudge(fallback - size)}>
        Reset
      </Button>
    </SettingRow>
  );
};
