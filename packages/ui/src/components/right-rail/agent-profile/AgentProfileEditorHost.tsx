import React, { useEffect, useRef, useState } from "react";

import { subscribeAgentProfileEditor, type AgentProfileEditorRequest } from "./editor-bridge";
import { AgentProfileEditor } from "./editor/AgentProfileEditor";

/**
 * The one agent-profile editor, mounted once by the rail: it listens on
 * `editor-bridge.ts` and opens for whichever row or button asked — "+ Add",
 * a row's Edit, the instructions card.
 *
 * One editor at a time: a request while one is open replaces it. Each opening
 * is a fresh editor (its own draft), keyed so a late close of the previous one
 * — a save that lands after it was replaced — cannot close the next.
 */
export const AgentProfileEditorHost: React.FC = () => {
  const [open, setOpen] = useState<{ key: number; request: AgentProfileEditorRequest } | null>(null);
  const seq = useRef(0);

  useEffect(
    () =>
      subscribeAgentProfileEditor((request) => {
        seq.current += 1;
        setOpen({ key: seq.current, request });
      }),
    []
  );

  if (open === null) return null;
  const { key } = open;
  return (
    <AgentProfileEditor
      key={key}
      request={open.request}
      onClose={() => setOpen((current) => (current?.key === key ? null : current))}
    />
  );
};
