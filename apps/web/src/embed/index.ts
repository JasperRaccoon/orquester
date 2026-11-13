/**
 * STUB entry of the embed bundle, only here to prove the build pipeline
 * (vite.embed.config.ts): React bundled, styles adopted into a shadow root, a
 * lazily loaded chunk with CSS and fonts (KaTeX). The real element replaces
 * this file; keep its exports (`define`, `contract`) and its lack of side
 * effects at import.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { loadMathEngine } from "../../../../packages/ui/src/components/agent-chat/timeline/markdown/math-typeset";
import { EMBED_CONTRACT, EMBED_ELEMENT, EMBED_ROOT_CLASS } from "./contract";
import { adoptEmbedStyles } from "./styles";

export const contract = EMBED_CONTRACT;

export function define(tagName: string = EMBED_ELEMENT): CustomElementConstructor {
  const existing = customElements.get(tagName);
  if (existing) return existing;

  class OrquesterAgentChatStub extends HTMLElement {
    connectedCallback(): void {
      if (this.shadowRoot) return;
      const shadow = this.attachShadow({ mode: "open" });
      adoptEmbedStyles(shadow);
      const wrapper = document.createElement("div");
      wrapper.className = `${EMBED_ROOT_CLASS} h-full bg-neutral-950 text-neutral-100`;
      wrapper.dataset.mode = this.getAttribute("mode") ?? "dark";
      wrapper.dataset.scheme = this.getAttribute("scheme") ?? "mono";
      shadow.append(wrapper);
      const root = createRoot(wrapper);
      root.render(createElement("p", { className: "p-4 text-sm" }, "Orquester agent chat (stub)"));
      void loadMathEngine().then((katex) => {
        const math = document.createElement("div");
        math.className = "p-4 font-mono";
        math.innerHTML = katex.renderToString("e^{i\\pi} + 1 = 0", { displayMode: true });
        wrapper.append(math);
      });
    }
  }

  customElements.define(tagName, OrquesterAgentChatStub);
  return OrquesterAgentChatStub;
}
