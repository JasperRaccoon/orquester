// THROWAWAY STUB — replaced at merge by the real accessible list (built in
// parallel). Only the props interface is load-bearing; no logic lives here.
import React from "react";
import type { StorageMapProps } from "./StorageTreemap";

export const StorageList: React.FC<StorageMapProps> = ({ root, onOpen, onContextMenu, className }) => (
  <ul className={className} data-stub="storage-list">
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
