import { describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { storagePrefix } from "../src/browser/model.js";
import { IndexedDBReviewStorage } from "../src/browser/storage.js";
import { reviewStorage } from "./storageSupport.js";
import { savedComment } from "./context.js";

describe("IndexedDB adapter (prepared; not executed)", () => {
  it("aborts a failed write and preserves durable comments on another connection", async () => {
    const first = reviewStorage(); const second = reviewStorage(first.factory);
    await first.store.add("one", savedComment);
    await expect(first.storage.transact("one", () => ({ value: { uncloneable: () => {} }, result: null }))).rejects.toThrow();
    expect(await second.store.load("one")).toEqual([savedComment]);
    await expect(first.storage.transact("one", () => { throw new Error("mutation failed"); })).rejects.toThrow("mutation failed");
    expect(await second.store.load("one")).toEqual([savedComment]);
  });
  it("rolls back the migration marker and imported data together when the transaction aborts", async () => {
    const { store, legacyData } = reviewStorage();
    const backup = JSON.stringify({ version: 1, comments: [savedComment] });
    legacyData.set(storagePrefix + "one", backup);
    const put = IDBObjectStore.prototype.put;
    const abort = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = put.call(this, value, key);
      this.transaction.abort();
      return request;
    });
    try { await expect(store.load("one")).rejects.toThrow(); }
    finally { abort.mockRestore(); }
    expect(legacyData.get(storagePrefix + "one")).toBe(backup);
    expect(await store.load("one")).toEqual([savedComment]);
  });
  it("does not turn notification failure into failed persistence or notify on unchanged reads", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const committed = vi.fn(() => { throw new Error("channel closed"); });
      const { store } = reviewStorage(undefined, committed);
      await store.add("one", savedComment);
      expect(await store.load("one")).toEqual([savedComment]);
      expect(committed).toHaveBeenCalledTimes(1);
    } finally { log.mockRestore(); }
  });
  it("closes a late success after blocked rejection and safely retries opening", async () => {
    // Only the open lifecycle is controlled; transaction semantics are tested above
    // with separate real adapter connections and fake-indexeddb's native factory API.
    const factory = new IDBFactory();
    const request = { onblocked: null, onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest;
    const open = vi.spyOn(factory, "open").mockReturnValueOnce(request);
    const storage = new IndexedDBReviewStorage(factory);
    try {
      const blocked = storage.transact("one", () => ({ value: [], result: [] }));
      const rejection = expect(blocked).rejects.toThrow("blocked");
      request.onblocked?.call(request, {} as IDBVersionChangeEvent);
      await rejection;
      const close = vi.fn();
      Object.defineProperty(request, "result", { value: { close } });
      request.onsuccess?.call(request, {} as Event);
      expect(close).toHaveBeenCalledOnce();
      await expect(storage.transact("one", () => ({ value: [], result: "retry" }))).resolves.toBe("retry");
      expect(open).toHaveBeenCalledTimes(2);
    } finally { storage.dispose(); open.mockRestore(); }
  });
  it("retries a failed open and refuses new transactions after disposal", async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open").mockImplementationOnce(() => { throw new Error("denied"); });
    const storage = new IndexedDBReviewStorage(factory);
    try {
      await expect(storage.transact("one", () => ({ value: [], result: 1 }))).rejects.toThrow("denied");
      await expect(storage.transact("one", () => ({ value: [], result: 1 }))).resolves.toBe(1);
      storage.dispose();
      await expect(storage.transact("one", () => ({ value: [], result: 1 }))).rejects.toThrow("closed");
    } finally { storage.dispose(); open.mockRestore(); }
  });
});
