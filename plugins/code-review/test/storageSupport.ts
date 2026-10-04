import { IDBFactory } from "fake-indexeddb";
import { afterEach } from "vitest";
import { ReviewStore } from "../src/browser/model.js";
import { IndexedDBReviewStorage } from "../src/browser/storage.js";

const adapters: IndexedDBReviewStorage[] = [];
afterEach(() => { for (const adapter of adapters.splice(0)) adapter.dispose(); });

export function reviewStorage(factory = new IDBFactory(), committed?: (key: string) => void) {
  const legacyData = new Map<string, string>();
  const legacy = { getItem: (key: string) => legacyData.get(key) ?? null };
  const storage = new IndexedDBReviewStorage(factory, committed);
  adapters.push(storage);
  return { factory, storage, legacy, legacyData, store: new ReviewStore(storage, legacy) };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
