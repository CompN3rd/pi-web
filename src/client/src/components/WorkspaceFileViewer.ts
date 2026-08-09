import { css, html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { FileContentResponse } from "../api";
import { workspaceFilePreviewUrl } from "../api/urls";
import { renderWorkspaceMarkdownHtml } from "../formatting/workspaceMarkdown";
import { MAX_INLINE_PREVIEW_BYTES, MAX_INLINE_PREVIEW_LABEL } from "../../../shared/workspaceFiles";
import { formattedTextStyles } from "./shared";

export type WorkspaceFilePreviewKind = "image" | "html" | "pdf" | "markdown" | "download" | "code";
export type WorkspaceFileViewerMode = "preview" | "raw";

export interface WorkspaceFileViewerIdentity {
  machineId: string;
  projectId: string;
  workspaceId: string;
  selectedPath: string | undefined;
  file: FileContentResponse | undefined;
}

@customElement("workspace-file-viewer")
export class WorkspaceFileViewer extends LitElement {
  @property({ attribute: false }) machineId = "";
  @property({ attribute: false }) projectId = "";
  @property({ attribute: false }) workspaceId = "";
  @property({ attribute: false }) selectedPath: string | undefined;
  @property({ attribute: false }) file: FileContentResponse | undefined;
  @property({ attribute: false }) loadError: string | undefined;
  @property({ attribute: false }) previewUrlBuilder: typeof workspaceFilePreviewUrl = workspaceFilePreviewUrl;

  private mode: WorkspaceFileViewerMode = "preview";
  private failedPreviewKey: string | undefined;
  private activeFileKey: string | undefined;

  protected override willUpdate(): void {
    const nextKey = this.currentFileKey();
    if (nextKey === this.activeFileKey) return;
    this.activeFileKey = nextKey;
    this.mode = "preview";
    this.failedPreviewKey = undefined;
  }

  override render(): TemplateResult {
    const selectedPath = this.selectedPath;
    if (selectedPath === undefined || selectedPath === "") return this.renderStatus("Select a file.");
    if (this.loadError !== undefined) return this.renderStatus(`Unable to load ${selectedPath}: ${this.loadError}`, true);

    const file = this.file;
    if (file === undefined) return this.renderStatus(`Loading ${selectedPath}…`);
    if (file.path !== selectedPath) {
      return this.renderStatus(`Unable to preview ${selectedPath}: loaded content belongs to ${file.path}.`, true);
    }

    const key = this.currentFileKey();
    const kind = workspaceFilePreviewKind(file);
    const canOpen = isBrowserPreviewKind(kind) && file.size > 0 && file.size <= MAX_INLINE_PREVIEW_BYTES;
    return html`
      ${this.renderViewerHeader(file, metadataForFile(file, kind), canOpen)}
      ${hasRenderedMode(kind) ? this.renderModeControls(file, key) : null}
      ${this.renderLoadedFile(file, kind, key)}
    `;
  }

  private renderLoadedFile(file: FileContentResponse, kind: WorkspaceFilePreviewKind, key: string): TemplateResult {
    if (hasRenderedMode(kind) && this.mode === "raw") return this.renderRawSource(file);
    if (file.size === 0) return this.renderStatus("This file is empty.");

    switch (kind) {
      case "image": return this.renderImagePreview(file, key);
      case "html": return this.renderFramePreview(file, "html", key);
      case "pdf": return this.renderFramePreview(file, "pdf", key);
      case "markdown": return this.renderMarkdownPreview(file);
      case "download": return this.renderUnsupportedFile(file);
      case "code": return this.renderRawSource(file);
    }
  }

  private renderViewerHeader(file: FileContentResponse, metadata: string, canOpen: boolean): TemplateResult {
    const name = fileBaseName(file.path);
    const previewOptions = { modifiedAt: file.modifiedAt, machineId: this.machineId };
    const openUrl = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, previewOptions);
    const downloadUrl = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, { ...previewOptions, download: true });
    return html`
      <div class="viewer-header">
        <strong title=${file.path}>${file.path}</strong>
        <div class="viewer-actions">
          <small>${metadata}</small>
          ${canOpen ? html`
            <a
              class="viewer-action"
              href=${openUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerpolicy="no-referrer"
              title="Open in new window"
            >Open ↗</a>
          ` : null}
          <a class="viewer-action" href=${downloadUrl} download=${name} title=${`Download ${name}`}>Download</a>
        </div>
      </div>
    `;
  }

  private renderModeControls(file: FileContentResponse, key: string): TemplateResult {
    return html`
      <div class="viewer-mode" role="group" aria-label=${`View ${file.path}`}>
        <button
          type="button"
          aria-pressed=${this.mode === "preview" ? "true" : "false"}
          @click=${() => { this.setMode("preview", key); }}
        >Preview</button>
        <button
          type="button"
          aria-pressed=${this.mode === "raw" ? "true" : "false"}
          @click=${() => { this.setMode("raw", key); }}
        >Raw</button>
      </div>
    `;
  }

  private renderRawSource(file: FileContentResponse): TemplateResult {
    if (file.size === 0) return this.renderStatus("This file is empty.");
    loadCodeViewer();
    return html`
      ${file.truncated ? html`<p class="preview-note" role="status">Raw source is truncated. Use Download for the complete file.</p>` : null}
      <code-viewer .content=${file.content} .language=${file.language}></code-viewer>
    `;
  }

  private renderMarkdownPreview(file: FileContentResponse): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    try {
      const sanitized = renderWorkspaceMarkdownHtml(file.content);
      return html`
        ${file.truncated ? html`<p class="preview-note" role="status">Preview is rendered from truncated source. Use Download for the complete file.</p>` : null}
        <div class="formatted markdown-preview" dir="auto">${unsafeHTML(sanitized)}</div>
      `;
    } catch {
      return this.renderStatus("Markdown preview failed. Use Raw or Download instead.", true);
    }
  }

  private renderImagePreview(file: FileContentResponse, key: string): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    if (this.failedPreviewKey === key) return this.renderPreviewFailure(file, key);
    const src = this.previewUrl(file);
    return html`
      <div class="image-preview">
        <img
          src=${src}
          alt=${`Preview of ${file.path}`}
          decoding="async"
          referrerpolicy="no-referrer"
          @error=${() => { this.recordPreviewFailure(key); }}
        />
      </div>
    `;
  }

  private renderFramePreview(file: FileContentResponse, kind: "html" | "pdf", key: string): TemplateResult {
    if (file.size > MAX_INLINE_PREVIEW_BYTES) return this.renderPreviewTooLarge(file);
    if (this.failedPreviewKey === key) return this.renderPreviewFailure(file, key);
    const src = this.previewUrl(file);

    // HTML receives no sandbox allowances. PDF gets only same-origin identity so
    // native browser viewers can load; scripts, forms, popups, and navigation
    // remain blocked. Response CSP applies the matching server-side policy.
    return kind === "html" ? html`
      <iframe
        class="file-frame-preview"
        src=${src}
        sandbox=""
        allow=""
        referrerpolicy="no-referrer"
        title=${`Preview of ${file.path}`}
        @error=${() => { this.recordPreviewFailure(key); }}
      ></iframe>
    ` : html`
      <iframe
        class="file-frame-preview"
        src=${src}
        sandbox="allow-same-origin"
        allow=""
        referrerpolicy="no-referrer"
        title=${`Preview of ${file.path}`}
        @error=${() => { this.recordPreviewFailure(key); }}
      ></iframe>
    `;
  }

  private renderPreviewFailure(file: FileContentResponse, key: string): TemplateResult {
    return html`
      <div class="preview-state" role="alert">
        <strong>Preview failed for ${file.path}.</strong>
        <span>Open it in a new window or use Download above.</span>
        <button type="button" @click=${() => { this.retryPreview(key); }}>Retry preview</button>
      </div>
    `;
  }

  private renderUnsupportedFile(file: FileContentResponse): TemplateResult {
    const name = fileBaseName(file.path);
    const href = this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, {
      modifiedAt: file.modifiedAt,
      machineId: this.machineId,
      download: true,
    });
    return html`
      <div class="preview-state">
        <p>Preview isn't available for this file type.</p>
        <a class="download-link" href=${href} download=${name}>Download ${name} · ${formatFileSize(file.size)}</a>
      </div>
    `;
  }

  private renderPreviewTooLarge(file: FileContentResponse): TemplateResult {
    return this.renderStatus(`File too large to preview: ${formatFileSize(file.size)} · limit ${MAX_INLINE_PREVIEW_LABEL}. Use Download above.`);
  }

  private renderStatus(message: string, alert = false): TemplateResult {
    return alert
      ? html`<p class="viewer-status" role="alert">${message}</p>`
      : html`<p class="viewer-status" role="status" aria-live="polite">${message}</p>`;
  }

  private previewUrl(file: FileContentResponse): string {
    return this.previewUrlBuilder(this.projectId, this.workspaceId, file.path, {
      modifiedAt: file.modifiedAt,
      machineId: this.machineId,
    });
  }

  private setMode(mode: WorkspaceFileViewerMode, key: string): void {
    if (key !== this.currentFileKey()) return;
    this.mode = mode;
    this.failedPreviewKey = undefined;
    this.requestUpdate();
  }

  private recordPreviewFailure(key: string): void {
    if (key !== this.currentFileKey() || this.mode !== "preview") return;
    this.failedPreviewKey = key;
    this.requestUpdate();
  }

  private retryPreview(key: string): void {
    if (key !== this.currentFileKey()) return;
    this.failedPreviewKey = undefined;
    this.requestUpdate();
  }

  private currentFileKey(): string {
    return workspaceFileViewerIdentityKey(this);
  }

  static override styles = [
    formattedTextStyles,
    css`
      :host { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: auto; color: var(--pi-text); font: 14px system-ui, sans-serif; }
      .viewer-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
      .viewer-header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .viewer-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
      small { color: var(--pi-muted); }
      .viewer-action, .download-link { flex: 0 0 auto; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); text-decoration: none; white-space: nowrap; }
      .viewer-action { padding: 3px 8px; font-size: 12px; }
      .viewer-action:hover, .download-link:hover { border-color: var(--pi-border); background: var(--pi-bg); }
      .viewer-mode { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-bg); }
      .viewer-mode button, .preview-state button { border: 1px solid var(--pi-border); border-radius: 6px; background: var(--pi-surface); color: var(--pi-text); padding: 4px 9px; cursor: pointer; font: inherit; }
      .viewer-mode button { font-size: 12px; }
      .viewer-mode button[aria-pressed="true"] { border-color: var(--pi-accent); background: var(--pi-selection-bg); }
      .viewer-mode button:focus-visible, .preview-state button:focus-visible, a:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 1px; }
      code-viewer { flex: 1 1 auto; min-height: 0; }
      .markdown-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; overflow: auto; padding: 16px; }
      .preview-note { flex: 0 0 auto; margin: 0; border-bottom: 1px solid var(--pi-border-muted); background: var(--pi-surface); color: var(--pi-muted); padding: 7px 10px; font-size: 12px; }
      .image-preview { flex: 1 1 auto; min-height: 0; box-sizing: border-box; display: flex; align-items: center; justify-content: center; overflow: auto; padding: 16px; }
      .image-preview img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid var(--pi-border-muted); border-radius: 8px; background-color: var(--pi-surface); background-image: linear-gradient(45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(-45deg, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%), linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--pi-border-muted) 45%, transparent) 75%); background-position: 0 0, 0 8px, 8px -8px, -8px 0; background-size: 16px 16px; box-shadow: 0 8px 24px var(--pi-shadow-soft); }
      .file-frame-preview { flex: 1 1 auto; min-height: 0; width: 100%; border: none; background: var(--pi-surface); }
      .viewer-status { box-sizing: border-box; margin: auto; max-width: 100%; color: var(--pi-muted); padding: 18px; text-align: center; overflow-wrap: anywhere; }
      .preview-state { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; box-sizing: border-box; padding: 24px; color: var(--pi-muted); text-align: center; }
      .preview-state strong { color: var(--pi-text); }
      .preview-state p { margin: 0; }
      .download-link { display: inline-block; padding: 8px 16px; font-size: 13px; }
      @media (max-width: 640px) {
        .viewer-header { align-items: flex-start; flex-direction: column; }
        .viewer-actions { width: 100%; flex-wrap: wrap; }
      }
    `,
  ];
}

