import React, { useEffect, useState } from "react";
import { File as FileIcon, Folder } from "lucide-react";
import type { FsArchiveResponse } from "@orquester/api";
import { useApi } from "../../../context/orquester-context";
import { BinaryCard } from "./BinaryCard";

export const ArchiveViewer: React.FC<{
  path: string;
  name: string;
  size: number;
  mime: string;
  fetchBytes: (path: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}> = ({ path, name, size, mime, fetchBytes }) => {
  const api = useApi();
  const [state, setState] = useState<{ data: FsArchiveResponse | null; loading: boolean; error: boolean }>({
    data: null,
    loading: true,
    error: false
  });

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState({ data: null, loading: true, error: false });
    api
      .listArchive(path, controller.signal)
      .then((data) => active && setState({ data, loading: false, error: false }))
      .catch(() => active && !controller.signal.aborted && setState({ data: null, loading: false, error: true }));
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, path]);

  if (state.loading) return <p className="p-3 text-xs text-neutral-600">Reading archive…</p>;
  if (state.error || !state.data) return <p className="p-3 text-xs text-red-400">Could not read archive.</p>;
  if (!state.data.supported) {
    return (
      <BinaryCard path={path} name={name} size={size} mime={mime} downloadable={size <= 50 * 1024 * 1024} title="Archive (no preview tool)" fetchBytes={fetchBytes} />
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto p-2 text-sm">
      {state.data.truncated && (
        <p className="px-2 py-1 text-[11px] text-amber-500/80">
          Listing truncated to {state.data.entries.length.toLocaleString()} entries.
        </p>
      )}
      <ul>
        {state.data.entries.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 px-2 py-0.5 text-neutral-300">
            {entry.dir ? (
              <Folder size={13} className="shrink-0 text-neutral-500" />
            ) : (
              <FileIcon size={13} className="shrink-0 text-neutral-600" />
            )}
            <span className="flex-1 truncate">{entry.name}</span>
            {!entry.dir && <span className="text-[11px] text-neutral-600">{entry.size.toLocaleString()} B</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};
