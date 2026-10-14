/**
 * An MCP App inline in the thread (spec 2026-10-14 §3): the document its
 * adapter captured, framed from a signed URL on the agent-visuals route
 * (Task 3's infrastructure) in an opaque-origin frame, speaking the MCP Apps
 * bridge (`lib/agent-chat/mcp-app-host.ts`). Its tool calls and resource
 * reads reach its own MCP server through the thread's live provider session;
 * calls to tools the server does not mark read-only, chat messages and
 * downloads wait on the user's consent in the banner dock
 * (`lib/agent-chat/mcp-app-actions.ts`). Full screen keeps the same frame (and
 * the app's state) and only restyles its box, in the browser's top layer.
 *
 * Ported from T3 Code (MIT): `apps/web/src/components/chat/McpAppFrame.tsx`.
 */

import React from "react";
import { flushSync } from "react-dom";
import { Minimize2 } from "lucide-react";

import {
  MCP_APP_DEFAULT_HEIGHT,
  MCP_APP_MAX_HEIGHT,
  clampMcpAppHeight,
  mcpAppAllowAttribute,
  mcpAppToolCallOfActivityPayload,
  type McpAppReference,
  type McpAppToolCall,
  type McpAppToolInfoResponse
} from "@orquester/api/agent-chat";

import { useApi } from "../../../context/orquester-context";
import { cn } from "../../../lib/cn";
import { useAgentChatPending } from "../../../lib/agent-chat/hooks";
import { peekThreadStore } from "../../../lib/agent-chat/store";
import { mcpAppActions } from "../../../lib/agent-chat/mcp-app-actions";
import { mcpAppConsents } from "../../../lib/agent-chat/mcp-app-consent";
import {
  makeMcpAppHost,
  mcpAppStyleVariables,
  type McpAppDisplayMode,
  type McpAppHost,
  type McpAppHostContext
} from "../../../lib/agent-chat/mcp-app-host";
import { openVisualLink, visualRequestAllowed } from "../../../lib/agent-chat/visual-frame";
import { ChatIconButton } from "../primitives";
import { visualPageUrl } from "../visual/VisualFrame";
import { useVisualTheme } from "../visual/use-visual-theme";

/** The `hostInfo.version` apps see. */
const MCP_APP_HOST_VERSION = "1";

/** Full screen shows the box in the top layer, which needs the Popover API. */
const fullscreenSupported = typeof HTMLElement !== "undefined" && "popover" in HTMLElement.prototype;

function isDesktop(): boolean {
  return typeof window !== "undefined" && (window as unknown as { orquesterDesktop?: unknown }).orquesterDesktop !== undefined;
}

