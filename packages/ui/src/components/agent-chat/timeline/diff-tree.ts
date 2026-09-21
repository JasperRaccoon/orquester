// Ported from T3 Code (MIT): apps/web/src/lib/turnDiffTree.ts

/**
 * The changed-files card's tree model (spec §7.3).
 *
 * A turn's `CheckpointFile[]` is a flat list of paths with add/delete counts.
 * The card shows it as a real tree, because a turn that touched
 * `apps/daemon/src/agent-host/adapters/claude/index.ts` and its sibling is
 * unreadable as two long absolute-looking strings. Single-child directory
 * chains are collapsed (`a/b/c` on one row), which is the difference between a
 * four-deep staircase and one line.
 */

import type { CheckpointFile } from "@orquester/api/agent-chat";

export interface DiffStat {
  additions: number;
  deletions: number;
}

export interface DiffTreeDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  stat: DiffStat;
  children: DiffTreeNode[];
}

export interface DiffTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  stat: DiffStat | null;
}

export type DiffTreeNode = DiffTreeDirectoryNode | DiffTreeFileNode;

interface MutableDirectory {
  name: string;
  path: string;
  stat: DiffStat;
  directories: Map<string, MutableDirectory>;
  files: DiffTreeFileNode[];
}

const SORT_OPTIONS: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, SORT_OPTIONS);
}

function segments(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

function readStat(file: CheckpointFile): DiffStat | null {
  if (typeof file.additions !== "number" || typeof file.deletions !== "number") return null;
  return { additions: file.additions, deletions: file.deletions };
}

function compactDirectory(node: DiffTreeDirectoryNode): DiffTreeDirectoryNode {
  let compacted: DiffTreeDirectoryNode = {
    ...node,
    children: node.children.map((child) => (child.kind === "directory" ? compactDirectory(child) : child))
  };
  while (compacted.children.length === 1 && compacted.children[0]?.kind === "directory") {
    const onlyChild = compacted.children[0];
    compacted = {
      kind: "directory",
      name: `${compacted.name}/${onlyChild.name}`,
      path: onlyChild.path,
      stat: onlyChild.stat,
      children: onlyChild.children
    };
  }
  return compacted;
}

function toNodes(directory: MutableDirectory): DiffTreeNode[] {
  const subdirectories = [...directory.directories.values()]
    .sort(compareByName)
    .map<DiffTreeDirectoryNode>((subdirectory) => ({
      kind: "directory",
      name: subdirectory.name,
      path: subdirectory.path,
      stat: { additions: subdirectory.stat.additions, deletions: subdirectory.stat.deletions },
      children: toNodes(subdirectory)
    }))
    .map((subdirectory) => compactDirectory(subdirectory));
  const files = [...directory.files].sort(compareByName);
  return [...subdirectories, ...files];
}

export function summarizeDiffStats(files: readonly CheckpointFile[]): DiffStat {
  return files.reduce<DiffStat>(
    (accumulator, file) => {
      const stat = readStat(file);
      if (!stat) return accumulator;
      return {
        additions: accumulator.additions + stat.additions,
        deletions: accumulator.deletions + stat.deletions
      };
    },
    { additions: 0, deletions: 0 }
  );
}

export function buildDiffTree(files: readonly CheckpointFile[]): DiffTreeNode[] {
  const root: MutableDirectory = {
    name: "",
    path: "",
    stat: { additions: 0, deletions: 0 },
    directories: new Map(),
    files: []
  };

  for (const file of files) {
    const parts = segments(file.path);
    if (parts.length === 0) continue;
    const fileName = parts.at(-1);
    if (fileName === undefined) continue;
    const stat = readStat(file);
    const ancestors: MutableDirectory[] = [root];
    let current = root;

    for (const segment of parts.slice(0, -1)) {
      const nextPath = current.path ? `${current.path}/${segment}` : segment;
      const existing = current.directories.get(segment);
      if (existing) {
        current = existing;
      } else {
        const created: MutableDirectory = {
          name: segment,
          path: nextPath,
          stat: { additions: 0, deletions: 0 },
          directories: new Map(),
          files: []
        };
        current.directories.set(segment, created);
        current = created;
      }
      ancestors.push(current);
    }

    current.files.push({ kind: "file", name: fileName, path: parts.join("/"), stat });
    if (stat) {
      for (const ancestor of ancestors) {
        ancestor.stat.additions += stat.additions;
        ancestor.stat.deletions += stat.deletions;
      }
    }
  }

  return toNodes(root);
}

/** Every directory path in the tree, for the expand-all/collapse-all identity key. */
export function collectDirectoryPaths(nodes: readonly DiffTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...collectDirectoryPaths(node.children));
  }
  return paths;
}

export function hasNonZeroStat(stat: DiffStat | null): boolean {
  return stat !== null && (stat.additions > 0 || stat.deletions > 0);
}
