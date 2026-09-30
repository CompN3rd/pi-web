import type { ContentRendererInput, ContentRenderingCapability, PluginCapability, PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import { loadMermaidEngine, MermaidPreview } from "./MermaidPreview";

const contentRenderingCapability: PluginCapability<ContentRenderingCapability> = {
  pluginId: "pi-web", id: "content-rendering", version: 1,
  parse(value) {
    if (!isContentRenderingCapability(value)) throw new Error("Mermaid requires content rendering capability v1");
    return value;
  },
};

function isContentRenderingCapability(value: unknown): value is ContentRenderingCapability {
  return typeof value === "object" && value !== null
    && "listRenderers" in value && typeof value.listRenderers === "function"
    && "renderText" in value && typeof value.renderText === "function"
    && "renderMarkdown" in value && typeof value.renderMarkdown === "function";
}

// A new tag lets long-lived tabs retain legacy unmarked constructors without
// trusting them or mounting them as this implementation after a package update.
const elementName = "pi-web-mermaid-preview-v2";
const previewTag = unsafeStatic(elementName);
const ownerKey = Symbol.for("pi-web.mermaid.custom-element-owner.v2");

function defineMermaidPreview(): void {
  const existing = customElements.get(elementName);
  if (existing === undefined) {
    customElements.define(elementName, MermaidPreview);
    Reflect.set(globalThis, ownerKey, MermaidPreview);
  } else if (existing === MermaidPreview) {
    Reflect.set(globalThis, ownerKey, existing);
  } else if (Reflect.get(globalThis, ownerKey) !== existing) {
    throw new Error(`Mermaid custom element name is already owned: ${elementName}`);
  }
}

const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "Mermaid",
  // Fail explicitly on older API v4 hosts that cannot consume renderers.
  requires: [contentRenderingCapability],
  activate: ({ html }) => {
    // Portable machine copies share one tag but retain the active package's
    // source and asset loader, never the first machine's artifact URL.
    defineMermaidPreview();
    return {
      start: ({ capabilities }) => { capabilities.resolve(contentRenderingCapability); },
      contributions: {
        contentRenderers: [{
          id: "diagram",
          languages: ["mermaid"],
          fileExtensions: ["mmd", "mermaid"],
          render: (input: ContentRendererInput) => html`${staticHtml`<${previewTag} .input=${input} .loadEngine=${loadMermaidEngine}></${previewTag}>`}`,
        }],
      },
    };
  },
};

export default plugin;
