import React from "react";
import {
  Bot,
  Brain,
  Check,
  CircleAlert,
  Eye,
  Globe,
  Hammer,
  MessageCircle,
  Minimize2,
  Search,
  Shuffle,
  SquarePen,
  Terminal,
  Wrench,
  Zap
} from "lucide-react";

import type { LucideIcon } from "lucide-react";

import type { WorkEntryIconName } from "../work-presentation";

/**
 * Row glyphs, resolved by name.
 *
 * The 16px-icon-in-a-24px-slot is the single most structural number in the
 * timeline: it sets the 24px row height, the 6px gap and the `ms-7` nesting
 * indent. `strokeWidth={1.8}` matters too — lucide's default 2 reads heavy at
 * 16px against muted text.
 */
const GLYPHS: Record<WorkEntryIconName, LucideIcon> = {
  brain: Brain,
  check: Check,
  "circle-alert": CircleAlert,
  eye: Eye,
  "square-pen": SquarePen,
  terminal: Terminal,
  globe: Globe,
  search: Search,
  wrench: Wrench,
  hammer: Hammer,
  bot: Bot,
  "message-circle": MessageCircle,
  zap: Zap,
  "minimize-2": Minimize2,
  shuffle: Shuffle
};

export function WorkEntryIcon({
  name,
  size = 16,
  className
}: {
  name: WorkEntryIconName;
  size?: number;
  className?: string;
}): React.ReactElement {
  const Glyph = GLYPHS[name];
  return <Glyph size={size} strokeWidth={1.8} className={className} aria-hidden />;
}
