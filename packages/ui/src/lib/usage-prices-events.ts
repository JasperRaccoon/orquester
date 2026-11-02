// The connected daemon's model prices changed (the price editor saved): every view of usage cost
// — the Usage view and the top-bar popover — refetches, since the daemon reprices all history.

type Listener = () => void;

const listeners = new Set<Listener>();

export function onUsagePricesChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitUsagePricesChanged(): void {
  for (const listener of [...listeners]) listener();
}
