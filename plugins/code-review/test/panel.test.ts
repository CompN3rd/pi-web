// @vitest-environment happy-dom
import { html, render, svg } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse, PluginActivationResult, PluginPromptChip } from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.js";
import { ReviewPanel } from "../src/browser/panel.js";
import { renderReviewMarkdown } from "../src/browser/markdown.js";
import { ReviewStore, storagePrefix, workspaceKey, type Comment } from "../src/browser/model.js";
import { context, savedComment } from "./context.js";
import { IDBFactory } from "fake-indexeddb";
import { deferred } from "./storageSupport.js";

const cleanups: (() => void)[] = [];
class TestChannel {
  static peers = new Set<TestChannel>();
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  constructor(readonly name: string) { TestChannel.peers.add(this); }
  postMessage(data: unknown) {
    for (const peer of TestChannel.peers) {
      if (peer !== this && peer.name === this.name) queueMicrotask(() => { peer.onmessage?.({ data } as MessageEvent<unknown>); });
    }
  }
  close() { TestChannel.peers.delete(this); this.onmessage = null; }
}
beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("BroadcastChannel", TestChannel);
});
afterEach(() => {
  document.body.replaceChildren(); localStorage.clear();
  for (const cleanup of cleanups.splice(0)) cleanup();
  TestChannel.peers.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing UI fixture"); return value;
}
function button(panel: ReviewPanel, text: string): HTMLButtonElement {
  return required([...panel.shadowRoot?.querySelectorAll("button") ?? []].find((candidate) => candidate.textContent.trim() === text));
}
async function mount(ctx = context()) {
  const lifetime = new AbortController();
  const activation: PluginActivationResult = await plugin.activate({ apiVersion: 4, pluginId: "review", runtimePluginId: "review", html, svg, signal: new AbortController().signal, lifetimeSignal: lifetime.signal });
  const contribution = required(activation.contributions.workspacePanels?.[0]);
  const host = document.createElement("div"); document.body.append(host);
  render(contribution.render(ctx), host);
  const panel = host.firstElementChild;
  if (!(panel instanceof ReviewPanel)) throw new Error("Review panel missing");
  cleanups.push(() => { lifetime.abort(); void activation.dispose?.(new AbortController().signal); });
  await vi.waitFor(() => { expect(button(panel, "a.ts")).toBeDefined(); });
  return { panel, ctx, host, contribution, lifetime, activation };
}
async function open(panel: ReviewPanel) {
  await vi.waitFor(() => { expect(button(panel, "a.ts")).toBeDefined(); });
  button(panel, "a.ts").click();
  await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('[aria-label="Current line 1"]')).not.toBeNull(); });
}
async function editBody(panel: ReviewPanel, body: string) {
  const textarea = required(panel.shadowRoot?.querySelector<HTMLTextAreaElement>('.editor textarea'));
  textarea.value = body; textarea.dispatchEvent(new Event("input")); await panel.updateComplete;
}

