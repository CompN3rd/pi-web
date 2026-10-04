import { describe, expect, it, vi } from "vitest";
import type { PluginPromptChip } from "@jmfederico/pi-web/plugin-api";
import { ReviewChips } from "../src/browser/chips.js";
import { workspaceKey, type Comment } from "../src/browser/model.js";
import { context, savedComment } from "./context.js";
import { deferred, reviewStorage } from "./storageSupport.js";

async function fixture() {
  const { store, storage } = reviewStorage();
  const ctx = context(); const key = workspaceKey(ctx);
  const staged: PluginPromptChip[] = [];
  ctx.prompt.setChip = (chip) => { staged.push(chip); };
  const remove = vi.fn(); ctx.prompt.removeChip = remove;
  const notify = vi.fn<ConstructorParameters<typeof ReviewChips>[1]>();
  const chips = new ReviewChips(store, notify);
  await store.add(key, savedComment);
  const last = () => {
    const chip = staged.at(-1);
    if (chip === undefined) throw new Error("Expected a staged review chip");
    return chip;
  };
  return { ctx, key, store, storage, chips, last, remove, notify };
}

describe("main's composer-chip contract (release verification pending)", () => {
  it("stages a stable workspace chip without touching prompt text or deleting feedback", async () => {
    const { ctx, key, store, chips, last } = await fixture();
    const insert = vi.fn(); ctx.prompt.insertText = insert;
    await chips.attach(ctx);
    const first = last();
    expect(first.text).toContain(savedComment.body);
    expect(first.label).toBe("Review (1)");
    expect(await store.load(key)).toEqual([savedComment]);
    // A failed send provides no acknowledgement; durable data remains untouched.
    await chips.attach(ctx);
    expect(last().id).toBe(first.id);
    expect(insert).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
  });
  it("retains saved comments on user removal, then clears them on server acceptance", async () => {
    const { ctx, key, store, chips, last } = await fixture();
    await chips.attach(ctx); await last().onRemove?.("user");
    expect(await store.load(key)).toEqual([savedComment]);
    await chips.attach(ctx); await last().onRemove?.("submitted");
    expect(await store.load(key)).toEqual([]);
  });
  it("clears only unchanged versions in the acknowledged snapshot", async () => {
    const { ctx, key, store, chips, last } = await fixture();
    await store.add(key, { ...savedComment, id: "unchanged" });
    await chips.attach(ctx); const sent = last();
    await store.update(key, { ...savedComment, body: "edited while sending" });
    await store.add(key, { ...savedComment, id: "new" });
    await sent.onRemove?.("submitted");
    expect(await store.load(key)).toEqual([{ ...savedComment, body: "edited while sending" }, { ...savedComment, id: "new" }]);
  });
  it("does not retire a newer attachment when an older chip is accepted", async () => {
    const { ctx, key, store, chips, last, remove } = await fixture();
    await chips.attach(ctx); const first = last();
    await chips.attach(ctx); const second = last();
    await first.onRemove?.("submitted");
    expect(await store.load(key)).toEqual([savedComment]);
    chips.withdrawWorkspace(key);
    expect(remove).toHaveBeenCalledWith(second.id);
    // Withdrawal does not undo an already accepted request's callback.
    await second.onRemove?.("submitted");
    expect(await store.load(key)).toEqual([]);
  });
  it("settles the captured workspace even after navigation", async () => {
    const { ctx, key, store, chips, last } = await fixture();
    await chips.attach(ctx); const sent = last();
    ctx.workspace = { ...ctx.workspace, id: "other" };
    await store.add(workspaceKey(ctx), { ...savedComment, body: "other workspace" });
    await sent.onRemove?.("submitted");
    expect(await store.load(key)).toEqual([]);
    expect((await store.load(workspaceKey(ctx)))[0]?.body).toBe("other workspace");
  });
  it("withdraws stale chips on cross-tab changes without mutating saved comments", async () => {
    const { ctx, key, store, chips, last, remove } = await fixture();
    await chips.attach(ctx); const staged = last();
    chips.storageChanged(key);
    expect(remove).toHaveBeenCalledWith(staged.id);
    expect(await store.load(key)).toEqual([savedComment]);
  });
  it("surfaces acknowledgement persistence failures and retains the original feedback", async () => {
    const { ctx, key, store, storage, chips, last, notify } = await fixture();
    await chips.attach(ctx);
    const failure = vi.spyOn(storage, "transact").mockRejectedValueOnce(new Error("quota"));
    await expect(last().onRemove?.("submitted")).rejects.toThrow("quota");
    failure.mockRestore();
    expect(await store.load(key)).toEqual([savedComment]);
    expect(notify).toHaveBeenLastCalledWith(key, expect.stringContaining("could not be cleared"), expect.any(Error), "acceptance");
  });
  it("fails closed without chips or a ready session in the panel's workspace", async () => {
    const { ctx, chips } = await fixture();
    delete ctx.prompt.setChip;
    await expect(chips.attach(ctx)).rejects.toThrow("composer-chip API");
    const other = context();
    other.state = { ...other.state, selectedSession: { id: "s", cwd: "/other", pending: false, archived: false } };
    await expect(chips.attach(other)).rejects.toThrow("ready, unarchived");
  });
  it.each(["navigation", "edit", "disposal"] as const)("does not stage an obsolete async read after %s", async (cause) => {
    const { ctx, key, store, chips } = await fixture();
    const pending = deferred<Comment[]>();
    const read = vi.spyOn(store, "load").mockReturnValueOnce(pending.promise);
    const stage = vi.fn(); ctx.prompt.setChip = stage;
    const attaching = chips.attach(ctx);
    if (cause === "navigation") ctx.workspace = { ...ctx.workspace, id: "other" };
    if (cause === "edit") chips.withdrawWorkspace(key);
    if (cause === "disposal") chips.dispose();
    pending.resolve([savedComment]); await attaching;
    expect(stage).not.toHaveBeenCalled(); read.mockRestore();
  });
  it("checks replacement ownership when a queued acknowledgement transaction actually runs", async () => {
    const { ctx, key, store, chips, last } = await fixture();
    await chips.attach(ctx); const first = last();
    const gate = deferred<void>();
    const remove = store.removeUnchanged.bind(store);
    const spy = vi.spyOn(store, "removeUnchanged").mockImplementationOnce(async (...args) => {
      await gate.promise; return remove(...args);
    });
    const accepted = first.onRemove?.("submitted");
    await chips.attach(ctx); gate.resolve(); await accepted;
    spy.mockRestore();
    expect(await store.load(key)).toEqual([savedComment]);
  });
  it("retains data and suppresses notification when disposed with acknowledgement pending", async () => {
    const { ctx, key, store, chips, last, notify } = await fixture();
    await chips.attach(ctx);
    const gate = deferred<void>();
    const remove = store.removeUnchanged.bind(store);
    const spy = vi.spyOn(store, "removeUnchanged").mockImplementationOnce(async (...args) => {
      await gate.promise; return remove(...args);
    });
    const accepted = last().onRemove?.("submitted");
    chips.dispose(); notify.mockClear(); gate.resolve(); await accepted;
    spy.mockRestore();
    expect(await store.load(key)).toEqual([savedComment]);
    expect(notify).not.toHaveBeenCalled();
  });
});
