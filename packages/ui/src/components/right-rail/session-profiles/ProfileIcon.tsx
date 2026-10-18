/**
 * A profile's icon: the emoji (or short text) its owner picked, else the
 * default layers glyph, in the rail's rounded tile. Global gets its own globe.
 */

import React from "react";
import { Globe, Layers } from "lucide-react";

import { cn } from "../../../lib/cn";

/** Emoji the settings dialog offers as one-click icons. */
export const PROFILE_ICON_PRESETS = ["🧰", "💻", "🎬", "🔬", "✍️", "🎨", "📊", "🧊", "🛠️", "📚"] as const;

export const ProfileIcon: React.FC<{
  icon?: string | undefined;
  /** The Global card and menu row. */
  global?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}> = ({ icon, global = false, size = "md", className }) => {
  const box = size === "sm" ? "h-5 w-5 text-[12px]" : size === "lg" ? "h-9 w-9 text-[18px]" : "h-8 w-8 text-[15px]";
  const glyph = size === "sm" ? 12 : size === "lg" ? 17 : 15;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg leading-none",
        size === "sm" ? "rounded-md" : "bg-neutral-800/80 ring-1 ring-neutral-700/60",
        "text-neutral-300",
        box,
        className
      )}
    >
      {global ? <Globe size={glyph} /> : icon ? <span className="truncate">{icon}</span> : <Layers size={glyph} />}
    </span>
  );
};
