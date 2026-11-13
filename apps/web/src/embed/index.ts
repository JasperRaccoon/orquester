/**
 * The embeddable agent chat's entry module (design
 * `docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md` §5.3).
 *
 * No side effects: importing it registers nothing and touches no DOM. A host
 * calls {@link define} once the module loaded.
 *
 * ```js
 * const embed = await import(base + manifest.entry);
 * embed.define(); // <orquester-agent-chat>
 * ```
 */

import { EMBED_CONTRACT, EMBED_ELEMENT } from "./contract";
import { createEmbedElementClass } from "./element";

export type { OrquesterAgentChatElement } from "./element";
export type {
  EmbedCommandDetail,
  EmbedLoaders,
  EmbedPendingDetail,
  EmbedPendingRequest,
  EmbedResyncDetail,
  EmbedStaleDetail
} from "./types";

/** Bumped only on a breaking change to the element, its events, the `--orq-*` names or the frames it takes. */
export const contract = EMBED_CONTRACT;

/** The constructors this bundle registered, by tag name. */
const registered = new Map<string, CustomElementConstructor>();

/**
 * Register the element under `tagName` and return its constructor. A name
 * this bundle already registered answers the same constructor; a name
 * another bundle (another Orquester version) took throws, as
 * `customElements.define` does — two versions on one page take two names.
 */
export function define(tagName: string = EMBED_ELEMENT): CustomElementConstructor {
  const own = registered.get(tagName);
  if (own !== undefined) return own;
  const element = createEmbedElementClass();
  customElements.define(tagName, element);
  registered.set(tagName, element);
  return element;
}
