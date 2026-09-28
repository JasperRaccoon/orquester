import React, { useState } from "react";
import { Dropdown } from "./dropdown";
import { BottomSheet } from "./sheet";
import { useIsDesktop } from "../../hooks/use-media-query";
import { cn } from "../../lib/cn";

export interface AdaptiveMenuProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  width?: string;
  /** Heading shown on the mobile bottom sheet. */
  title?: string;
  /**
   * Desktop only: the dropdown takes focus when it opens (its first item) and
   * gives it back to the trigger when it closes from the keyboard or from one
   * of its items — `Dropdown`'s `focusOnOpen`. Off by default, so every
   * existing menu keeps its focus behaviour.
   */
  focusOnOpen?: boolean;
  /**
   * Extra classes for the trigger's own `<button>` on both viewports — `flex
   * w-full` for a full-width trigger (the Agent profile's "+ Add").
   */
  triggerClassName?: string;
}

/**
 * A menu that adapts to the viewport: an anchored dropdown on desktop, a
 * bottom sheet on mobile (better reach + touch targets). Children are the same
 * DropdownItem/Label/Separator in both.
 */
export const AdaptiveMenu: React.FC<AdaptiveMenuProps> = ({
  trigger,
  children,
  align,
  width,
  title,
  focusOnOpen,
  triggerClassName
}) => {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);

  if (isDesktop) {
    return (
      <Dropdown
        trigger={trigger}
        align={align}
        width={width}
        focusOnOpen={focusOnOpen}
        triggerClassName={triggerClassName}
      >
        {children}
      </Dropdown>
    );
  }

  return (
    <>
      <button type="button" className={cn("app-no-drag inline-flex", triggerClassName)} onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        {children}
      </BottomSheet>
    </>
  );
};
