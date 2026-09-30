// @vitest-environment happy-dom
import { html, svg } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./pi-web-plugin";

const context = () => ({ apiVersion: 4 as const, pluginId: "mermaid", runtimePluginId: "mermaid", html, svg,
  signal: new AbortController().signal, lifetimeSignal: new AbortController().signal });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function registry() {
  const elements = new Map<string, CustomElementConstructor>();
  const define = vi.fn((name: string, constructor: CustomElementConstructor) => { elements.set(name, constructor); });
  vi.stubGlobal("customElements", { get: (name: string) => elements.get(name), define });
  return { elements, define };
}

it("resolves and validates the renderer capability during start", async () => {
  registry();
  const activation = await plugin.activate(context());
  await expect(Promise.resolve().then(() => activation.start?.({ signal: new AbortController().signal,
    capabilities: { resolve: (token) => token.parse({ listRenderers: () => [] }) },
  }))).rejects.toThrow("Mermaid requires content rendering capability v1");
  let resolved = false;
  await activation.start?.({ signal: new AbortController().signal, capabilities: { resolve: (token) => {
    resolved = true;
    return token.parse({ listRenderers: () => [], renderText: () => html``, renderMarkdown: () => html`` });
  } } });
  expect(resolved).toBe(true);
});

it("reuses portable same-source constructors but refuses unrelated tag owners", async () => {
  const { elements, define } = registry();
  await plugin.activate(context());
  vi.resetModules();
  const copy = (await import("./pi-web-plugin")).default;
  await copy.activate(context());
  expect(define).toHaveBeenCalledOnce();
  class Unrelated extends HTMLElement {}
  elements.set("pi-web-mermaid-preview", Unrelated);
  await expect(Promise.resolve().then(() => copy.activate(context()))).rejects.toThrow("already owned");
  expect(define).toHaveBeenCalledOnce();
});