describe("standalone Review panel", () => {
  it("selects a range, saves Markdown, edits coordinates, remounts and removes feedback", async () => {
    const { panel, ctx, host, contribution } = await mount(); await open(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 3"]')).dispatchEvent(new MouseEvent("click", { shiftKey: true })); await panel.updateComplete;
    await editBody(panel, "**Fix** this"); button(panel, "Save comment").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('.editor button[disabled]')).toBeNull(); });
    const store = required(panel.store);
    expect((await store.load(workspaceKey(ctx)))[0]).toMatchObject({ start: 1, end: 3, body: "**Fix** this", source: "files" });
    expect(panel.shadowRoot?.querySelector("article strong")?.textContent).toContain("a.ts:1-3");
    expect(panel.shadowRoot?.querySelector("article .markdown strong")?.textContent).toBe("Fix");
    button(panel, "Edit comment").click();
    await vi.waitFor(() => { expect(button(panel, "Save comment").disabled).toBe(false); });
    const end = required([...panel.shadowRoot?.querySelectorAll<HTMLInputElement>('.editor input') ?? []].find((input) => input.parentElement?.textContent.includes("End line") === true));
    end.value = "0"; end.dispatchEvent(new Event("input")); await panel.updateComplete;
    expect(button(panel, "Save comment").disabled).toBe(true);
    button(panel, "Cancel edit").click(); await panel.updateComplete;
    render(null, host); render(contribution.render(ctx), host); await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Saved comments (1)");
    button(panel, "Remove comment").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("Saved comments (0)"); });
    expect(await store.load(workspaceKey(ctx))).toEqual([]);
  });
  it("keeps drafts on a storage failure, and retains stale saved comments without attaching them to new lines", async () => {
    const { panel, ctx } = await mount(); await open(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
    await editBody(panel, "keep my work");
    const store = panel.store;
    panel.store = new ReviewStore({ transact: () => Promise.reject(new Error("storage blocked")) }, localStorage);
    button(panel, "Save comment").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('.editor button[disabled]')).toBeNull(); });
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("storage blocked");
    expect(panel.shadowRoot?.querySelector<HTMLTextAreaElement>('.editor textarea')?.value).toBe("keep my work");
    panel.store = store; button(panel, "Save comment").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('.editor button[disabled]')).toBeNull(); });
    ctx.files.readFile = vi.fn().mockResolvedValue({ content: "changed\n", binary: false, truncated: false });
    button(panel, "Refresh").click();
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector(".stale")?.textContent).toContain("Source changed"); });
    expect(panel.shadowRoot?.querySelector(".inline-comment")).toBeNull();
    expect(await required(panel.store).load(workspaceKey(ctx))).toHaveLength(1);
  });
  it("discards obsolete file results after a source switch and cleans up on disconnect", async () => {
    const ctx = context(); let finish: ((value: FileContentResponse) => void) | undefined;
    ctx.files.readFile = vi.fn(() => new Promise<FileContentResponse>((resolve) => { finish = resolve; }));
    const { panel, host } = await mount(ctx); button(panel, "a.ts").click();
    const select = required(panel.shadowRoot?.querySelector("select")); select.value = "git-staged"; select.dispatchEvent(new Event("change"));
    required(finish)({ path: "a.ts", content: "obsolete", encoding: "utf8", size: 8, modifiedAt: "now", binary: false, truncated: false });
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).not.toContain("Loading"); });
    expect(panel.shadowRoot?.textContent).not.toContain("obsolete");
    host.remove();
    expect(panel.isConnected).toBe(false);
  });
  it("stages feedback on LAN HTTP without prompt insertion or clipboard access", async () => {
    const nativeCrypto = crypto;
    vi.stubGlobal("crypto", { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
    vi.stubGlobal("navigator", {});
    const ctx = context(); const setChip = vi.fn<(chip: PluginPromptChip) => void>(); ctx.prompt.setChip = setChip;
    const { panel, host, contribution } = await mount(ctx); await open(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
    await editBody(panel, "HTTP comment"); button(panel, "Save comment").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('.editor button[disabled]')).toBeNull(); });
    expect((await required(panel.store).load(workspaceKey(ctx)))[0]?.body).toBe("HTTP comment");
    button(panel, "Attach review to composer").click(); await panel.updateComplete;
    await vi.waitFor(() => { expect(setChip).toHaveBeenCalledOnce(); });
    const chip = required(setChip.mock.calls[0]?.[0]);
    expect(chip.text).toContain("HTTP comment");
    render(null, host); // Submission callbacks outlive the Review tab's DOM.
    await chip.onRemove?.("submitted");
    expect(await required(panel.store).load(workspaceKey(ctx))).toEqual([]);
    render(contribution.render(ctx), host); await panel.updateComplete;
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("Saved comments (0)"); });
  });
  it.each(["success", "read failure"])("keeps pending attach ownership across a fresh same-scope context: %s", async (outcome) => {
    const { panel, ctx, host, contribution } = await mount();
    const store = required(panel.store); await store.add(workspaceKey(ctx), savedComment); panel.refreshFeedback();
    await vi.waitFor(() => { expect(button(panel, "Attach review to composer").disabled).toBe(false); });
    const pending = deferred<Comment[]>();
    const read = vi.spyOn(store, "load").mockReturnValueOnce(pending.promise);
    button(panel, "Attach review to composer").click();
    expect(read).toHaveBeenCalledOnce();
    const fresh = context(); render(contribution.render(fresh), host); await panel.updateComplete;
    expect(host.firstElementChild).toBe(panel);
    if (outcome === "success") {
      pending.resolve([savedComment]);
      await vi.waitFor(() => { expect(ctx.prompt.setChip).toHaveBeenCalledOnce(); });
    } else {
      pending.reject(new Error("attach read unavailable"));
      await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("attach read unavailable"); });
      expect(ctx.prompt.setChip).not.toHaveBeenCalled();
    }
    expect(fresh.prompt.setChip).not.toHaveBeenCalled(); // Never redirect to the new facade.
  });
  it.each(["session", "pending", "archived", "workspace", "machine", "project", "away and back"])("cancels pending attachment on a real selection change: %s", async (change) => {
    const { panel, ctx, host, contribution } = await mount();
    const store = required(panel.store); await store.add(workspaceKey(ctx), savedComment); panel.refreshFeedback();
    await vi.waitFor(() => { expect(button(panel, "Attach review to composer").disabled).toBe(false); });
    const pending = deferred<Comment[]>(); const read = vi.spyOn(store, "load").mockReturnValueOnce(pending.promise);
    button(panel, "Attach review to composer").click(); expect(read).toHaveBeenCalledOnce();
    const next = context(); const session = required(next.state.selectedSession);
    if (change === "session" || change === "away and back") next.state = { ...next.state, selectedSession: { ...session, id: "other" } };
    if (change === "pending") next.state = { ...next.state, selectedSession: { ...session, pending: true } };
    if (change === "archived") next.state = { ...next.state, selectedSession: { ...session, archived: true } };
    if (change === "workspace") next.workspace = { ...next.workspace, id: "other" };
    if (change === "machine") next.machine = { ...next.machine, id: "other" };
    if (change === "project") next.workspace = { ...next.workspace, projectId: "other" };
    render(contribution.render(next), host);
    if (change === "away and back") render(contribution.render(ctx), host);
    pending.resolve([savedComment]); await pending.promise; await panel.updateComplete; await panel.updateComplete;
    expect(ctx.prompt.setChip).not.toHaveBeenCalled(); expect(next.prompt.setChip).not.toHaveBeenCalled();
  });
  it.each(["save", "delete"])("routes a detached %s rejection to A after returning from B", async (operation) => {
    const { panel, ctx, host, contribution } = await mount();
    const store = required(panel.store);
    if (operation === "save") {
      await open(panel);
      required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
      await editBody(panel, "pending save");
    } else {
      await store.add(workspaceKey(ctx), savedComment); panel.refreshFeedback();
      await vi.waitFor(() => { expect(button(panel, "Remove comment")).toBeDefined(); });
    }
    const pending = deferred<Comment[]>();
    const mutation = vi.spyOn(store, operation === "save" ? "add" : "remove").mockReturnValueOnce(pending.promise);
    button(panel, operation === "save" ? "Save comment" : "Remove comment").click(); expect(mutation).toHaveBeenCalledOnce();
    const other = context(); other.workspace = { ...other.workspace, id: "other" };
    render(contribution.render(other), host);
    const otherPanel = host.firstElementChild as ReviewPanel; await otherPanel.updateComplete;
    render(contribution.render(ctx), host);
    const remounted = host.firstElementChild as ReviewPanel; await remounted.updateComplete;
    expect(remounted).not.toBe(panel); expect(panel.isConnected).toBe(false);
    pending.reject(new Error(`${operation} failed after return`));
    await vi.waitFor(() => { expect(remounted.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(`${operation} failed after return`); });
    expect(otherPanel.shadowRoot?.textContent).not.toContain(`${operation} failed after return`);
    button(remounted, "Dismiss feedback warning").click(); await remounted.updateComplete;
    render(contribution.render(other), host); render(contribution.render(ctx), host);
    const again = host.firstElementChild as ReviewPanel; await again.updateComplete;
    expect(again.shadowRoot?.textContent).not.toContain(`${operation} failed after return`);
  });
  it("keeps first-mount storage failures visible across source refresh and workspace remount", async () => {
    const ctx = context();
    localStorage.setItem(storagePrefix + workspaceKey(ctx), "broken migration");
    const { panel, host, contribution } = await mount(ctx);
    await vi.waitFor(() => { expect(button(panel, "Dismiss feedback warning")).toBeDefined(); });
    const warning = panel.shadowRoot?.querySelector('[role="alert"]')?.textContent;
    await open(panel); button(panel, "Refresh").click(); await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain(warning);
    const other = context(); other.workspace = { ...other.workspace, id: "other" };
    render(contribution.render(other), host);
    render(contribution.render(ctx), host);
    const remounted = host.firstElementChild as ReviewPanel; await remounted.updateComplete;
    expect(remounted.shadowRoot?.textContent).toContain(warning);
  });
  it("keeps acknowledgement failure visible after navigation, remount and successful source loads", async () => {
    const ctx = context(); const staged = vi.fn<(chip: PluginPromptChip) => void>(); ctx.prompt.setChip = staged;
    const { panel, host, contribution } = await mount(ctx);
    const store = required(panel.store); await store.add(workspaceKey(ctx), savedComment); panel.refreshFeedback();
    await vi.waitFor(() => { expect(button(panel, "Attach review to composer").disabled).toBe(false); });
    button(panel, "Attach review to composer").click();
    await vi.waitFor(() => { expect(staged).toHaveBeenCalledOnce(); });
    const failure = vi.spyOn(store, "removeUnchanged").mockRejectedValueOnce(new Error("quota"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const other = context(); other.workspace = { ...other.workspace, id: "other" };
    render(contribution.render(other), host);
    await expect(required(staged.mock.calls[0]?.[0]).onRemove?.("submitted")).rejects.toThrow("quota");
    render(contribution.render(ctx), host);
    const remounted = host.firstElementChild as ReviewPanel; await remounted.updateComplete;
    await open(remounted); button(remounted, "Refresh").click(); await remounted.updateComplete;
    expect(remounted.shadowRoot?.textContent).toContain("saved feedback could not be cleared");
    expect(await store.load(workspaceKey(ctx))).toEqual([savedComment]);
    failure.mockRestore(); log.mockRestore();
  });
  it.each(["Remove comment", "Attach review to composer"])("retains the accepted-review warning after failed %s and feedback reads until explicit dismissal", async (action) => {
    const ctx = context(); const staged = vi.fn<(chip: PluginPromptChip) => void>(); ctx.prompt.setChip = staged;
    const { panel, host, contribution } = await mount(ctx);
    const store = required(panel.store); await store.add(workspaceKey(ctx), savedComment); panel.refreshFeedback();
    await vi.waitFor(() => { expect(button(panel, "Attach review to composer").disabled).toBe(false); });
    button(panel, "Attach review to composer").click();
    await vi.waitFor(() => { expect(staged).toHaveBeenCalledOnce(); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(store, "removeUnchanged").mockRejectedValue(new Error("storage inaccessible"));
    const reads = vi.spyOn(store, "load").mockRejectedValue(new Error("feedback reads inaccessible"));
    const warning = "The review was accepted, but saved feedback could not be cleared. Check the conversation before attaching it again.";
    await expect(required(staged.mock.calls[0]?.[0]).onRemove?.("submitted")).rejects.toThrow("storage inaccessible");
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain("feedback reads inaccessible"); });
    expect(panel.shadowRoot?.textContent).toContain(warning);
    const actionError = `${action} failed: storage inaccessible`;
    if (action === "Remove comment") vi.spyOn(store, "remove").mockRejectedValue(new Error(actionError));
    else reads.mockRejectedValueOnce(new Error(actionError));
    button(panel, action).click();
    await vi.waitFor(() => { expect(panel.shadowRoot?.textContent).toContain(actionError); });
    expect(panel.shadowRoot?.textContent).toContain(warning);
    expect(staged).toHaveBeenCalledOnce();
    const other = context(); other.workspace = { ...other.workspace, id: "other" };
    render(contribution.render(other), host); render(contribution.render(ctx), host);
    const remounted = host.firstElementChild as ReviewPanel; await remounted.updateComplete;
    await open(remounted); button(remounted, "Refresh").click(); await remounted.updateComplete;
    await vi.waitFor(() => { expect(remounted.shadowRoot?.textContent).toContain("feedback reads inaccessible"); });
    expect(remounted.shadowRoot?.textContent).toContain(warning);
    expect(remounted.shadowRoot?.textContent).toContain(actionError);
    // Recovery must not implicitly dismiss acceptance, action, or read warnings.
    reads.mockRestore(); remounted.refreshFeedback();
    await vi.waitFor(() => { expect(remounted.shadowRoot?.textContent).toContain("Saved comments (1)"); });
    expect(remounted.shadowRoot?.textContent).toContain(warning);
    expect(remounted.shadowRoot?.textContent).toContain(actionError);
    button(remounted, "Dismiss feedback warning").click(); await remounted.updateComplete;
    expect(remounted.shadowRoot?.textContent).not.toContain(warning);
    expect(remounted.shadowRoot?.textContent).not.toContain(actionError);
    render(contribution.render(other), host); render(contribution.render(ctx), host);
    const again = host.firstElementChild as ReviewPanel; await again.updateComplete;
    expect(again.shadowRoot?.textContent).not.toContain(warning);
    expect(again.shadowRoot?.textContent).not.toContain(actionError);
    expect(again.shadowRoot?.textContent).not.toContain("feedback reads inaccessible");
  });
  it("ignores an older feedback read after a newer read and disconnect", async () => {
    const { panel, host } = await mount();
    const store = required(panel.store);
    const older = deferred<Comment[]>(); const newer = deferred<Comment[]>();
    const reads = vi.spyOn(store, "load").mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    panel.refreshFeedback(); panel.refreshFeedback();
    newer.resolve([savedComment]); await newer.promise; await panel.updateComplete;
    older.resolve([]); await older.promise; await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Saved comments (1)");
    const detached = deferred<Comment[]>(); reads.mockReturnValueOnce(detached.promise);
    panel.refreshFeedback(); host.remove(); detached.resolve([]); await detached.promise; await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("Saved comments (1)");
  });
  it("requests a badge rerender even before the Review panel is mounted", async () => {
    const lifetime = new AbortController(); const ctx = context();
    const activation = await plugin.activate({ apiVersion: 4, pluginId: "review", runtimePluginId: "review", html, svg, signal: new AbortController().signal, lifetimeSignal: lifetime.signal });
    cleanups.push(() => { lifetime.abort(); void activation.dispose?.(new AbortController().signal); });
    const contribution = required(activation.contributions.workspacePanels?.[0]);
    contribution.badge?.(ctx);
    await vi.waitFor(() => { expect(ctx.host.requestRender).toHaveBeenCalled(); });
    expect(contribution.badge?.(ctx)).toBeUndefined();
  });
  it("refreshes remote badges and withdraws chips without self-cancelling local attachments", async () => {
    const first = await mount(); const second = await mount();
    const key = workspaceKey(first.ctx);
    first.contribution.badge?.(first.ctx); second.contribution.badge?.(second.ctx);
    await required(first.panel.store).add(key, savedComment); first.panel.refreshFeedback();
    await vi.waitFor(() => { expect(second.panel.shadowRoot?.textContent).toContain("Saved comments (1)"); });
    await vi.waitFor(() => { expect(first.contribution.badge?.(first.ctx)).toBe(1); });
    button(first.panel, "Attach review to composer").click();
    await vi.waitFor(() => { expect(first.ctx.prompt.setChip).toHaveBeenCalledOnce(); });
    expect(first.ctx.prompt.removeChip).not.toHaveBeenCalled();
    await required(second.panel.store).update(key, { ...savedComment, body: "remote edit" });
    await vi.waitFor(() => { expect(first.ctx.prompt.removeChip).toHaveBeenCalledOnce(); });
    await vi.waitFor(() => { expect(first.panel.shadowRoot?.textContent).toContain("remote edit"); });
  });
  it("never renders executable Markdown or remote images", () => {
    const host = document.createElement("div");
    render(renderReviewMarkdown(html, '**safe** <script>alert(1)</script> <img src="https://tracker/" onerror="alert(1)"> [bad](javascript:alert(1))'), host);
    expect(host.querySelector("strong")?.textContent).toBe("safe");
    expect(host.querySelector("script,img,[onerror],[href^='javascript:']")).toBeNull();
  });
});
