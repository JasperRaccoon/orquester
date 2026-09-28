/**
 * Whether the workflow UI is laid out for a phone (workflows spec §7.4): a
 * narrow viewport, or a touch screen that is not much wider (a small tablet in
 * portrait). The editor tab decides once and provides it, so a form deep in the
 * inspector — which renders inside a portaled sheet — can ask
 * (`usePhoneLayout`) without measuring again.
 */

import { createContext, useContext } from "react";

import { useMediaQuery } from "../../../hooks/use-media-query";

export const PHONE_LAYOUT_QUERY = "(max-width: 767px), ((pointer: coarse) and (max-width: 1023px))";

export const PhoneLayoutContext = createContext(false);

/** The layout the surrounding editor chose. */
export function usePhoneLayout(): boolean {
  return useContext(PhoneLayoutContext);
}

/** Measure it (the editor tab's root). */
export function useIsPhoneLayout(): boolean {
  return useMediaQuery(PHONE_LAYOUT_QUERY);
}
