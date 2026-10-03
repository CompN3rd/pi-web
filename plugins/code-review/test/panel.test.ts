// @vitest-environment happy-dom
import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileContentResponse, PluginActivationResult } from "@jmfederico/pi-web/plugin-api";
import plugin from "../src/browser/index.js";
import { ReviewPanel } from "../src/browser/panel.js";
import { renderReviewMarkdown } from "../src/browser/markdown.js";
import { ReviewStore, workspaceKey } from "../src/browser/model.js";
import { context } from "./context.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  document.body.replaceChildren(); localStorage.clear();
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
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
  return { panel, ctx, host, contribution };
}
async function open(panel: ReviewPanel) {
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
    const store = new ReviewStore(localStorage);
    expect(store.load(workspaceKey(ctx))[0]).toMatchObject({ start: 1, end: 3, body: "**Fix** this", source: "files" });
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
    expect(store.load(workspaceKey(ctx))).toEqual([]);
  });
  it("keeps drafts on a storage failure, and retains stale saved comments without attaching them to new lines", async () => {
    const { panel, ctx } = await mount(); await open(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
    await editBody(panel, "keep my work");
    const store = panel.store;
    panel.store = new ReviewStore({ getItem: (key) => localStorage.getItem(key), setItem: () => { throw new Error("storage blocked"); } });
    button(panel, "Save comment").click(); await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("storage blocked");
    expect(panel.shadowRoot?.querySelector<HTMLTextAreaElement>('.editor textarea')?.value).toBe("keep my work");
    panel.store = store; button(panel, "Save comment").click(); await panel.updateComplete;
    ctx.files.readFile = vi.fn().mockResolvedValue({ content: "changed\n", binary: false, truncated: false });
    button(panel, "Refresh").click();
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector(".stale")?.textContent).toContain("Source changed"); });
    expect(panel.shadowRoot?.querySelector(".inline-comment")).toBeNull();
    expect(new ReviewStore(localStorage).load(workspaceKey(ctx))).toHaveLength(1);
  });
  it("discards obsolete file results after a source switch and cleans up on disconnect", async () => {
    const ctx = context(); let finish: ((value: FileContentResponse) => void) | undefined;
    ctx.files.readFile = vi.fn(() => new Promise<FileContentResponse>((resolve) => { finish = resolve; }));
    const { panel, host } = await mount(ctx); button(panel, "a.ts").click();
    const select = required(panel.shadowRoot?.querySelector("select")); select.value = "git-staged"; select.dispatchEvent(new Event("change"));
    required(finish)({ path: "a.ts", content: "obsolete", encoding: "utf8", size: 8, modifiedAt: "now", binary: false, truncated: false });
    await vi.waitFor(() => { expect(panel.shadowRoot?.querySelector('[role="status"]')?.textContent).not.toContain("Loading"); });
    expect(panel.shadowRoot?.textContent).not.toContain("obsolete");
    host.remove(); window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(panel.isConnected).toBe(false);
  });
  it("works on LAN HTTP without randomUUID, SubtleCrypto, or clipboard access", async () => {
    const nativeCrypto = crypto;
    vi.stubGlobal("crypto", { getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto) });
    vi.stubGlobal("navigator", {});
    const { panel, ctx } = await mount(); await open(panel);
    required(panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Current line 1"]')).click(); await panel.updateComplete;
    await editBody(panel, "HTTP comment"); button(panel, "Save comment").click(); await panel.updateComplete;
    expect(new ReviewStore(localStorage).load(workspaceKey(ctx))[0]?.body).toBe("HTTP comment");
    button(panel, "Copy feedback").click(); await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain("Clipboard unavailable");
    expect(panel.shadowRoot?.querySelector<HTMLTextAreaElement>('[aria-label="Feedback Markdown"]')?.value).toContain("HTTP comment");
  });
  it("never renders executable Markdown or remote images", () => {
    const host = document.createElement("div");
    render(renderReviewMarkdown(html, '**safe** <script>alert(1)</script> <img src="https://tracker/" onerror="alert(1)"> [bad](javascript:alert(1))'), host);
    expect(host.querySelector("strong")?.textContent).toBe("safe");
    expect(host.querySelector("script,img,[onerror],[href^='javascript:']")).toBeNull();
  });
});
