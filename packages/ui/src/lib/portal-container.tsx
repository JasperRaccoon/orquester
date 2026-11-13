import React from "react";

/**
 * Where portalled UI (modals, menus, popovers, the image lightbox) mounts.
 *
 * The app leaves it unset and portals land in `document.body`, as they always
 * have. The embeddable agent chat (`apps/web/src/embed/`) renders inside a
 * shadow root, where a portal into `document.body` would escape its styles,
 * so it provides a node inside that shadow root instead.
 *
 * Generic on purpose: `components/ui` primitives read it too, so it must not
 * import anything app-specific.
 */
const PortalContainerContext = React.createContext<HTMLElement | null>(null);

export function PortalContainerProvider(props: { container: HTMLElement | null; children: React.ReactNode }): React.ReactElement {
  return <PortalContainerContext.Provider value={props.container}>{props.children}</PortalContainerContext.Provider>;
}

/**
 * The node portals mount into: the provided container, else `document.body`.
 * Safe to call where there is no document (a server render, which renders no
 * portal): primitives call it on every render, open or not.
 */
export function usePortalContainer(): HTMLElement {
  const provided = React.useContext(PortalContainerContext);
  if (provided !== null) return provided;
  return typeof document === "undefined" ? (undefined as unknown as HTMLElement) : document.body;
}
