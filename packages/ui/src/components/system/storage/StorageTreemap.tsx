// THROWAWAY STUB — replaced at merge by the real canvas treemap (built in
// parallel). Only the props interface is load-bearing; no logic lives here.
import React from "react";
import type { StorageNode } from "@orquester/api";

export interface StorageMapProps {
  root: StorageNode;
  /** A dir was activated → zoom in. */
  onOpen: (node: StorageNode) => void;
  /** Client coords. */
  onContextMenu: (node: StorageNode, at: { x: number; y: number }) => void;
  className?: string;
}

export const StorageTreemap: React.FC<StorageMapProps> = ({ root, onOpen, onContextMenu, className }) => (
  <ul className={className} data-stub="storage-treemap">
    {(root.children ?? []).map((node) => (
      <li key={`${node.kind}:${node.path}:${node.name}`}>
        <button
          type="button"
          onClick={() => node.kind === "dir" && onOpen(node)}
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu(node, { x: e.clientX, y: e.clientY });
          }}
        >
          {node.name}
        </button>
      </li>
    ))}
  </ul>
);
