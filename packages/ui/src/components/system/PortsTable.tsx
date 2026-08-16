import React, { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { SystemPortsResponse } from "@orquester/api";
import { copyText } from "../../lib/clipboard";
import { SessionChip } from "./SessionChip";

/**
 * TCP sockets the daemon's processes are listening on.
 *
 * Deliberately NOT rendered as `http://host:port` links: on the VPS deployment
 * everything but 443 is firewalled, so such a link is a dead end that looks like
 * a feature. The address is offered for copying instead — the user knows whether
 * they have an SSH tunnel or a reverse proxy in front of it.
 */
export const PortsTable: React.FC<{ snapshot: SystemPortsResponse }> = ({ snapshot }) => {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    []
  );

  const copy = (key: string, value: string) => {
    void copyText(value);
    setCopied(key);
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setCopied(null), 1500);
  };

  if (snapshot.ports.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-800 px-3 py-4 text-center text-xs text-neutral-500">
        Nothing in this daemon&rsquo;s process tree is listening on a TCP port.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-800">
      <table className="min-w-[30rem] w-full text-left">
        <thead>
          <tr className="border-b border-neutral-800 bg-neutral-900/60 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            <th className="px-2 py-1.5 font-medium">Port</th>
            <th className="px-2 py-1.5 font-medium">Address</th>
            <th className="px-2 py-1.5 font-medium">Process</th>
            <th className="px-2 py-1.5 font-medium">Session</th>
            <th className="px-2 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {snapshot.ports.map((entry) => {
            const key = `${entry.address}:${entry.port}:${entry.pid}`;
            const target = `${entry.address}:${entry.port}`;
            return (
              <tr key={key} className="border-b border-neutral-900 last:border-b-0 hover:bg-neutral-800/40">
                <td className="px-2 py-1.5 text-xs tabular-nums text-neutral-100">{entry.port}</td>
                <td className="px-2 py-1.5 text-xs tabular-nums text-neutral-400">{entry.address}</td>
                <td className="max-w-[12rem] truncate px-2 py-1.5 text-xs text-neutral-300" title={entry.processName}>
                  {entry.processName} <span className="text-neutral-600">· {entry.pid}</span>
                </td>
                <td className="px-2 py-1.5">{entry.sessionId ? <SessionChip sessionId={entry.sessionId} /> : null}</td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => copy(key, target)}
                    aria-label={`Copy ${target}`}
                    title={`Copy ${target}`}
                    className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  >
                    {copied === key ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
