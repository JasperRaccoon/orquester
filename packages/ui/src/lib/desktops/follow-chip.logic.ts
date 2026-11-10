/**
 * Desktops — "Following the agent" (spec 2026-11-10 R2.5), pure: the chip a chat shows near its
 * composer while its agent works on a desktop the user is not looking at — "<label> is using
 * <desktop> · Show". It never switches tabs by itself.
 *
 * - It names a desktop an agent of **this chat** controls: the control's actor, else (an actor the
 *   daemon did not name) the latest action's, is a chat actor with this chat's thread id.
 * - Not while that desktop's tab is the one on screen.
 * - One chip per agent stint (`control.since`): dismissing it, or opening the desktop's tab, hides
 *   it until control lapses (`null`) and an agent takes the desktop again.
 */

import type { DesktopActionEntry, DesktopActor, DesktopControl } from "@orquester/api";

export interface FollowChipDesktop {
  id: string;
  title: string;
  projectPath: string;
  control?: DesktopControl | null;
}

export interface DesktopFollowChip {
  desktopId: string;
  projectPath: string;
  /** The desktop's title (for the Show button's name). */
  title: string;
  /** "Claude is using Firefox". */
  text: string;
  /** The stint the chip stands for: what dismissing it records. */
  key: string;
}

export interface FollowChipContext {
  /** The chat the chip would show in. */
  threadId: string;
  desktops: readonly FollowChipDesktop[];
  /** The latest action on a desktop, if this client saw any. */
  latestAction: (desktopId: string) => DesktopActionEntry | undefined;
  /** Whether that desktop's tab is the one on screen. */
  tabShown: (desktop: FollowChipDesktop) => boolean;
  /** Stints already dismissed or followed ({@link followChipKey}). */
  dismissed: ReadonlySet<string>;
}

/** The stint a desktop's control stands for, or null while no agent controls it. */
export function followChipKey(desktop: Pick<FollowChipDesktop, "id" | "control">): string | null {
  const control = desktop.control;
  return control?.controller === "agent" ? `${desktop.id}@${control.since}` : null;
}

function actorOf(desktop: FollowChipDesktop, latest: DesktopActionEntry | undefined): DesktopActor | undefined {
  return desktop.control?.actor ?? latest?.actor;
}

/** The chip `threadId`'s chat shows now, or null. The most recent stint wins when there are several. */
export function desktopFollowChip(context: FollowChipContext): DesktopFollowChip | null {
  let best: { chip: DesktopFollowChip; since: string } | null = null;
  for (const desktop of context.desktops) {
    const key = followChipKey(desktop);
    if (key === null || context.dismissed.has(key)) continue;
    const actor = actorOf(desktop, context.latestAction(desktop.id));
    if (actor?.kind !== "chat" || actor.threadId !== context.threadId) continue;
    if (context.tabShown(desktop)) continue;
    const since = desktop.control!.since;
    if (best && best.since >= since) continue;
    best = {
      since,
      chip: {
        desktopId: desktop.id,
        projectPath: desktop.projectPath,
        title: desktop.title || "Desktop",
        text: `${actor.label} is using ${desktop.title || "a desktop"}`,
        key
      }
    };
  }
  return best?.chip ?? null;
}

/**
 * The stints whose desktop tab is on screen now: looking at the desktop counts as following it, so
 * the chip does not come back when the user returns to the chat.
 */
export function followedStints(desktops: readonly FollowChipDesktop[], tabShown: (desktop: FollowChipDesktop) => boolean): string[] {
  const keys: string[] = [];
  for (const desktop of desktops) {
    const key = followChipKey(desktop);
    if (key !== null && tabShown(desktop)) keys.push(key);
  }
  return keys;
}
