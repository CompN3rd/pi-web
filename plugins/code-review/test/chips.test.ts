import { describe, expect, it, vi } from "vitest";
import type { PluginPromptChip } from "@jmfederico/pi-web/plugin-api";
import { ReviewChips } from "../src/browser/chips.js";
import { ReviewStore, workspaceKey } from "../src/browser/model.js";
import { context, savedComment } from "./context.js";

function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const store = new ReviewStore(storage);
  const ctx = context(); const key = workspaceKey(ctx);
  const staged: PluginPromptChip[] = [];
  ctx.prompt.setChip = (chip) => { staged.push(chip); };
  const remove = vi.fn(); ctx.prompt.removeChip = remove;
  const notify = vi.fn();
  const chips = new ReviewChips(store, notify);
  store.add(key, savedComment);
  const last = () => {
    const chip = staged.at(-1);
    if (chip === undefined) throw new Error("Expected a staged review chip");
    return chip;
  };
  return { ctx, key, store, storage, chips, last, remove, notify };
}

describe("main's composer-chip contract (release verification pending)", () => {
  it("stages a stable workspace chip without touching prompt text or deleting feedback", () => {
    const { ctx, key, store, chips, last } = fixture();
    const insert = vi.fn(); ctx.prompt.insertText = insert;
    chips.attach(ctx);
    const first = last();
    expect(first.text).toContain(savedComment.body);
    expect(first.label).toBe("Review (1)");
    expect(store.load(key)).toEqual([savedComment]);
    // A failed send provides no acknowledgement; durable data remains untouched.
    chips.attach(ctx);
    expect(last().id).toBe(first.id);
    expect(insert).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
  });
  it("retains saved comments on user removal, then clears them on server acceptance", async () => {
    const { ctx, key, store, chips, last } = fixture();
    chips.attach(ctx); await last().onRemove?.("user");
    expect(store.load(key)).toEqual([savedComment]);
    chips.attach(ctx); await last().onRemove?.("submitted");
    expect(store.load(key)).toEqual([]);
  });
  it("clears only unchanged versions in the acknowledged snapshot", async () => {
    const { ctx, key, store, chips, last } = fixture();
    store.add(key, { ...savedComment, id: "unchanged" });
    chips.attach(ctx); const sent = last();
    store.update(key, { ...savedComment, body: "edited while sending" });
    store.add(key, { ...savedComment, id: "new" });
    await sent.onRemove?.("submitted");
    expect(store.load(key)).toEqual([{ ...savedComment, body: "edited while sending" }, { ...savedComment, id: "new" }]);
  });
  it("does not retire a newer attachment when an older chip is accepted", async () => {
    const { ctx, key, store, chips, last, remove } = fixture();
    chips.attach(ctx); const first = last();
    chips.attach(ctx); const second = last();
    await first.onRemove?.("submitted");
    expect(store.load(key)).toEqual([savedComment]);
    chips.withdrawWorkspace(key);
    expect(remove).toHaveBeenCalledWith(second.id);
    // Withdrawal does not undo an already accepted request's callback.
    await second.onRemove?.("submitted");
    expect(store.load(key)).toEqual([]);
  });
  it("settles the captured workspace even after navigation", async () => {
    const { ctx, key, store, chips, last } = fixture();
    chips.attach(ctx); const sent = last();
    ctx.workspace = { ...ctx.workspace, id: "other" };
    store.add(workspaceKey(ctx), { ...savedComment, body: "other workspace" });
    await sent.onRemove?.("submitted");
    expect(store.load(key)).toEqual([]);
    expect(store.load(workspaceKey(ctx))[0]?.body).toBe("other workspace");
  });
  it("withdraws stale chips on cross-tab changes without mutating saved comments", () => {
    const { ctx, key, store, chips, last, remove } = fixture();
    chips.attach(ctx); const staged = last();
    chips.storageChanged(key);
    expect(remove).toHaveBeenCalledWith(staged.id);
    expect(store.load(key)).toEqual([savedComment]);
  });
  it("surfaces acknowledgement persistence failures and retains the original feedback", () => {
    const { ctx, key, store, storage, chips, last, notify } = fixture();
    chips.attach(ctx);
    storage.setItem = () => { throw new Error("quota"); };
    expect(() => last().onRemove?.("submitted")).toThrow("quota");
    expect(store.load(key)).toEqual([savedComment]);
    expect(notify).toHaveBeenLastCalledWith(key, expect.stringContaining("could not be cleared"), expect.any(Error));
  });
  it("fails closed without chips or a ready session in the panel's workspace", () => {
    const { ctx, chips } = fixture();
    delete ctx.prompt.setChip;
    expect(() => chips.attach(ctx)).toThrow("composer-chip API");
    const other = context();
    other.state = { ...other.state, selectedSession: { id: "s", cwd: "/other", pending: false, archived: false } };
    expect(() => chips.attach(other)).toThrow("ready, unarchived");
  });
});
