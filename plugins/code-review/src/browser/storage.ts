/** IndexedDB serializes read/modify/write across every tab on this origin. */
export interface ReviewStorage {
  transact<T>(key: string, change: (value: unknown | undefined) => { value: unknown; result: T }): Promise<T>;
}

export class IndexedDBReviewStorage implements ReviewStorage {
  private database: Promise<IDBDatabase> | undefined;
  private disposed = false;

  constructor(
    private readonly factory: IDBFactory,
    private readonly committed: (key: string) => void = () => {},
    private readonly name = "pi-web-code-review",
  ) {}

  private open(): Promise<IDBDatabase> {
    if (this.disposed) return Promise.reject(new Error("Review storage is closed"));
    if (this.database !== undefined) return this.database;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      let failed = false;
      const fail = (error: unknown) => { failed = true; reject(error); };
      request.onupgradeneeded = () => {
        if (failed || this.disposed) { request.transaction?.abort(); return; }
        request.result.createObjectStore("workspaces");
      };
      request.onerror = () => { fail(request.error ?? new Error("Could not open review storage")); };
      request.onblocked = () => { fail(new Error("Review storage upgrade is blocked; close older review tabs and retry")); };
      request.onsuccess = () => {
        const database = request.result;
        // A blocked request cannot be cancelled; it may succeed after rejection.
        if (failed || this.disposed) { database.close(); reject(new Error("Review storage is closed")); return; }
        database.onversionchange = () => { database.close(); this.database = undefined; };
        resolve(database);
      };
    });
    this.database = opening;
    void opening.catch(() => { if (this.database === opening) this.database = undefined; });
    return opening;
  }

  async transact<T>(key: string, change: (value: unknown | undefined) => { value: unknown; result: T }): Promise<T> {
    const database = await this.open();
    if (this.disposed) throw new Error("Review storage is closed");
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction("workspaces", "readwrite");
      const store = transaction.objectStore("workspaces");
      let result: T;
      let failure: unknown;
      let changed = false;
      transaction.onabort = () => { reject(failure ?? transaction.error ?? new Error("Review storage transaction aborted")); };
      transaction.oncomplete = () => {
        // Notification is best effort, never part of the persistence outcome.
        if (changed) {
          try { this.committed(key); }
          catch (error) { console.error("[Code Review] Could not notify other tabs of saved feedback", error); }
        }
        resolve(result);
      };
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const previous: unknown = request.result;
          const next = change(previous);
          result = next.result;
          if (JSON.stringify(previous) !== JSON.stringify(next.value)) {
            store.put(next.value, key);
            changed = true;
          }
        } catch (error) { failure = error; transaction.abort(); }
      };
    });
  }

  dispose(): void {
    this.disposed = true;
    void this.database?.then((database) => { database.close(); }, () => {});
  }
}