function userActive(): boolean | undefined {
  return (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
}

/** Saves a file through the browser's own download. */
function saveBlob(file: { name: string; mimeType: string; bytes: Uint8Array }): void {
  // A copy backed by a plain ArrayBuffer, which Blob requires.
  const url = URL.createObjectURL(new Blob([file.bytes.slice()], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  // Long after the browser has read it: some start the download a task or
  // more after the click, and a revoked URL saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

let nextFrameId = 0;

export function McpAppFrame(props: {
  sessionId: string;
  /** The call's completed row, which names the app to the daemon. */
  itemId: string;
  app: McpAppReference;
  /** A read-only timeline (a drill-in) sends no messages. */
  readOnly: boolean;
}): React.ReactElement {
  const { sessionId, itemId, app } = props;
  const api = useApi();
  const theme = useVisualTheme();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [owner] = React.useState(() => `mcp-app-frame-${++nextFrameId}`);
  const [width, setWidth] = React.useState(0);
  const [height, setHeight] = React.useState(MCP_APP_DEFAULT_HEIGHT);
  const [navigatedAway, setNavigatedAway] = React.useState(false);
  const [displayMode, setDisplayMode] = React.useState<McpAppDisplayMode>("inline");
  // The app asked to be closed; the row says so and offers it back.
  const [closed, setClosed] = React.useState(false);
  // Each document this row shows: reopening a closed app loads a new one,
  // with its own host and its own load tracking.
  const [documentGeneration, setDocumentGeneration] = React.useState(0);

  // The approval or question the agent waits on renders in the dock beneath
  // the top layer, so a full-screen app steps aside for it.
  const pending = useAgentChatPending(sessionId);
  const awaitingUser = pending.totalCount > 0;

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    setWidth(box.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [closed]);

  // The frame keeps its first URL: a re-minted one would reload the app. A
  // new document (a reopened app) mints again when its cached URL is short.
  const [src, setSrc] = React.useState<string | null>(null);
  const [mintFailed, setMintFailed] = React.useState(false);
  React.useEffect(() => {
    if (src !== null) return undefined;
    let cancelled = false;
    visualPageUrl(api, sessionId, app.attachmentId).then(
      (url) => {
        if (!cancelled) setSrc(url.src);
      },
      () => {
        if (!cancelled) setMintFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, app.attachmentId, src]);

  // The tool's definition (the app's `toolInfo`) and whether the agent can
  // take model context, read once per app before the frame loads, so the
  // initialize response can carry both. A failure only leaves them out.
  const [info, setInfo] = React.useState<{ settled: boolean; tool?: unknown; modelContext: boolean }>({
    settled: false,
    modelContext: false
  });
  React.useEffect(() => {
    let cancelled = false;
    api.mcpAppRequest<McpAppToolInfoResponse>(sessionId, itemId, "tool-info", { name: app.tool }).then(
      (value) => {
        if (!cancelled) {
          setInfo({
            settled: true,
            ...(value.tool === undefined ? {} : { tool: value.tool }),
            modelContext: value.modelContext === true
          });
        }
      },
      () => {
        if (!cancelled) setInfo({ settled: true, modelContext: false });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, itemId, app.tool]);

  // The wire row is slimmed; the app replays the call's own arguments and
  // result, read from the stored row.
  const [toolCall, setToolCall] = React.useState<McpAppToolCall>();
  React.useEffect(() => {
    let cancelled = false;
    api.agentChatItem(sessionId, itemId).then(
      (response) => {
        if (!cancelled && response.item.kind === "activity") {
          setToolCall(mcpAppToolCallOfActivityPayload(response.item.payload));
        }
      },
      () => undefined
    );
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, itemId]);

  // Read by the host on every message, so it sees current values without
  // being rebuilt (which would drop the app's session).
  const live = { theme, width, displayMode, info, awaitingUser, readOnly: props.readOnly };
  const latest = React.useRef(live);
  latest.current = live;
  const hostRef = React.useRef<McpAppHost | null>(null);

  React.useEffect(() => {
    const box = boxRef.current;
    if (box === null || !fullscreenSupported) return undefined;
    const shown = box.matches(":popover-open");
    if (displayMode === "fullscreen" && !shown) box.showPopover();
    if (displayMode !== "fullscreen" && shown) box.hidePopover();
    return undefined;
  }, [displayMode]);

  if (awaitingUser && displayMode === "fullscreen") {
    setDisplayMode("inline");
  }

  // Full screen sits above everything else. Anything that takes focus outside
  // it (an approval, the command palette, a dialog) returns the app inline so
  // it can be seen; so does Escape pressed outside the app.
  React.useEffect(() => {
    if (displayMode !== "fullscreen") return undefined;
    const leave = () => setDisplayMode("inline");
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !boxRef.current?.contains(event.target)) leave();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    const onResize = () => hostRef.current?.updateHostContext();
    document.addEventListener("focusin", onFocus);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("focusin", onFocus);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [displayMode]);

  // The bridge belongs to the captured document. A frame that navigates keeps
  // its window, so a second load stops the app rather than letting a page
  // Orquester never served pose as it. Counted per document.
  const loads = React.useRef({ generation: 0, count: 0 });
  const onFrameLoad = () => {
    if (loads.current.generation !== documentGeneration) {
      loads.current = { generation: documentGeneration, count: 0 };
    }
    loads.current.count += 1;
    if (loads.current.count > 1) {
      hostRef.current?.dispose();
      setNavigatedAway(true);
    }
  };

  const ready = src !== null && info.settled;
  React.useEffect(() => {
    if (!ready) return undefined;
    const target = () => frameRef.current?.contentWindow ?? null;
    const hostContext = (): McpAppHostContext => {
      const current = latest.current;
      return {
        theme: current.theme.appearance,
        styles: { variables: mcpAppStyleVariables(current.theme.variables) },
        displayMode: current.displayMode,
        availableDisplayModes: fullscreenSupported ? ["inline", "fullscreen"] : ["inline"],
        containerDimensions:
          current.displayMode === "fullscreen"
            ? {
                width: frameRef.current?.clientWidth || window.innerWidth,
                height: frameRef.current?.clientHeight || window.innerHeight
              }
            : { width: current.width, maxHeight: MCP_APP_MAX_HEIGHT },
        platform: isDesktop() ? "desktop" : "web",
        locale: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        userAgent: `orquester/${MCP_APP_HOST_VERSION}`,
        deviceCapabilities: {
          touch: window.matchMedia?.("(pointer: coarse)").matches ?? false,
          hover: window.matchMedia?.("(hover: hover)").matches ?? true
        },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        ...(current.info.tool === undefined ? {} : { toolInfo: { tool: current.info.tool } })
      };
    };
    const actions = mcpAppActions({
      app,
      request: (operation, body) => api.mcpAppRequest(sessionId, itemId, operation, body),
      // The dock renders beneath a full-screen app's top layer: the app
      // returns inline before anyone is asked.
      ask: async (input) => {
        flushSync(() => setDisplayMode("inline"));
        return mcpAppConsents.ask(owner, { ...input, sessionId, appName: app.server });
      },
      sendMessage: latest.current.readOnly
        ? undefined
        : async (text) => {
            const store = peekThreadStore(sessionId);
            if (store === null) throw new Error("This thread is not open.");
            await store.getState().actions.sendTurn({ text, generatedPrompt: true });
          },
      linkAllowed: () => {
        const frame = frameRef.current;
        return (
          frame !== null &&
          visualRequestAllowed({
            fromFrame: true,
            frameFocused: document.activeElement === frame,
            userActive: userActive()
          })
        );
      },
      openLink: openVisualLink,
      saveFile: saveBlob
    });
    const host = makeMcpAppHost({
      app,
      hostVersion: MCP_APP_HOST_VERSION,
      // The document's origin is opaque, so "*" is the only target that
      // reaches it; the window reference itself scopes delivery to this frame.
      post: (message) => target()?.postMessage(message, "*"),
      hostContext,
      supportsModelContext: () => latest.current.info.modelContext,
      ...actions,
      requestDisplayMode: async (mode) => {
        // Full screen would cover the approval or question the agent waits
        // on, or a consent another app waits on; another app already full
        // screen keeps the page — two would stack.
        const otherFullscreen = document.querySelector("[data-mcp-app-fullscreen]");
        if (
          mode === "fullscreen" &&
          (latest.current.awaitingUser ||
            mcpAppConsents.pending(sessionId).length > 0 ||
            (otherFullscreen !== null && otherFullscreen !== boxRef.current))
        ) {
          return latest.current.displayMode;
        }
        setDisplayMode(mode === "fullscreen" ? "fullscreen" : "inline");
        return mode === "fullscreen" ? "fullscreen" : "inline";
      },
      onRequestTeardown: () => {
        if (latest.current.displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        // The app asked to go, so it gets its teardown before the frame does.
        void host.teardown().then(() => setClosed(true));
      },
      onSizeChanged: (size) => {
        // Full screen is a fixed box; what the app reports there would leave
        // the inline row its full-screen height on the way back.
        if (latest.current.displayMode === "fullscreen") return;
        if (size.height !== undefined) setHeight(clampMcpAppHeight(size.height));
      }
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      // Only messages from this frame's own window reach its host.
      if (event.source !== null && event.source === target()) host.receive(event.data);
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      // An unmount cannot wait: the request goes out before the frame does.
      void host.teardown();
      hostRef.current = null;
      mcpAppConsents.withdraw(owner);
    };
  }, [ready, app, api, sessionId, itemId, owner, documentGeneration]);

  // The host reads the context through `latest`; these only say when to resend.
  React.useEffect(() => {
    hostRef.current?.updateHostContext();
  }, [theme, width, displayMode, info]);

  // A new document gets a new host, which needs the call again.
  React.useEffect(() => {
    if (toolCall !== undefined) hostRef.current?.setToolCall({ arguments: toolCall.arguments, result: toolCall.result });
  }, [toolCall, ready, documentGeneration]);

  // An app that asked to close keeps a row, so the timeline does not jump,
  // and says how to bring it back.
  if (closed) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800 px-3 py-2 text-xs text-neutral-500">
        <span className="min-w-0 truncate">The {app.server} app was closed</span>
        <button
          type="button"
          className="ac-press rounded-md px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
          onClick={() => {
            loads.current = { generation: documentGeneration + 1, count: 0 };
            setSrc(null);
            setNavigatedAway(false);
            setDocumentGeneration((value) => value + 1);
            setClosed(false);
          }}
        >
          Show app
        </button>
      </div>
    );
  }

  const fullscreen = displayMode === "fullscreen";
  // `popover` is not in React 18's attribute types; React passes it through.
  const popoverProps = fullscreenSupported ? ({ popover: "manual" } as Record<string, string>) : {};
  return (
    // The row keeps its inline height while the app is full screen, so the
    // timeline does not jump; the box itself is what goes full screen.
    <div style={{ height }} data-mcp-app={app.attachmentId}>
      <div
        ref={boxRef}
        {...popoverProps}
        data-mcp-app-fullscreen={fullscreen ? "" : undefined}
        className={cn(
          "relative size-full overflow-hidden",
          app.prefersBorder === true && !fullscreen && "rounded-lg border border-neutral-800",
          fullscreen
            ? "fixed inset-0 m-0 flex h-dvh max-h-none w-dvw max-w-none flex-col border-0 bg-neutral-950 p-0"
            : // A closed popover is hidden; inline, the box is a plain block.
              "!static !block m-0 border-0 bg-transparent p-0 text-inherit"
        )}
      >
        {fullscreen ? (
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-800 px-3 text-sm text-neutral-200">
            <span className="truncate">{app.server}</span>
            <ChatIconButton label="Exit full screen" onClick={() => setDisplayMode("inline")}>
              <Minimize2 size={14} aria-hidden />
            </ChatIconButton>
          </div>
        ) : null}
        {navigatedAway ? (
          <p className="flex size-full items-center justify-center text-xs text-neutral-500">
            The {app.server} app left its page and was stopped
          </p>
        ) : ready ? (
          <iframe
            key={documentGeneration}
            ref={frameRef}
            src={src}
            title={`${app.server} app`}
            // Never allow-same-origin: the opaque origin keeps the app out of the session.
            sandbox="allow-scripts allow-forms"
            allow={mcpAppAllowAttribute(app.permissions)}
            referrerPolicy="no-referrer"
            onLoad={onFrameLoad}
            className={cn("block w-full border-0 bg-transparent", fullscreen ? "min-h-0 flex-1" : "h-full")}
            style={{ colorScheme: theme.appearance }}
          />
        ) : mintFailed ? (
          <p className="flex size-full items-center justify-center text-xs text-neutral-500">
            Unable to load the {app.server} app
          </p>
        ) : null}
      </div>
    </div>
  );
}
