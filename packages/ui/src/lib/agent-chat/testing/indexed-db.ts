/** The cache tests' existing IndexedDB double: requests are asynchronous and stores survive page reloads. */
export function fakeIndexedDb() {
  const databases = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>();
  let pending = 0, generation = 0;
  const schedule = (dispatch: (callback: () => void) => unknown, run: () => void) => {
    pending += 1; generation += 1;
    dispatch(() => { try { run(); } finally { pending -= 1; } });
  };
  const fixture = {
    factory: undefined as unknown as IDBFactory,
    bodyWrites: 0,
    beforeRead: undefined as ((store: string, operation: string) => void | Promise<void>) | undefined,
    /** Drain runnable native callbacks; deliberately held requests count once released. */
    async idle(): Promise<void> {
      let observed: number;
      do {
        observed = generation;
        await new Promise<void>((resolve) => setImmediate(resolve));
      } while (pending !== 0 || generation !== observed);
    },
    async store(name: string, mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
      const request = fixture.factory.open("orquester-agent-chat", 1);
      request.onupgradeneeded = () => {
        for (const store of ["thread-meta", "thread-body"]) request.result.createObjectStore(store, { keyPath: "key" });
      };
      const db = await idbResult(request);
      return db.transaction(name, mode).objectStore(name);
    },
    async read(store: string, key: string): Promise<Record<string, unknown> | undefined> { return idbResult((await fixture.store(store)).get(key)); },
    async all(store: string): Promise<Record<string, unknown>[]> { return idbResult((await fixture.store(store)).getAll()); },
    async put(store: string, value: unknown): Promise<void> { await idbResult((await fixture.store(store, "readwrite")).put(value)); },
    async remove(store: string, key: string): Promise<void> { await idbResult((await fixture.store(store, "readwrite")).delete(key)); }
  };
  const request = <T>(run: () => T | Promise<T>) => {
    const handle = { result: undefined as T | undefined, error: null as unknown, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null };
    schedule(queueMicrotask, () => {
      void Promise.resolve().then(run).then(
        (result) => schedule(queueMicrotask, () => { handle.result = result; handle.onsuccess?.(); }),
        (error: unknown) => schedule(queueMicrotask, () => { handle.error = error; handle.onerror?.(); })
      );
    });
    return handle;
  };
  const open = (name: string, version: number) => {
    const handle: Record<string, unknown> = {};
    schedule(setImmediate, () => {
      let db = databases.get(name);
      const upgrade = db === undefined || db.version < version;
      db ??= { version, stores: new Map() };
      databases.set(name, db);
      const stores = db.stores;
      handle.result = {
        objectStoreNames: { contains: (store: string) => stores.has(store) },
        createObjectStore: (store: string) => void stores.set(store, new Map()),
        close: () => {},
        transaction: (names: string | string[]) => {
          const transaction: Record<string, unknown> = {
            objectStore: (store: string) => {
              if (![names].flat().includes(store)) throw new Error(`${store} is outside the transaction`);
              const rows = stores.get(store)!;
              return {
                get: (key: string) => request(async () => { await fixture.beforeRead?.(store, "get"); return structuredClone(rows.get(key)); }),
                getAll: () => request(async () => { await fixture.beforeRead?.(store, "getAll"); return [...rows.values()].map((row) => structuredClone(row)); }),
                getAllKeys: () => request(() => [...rows.keys()]),
                put: (value: { key: string }) => request(() => { rows.set(value.key, structuredClone(value)); if (store === "thread-body") fixture.bodyWrites += 1; }),
                delete: (key: string) => request(() => void rows.delete(key))
              };
            }
          };
          schedule(setImmediate, () => (transaction.oncomplete as (() => void) | undefined)?.());
          return transaction;
        }
      };
      if (upgrade) (handle.onupgradeneeded as (() => void) | undefined)?.();
      (handle.onsuccess as (() => void) | undefined)?.();
    });
    return handle;
  };
  fixture.factory = { open } as unknown as IDBFactory;
  return fixture;
}

function idbResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