/** Stable state key for mode and embedded-preview failure ownership. */
export function workspaceFileViewerIdentityKey(identity: WorkspaceFileViewerIdentity): string {
  return JSON.stringify([
    identity.machineId,
    identity.projectId,
    identity.workspaceId,
    identity.selectedPath ?? null,
    identity.file?.path ?? null,
    identity.file?.modifiedAt ?? null,
    identity.file?.mediaType ?? null,
  ]);
}

export function workspaceFilePreviewKind(file: FileContentResponse): WorkspaceFilePreviewKind {
  if (file.mediaType === "image") return "image";
  if (file.mediaType === "html") return "html";
  if (file.mediaType === "pdf") return "pdf";
  if (file.mediaType === "markdown") return "markdown";
  if (file.binary) return "download";
  return "code";
}

function hasRenderedMode(kind: WorkspaceFilePreviewKind): kind is "html" | "markdown" {
  return kind === "html" || kind === "markdown";
}

function isBrowserPreviewKind(kind: WorkspaceFilePreviewKind): kind is "image" | "html" | "pdf" {
  return kind === "image" || kind === "html" || kind === "pdf";
}

function metadataForFile(file: FileContentResponse, kind: WorkspaceFilePreviewKind): string {
  const format = kind === "code"
    ? file.language ?? "text"
    : kind === "download"
      ? file.mimeType ?? "binary"
      : kind === "markdown"
        ? "markdown"
        : file.mimeType ?? kind;
  return `${format} · ${formatFileSize(file.size)}${file.truncated ? " · truncated" : ""}`;
}

function fileBaseName(path: string): string {
  const name = path.split("/").pop();
  return name === undefined || name === "" ? path : name;
}

function loadCodeViewer(): void {
  void import("./CodeViewer");
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  if (size < 1024) return `${String(size)} B`;
  const kib = size / 1024;
  if (kib < 1024) return `${formatScaledFileSize(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${formatScaledFileSize(mib)} MB`;
  return `${formatScaledFileSize(mib / 1024)} GB`;
}

function formatScaledFileSize(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
