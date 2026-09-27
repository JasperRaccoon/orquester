import React, { useState } from "react";
import { Dropdown } from "./dropdown";
import { BottomSheet } from "./sheet";
import { useIsDesktop } from "../../hooks/use-media-query";

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
  focusOnOpen
}) => {
  const isDesktop = useIsDesktop();
  const [open, setOpen] = useState(false);

  if (isDesktop) {
    return (
      <Dropdown trigger={trigger} align={align} width={width} focusOnOpen={focusOnOpen}>
        {children}
      </Dropdown>
    );
  }

  return (
    <>
      <button type="button" className="app-no-drag inline-flex" onClick={() => setOpen(true)}>
        {trigger}
      </button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title}>
        {children}
      </BottomSheet>
    </>
  );
};
