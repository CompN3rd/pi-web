import { LitElement, css, html, type PropertyValues } from "lit";
import { renderReviewMarkdown } from "./markdown.js";
import type { FileTreeEntry, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { isGitSource, isWorkspacePath, MAX_FILES, MAX_TEXT_LENGTH, parseDiff, parsePaths, type ReviewSource } from "../protocol.js";
import { anchorInSnapshot, anchorLabel, randomId, ReviewStore, reviewMarkdown, snapshot, sourceLabel, storagePrefix, workspaceKey, type Anchor, type Comment, type Row, type Snapshot } from "./model.js";
import { insertFeedback } from "./transfer.js";
import type { SelectionService } from "./selection.js";

interface Editor extends Anchor { body: string; hash: string; id?: string; createdAt?: number }

export class ReviewPanel extends LitElement {
  static override properties = { context: { attribute: false }, revision: { type: Number } };
  declare context: WorkspacePanelContext;
  declare revision: number;
  selection: SelectionService | undefined;
  store: ReviewStore | undefined;
  lifetime: AbortSignal | undefined;
  private source: ReviewSource = "files";
  private directory = "";
  private entries: FileTreeEntry[] = [];
  private view: Snapshot | undefined;
  private editor: Editor | undefined;
  private comments: Comment[] = [];
  private error = "";
  private notice = "";
  private listLoading = false;
  private viewLoading = false;
  private transferring = false;
  private listing: AbortController | undefined;
  private reading: AbortController | undefined;
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === storagePrefix + workspaceKey(this.context)) { this.loadComments(); this.requestUpdate(); }
  };

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("storage", this.onStorage);
    this.loadComments();
    void this.refresh();
  }
  override disconnectedCallback(): void {
    window.removeEventListener("storage", this.onStorage);
    this.listing?.abort(); this.reading?.abort();
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("revision") && changed.get("revision") !== undefined) void this.refresh();
  }
  private fail(error: unknown): void { this.error = error instanceof Error ? error.message : String(error); this.requestUpdate(); }
  private loadComments(): void {
    try { this.comments = this.requireStore().load(workspaceKey(this.context)); }
    catch (error) { this.fail(error); }
  }
  private requireStore(): ReviewStore {
    if (this.store === undefined) throw new Error("Review storage is unavailable");
    return this.store;
  }
  private signal(controller: AbortController): AbortSignal {
    return this.lifetime === undefined ? controller.signal : AbortSignal.any([controller.signal, this.lifetime]);
  }
  private async refresh(): Promise<void> {
    const path = this.view?.path;
    await Promise.all([this.loadList(), path === undefined ? Promise.resolve() : this.openFile(path)]);
  }
  private async loadList(): Promise<void> {
    this.listing?.abort();
    const controller = new AbortController(); this.listing = controller;
    const signal = this.signal(controller);
    this.listLoading = true; this.error = ""; this.requestUpdate();
    try {
      let entries: FileTreeEntry[];
      if (this.source === "files") {
        const result = this.context.files.capabilityVersion === 1
          ? await this.context.files.listFiles(this.directory, { signal }) : await this.context.files.listFiles(this.directory);
        if (result.truncated || result.entries.length > MAX_FILES) throw new Error("Directory is too large; enter a narrower directory");
        entries = result.entries.filter((entry) => isWorkspacePath(entry.path));
      } else {
        const peer = this.context.peer;
        if (peer?.request === undefined) throw new Error("Git review backend is unavailable. Enable the plugin on this machine and restart its session daemon");
        const paths = parsePaths(await peer.request("changes", { source: this.source }, { signal }));
        entries = paths.map((path) => ({ path, name: path, type: "file" }));
      }
      if (signal.aborted) return;
      this.entries = entries;
    } catch (error) { if (!signal.aborted) this.fail(error); }
    finally { if (this.listing === controller) { this.listLoading = false; this.requestUpdate(); } }
  }
  private async openFile(path: string): Promise<void> {
    this.reading?.abort();
    const controller = new AbortController(); this.reading = controller;
    const signal = this.signal(controller);
    const source = this.source;
    this.viewLoading = true; this.error = ""; this.requestUpdate();
    try {
      if (!isWorkspacePath(path)) throw new Error("Enter a workspace-relative file path");
      let text: string;
      if (source === "files") {
        const result = this.context.files.capabilityVersion === 1
          ? await this.context.files.readFile(path, { signal }) : await this.context.files.readFile(path);
        if (result.binary || result.truncated || result.content.length > MAX_TEXT_LENGTH) throw new Error("Binary, truncated, or oversized files cannot be reviewed inline");
        text = result.content;
      } else {
        const peer = this.context.peer;
        if (peer?.request === undefined) throw new Error("Git review backend unavailable");
        text = parseDiff(await peer.request("diff", { source, path }, { signal }));
      }
      const next = snapshot(path, source, text);
      if (signal.aborted) return;
      this.view = next;
      // Never attach an unfinished comment to refreshed or unrelated content.
      if (this.editor !== undefined && (this.editor.path !== path || this.editor.source !== source || this.editor.hash !== next.hash)) {
        this.notice = "The source changed. Your unfinished comment remains below, but cannot be saved against this snapshot. Copy its text before cancelling.";
      }
    } catch (error) { if (!signal.aborted) { this.view = undefined; this.fail(error); } }
    finally { if (this.reading === controller) { this.viewLoading = false; this.requestUpdate(); } }
  }
  private selectSource(value: string): void {
    if (value !== "files" && !isGitSource(value)) return;
    this.source = value; this.view = undefined; this.entries = [];
    this.reading?.abort(); this.reading = undefined; this.viewLoading = false;
    void this.loadList();
  }
  private selectLine(row: Row, extend: boolean): void {
    const view = this.view;
    if (view === undefined || this.viewLoading || row.line === undefined || row.side === undefined) return;
    if (extend && this.editor !== undefined && this.editor.id === undefined && this.editor.path === view.path && this.editor.source === view.source && this.editor.side === row.side && this.editor.hash === view.hash) {
      this.editor = { ...this.editor, start: Math.min(this.editor.start, row.line), end: Math.max(this.editor.start, row.line) };
    } else if (this.editor === undefined) {
      this.editor = { path: view.path, source: view.source, side: row.side, start: row.line, end: row.line, hash: view.hash, body: "" };
    } else {
      this.notice = "Save or cancel the current comment first. Shift-click extends a range on the same side.";
    }
    this.requestUpdate();
  }
  private saveEditor(): void {
    const editor = this.editor;
    if (editor === undefined || editor.body.trim() === "" || this.viewLoading || editor.hash !== this.view?.hash || !anchorInSnapshot(editor, this.view)) return;
    try {
      const comment: Comment = { ...editor, id: editor.id ?? randomId(), createdAt: editor.createdAt ?? Date.now() };
      const store = this.requireStore(); const key = workspaceKey(this.context);
      this.comments = editor.id === undefined ? store.add(key, comment) : store.update(key, comment);
      this.editor = undefined; this.error = ""; this.notice = "Comment saved in this browser.";
      this.context.host.requestRender(); this.requestUpdate();
    } catch (error) { this.fail(error); }
  }
  private removeComment(comment: Comment): void {
    try {
      this.comments = this.requireStore().remove(workspaceKey(this.context), comment.id);
      if (this.editor?.id === comment.id) this.editor = undefined;
      this.context.host.requestRender(); this.requestUpdate();
    } catch (error) { this.fail(error); }
  }
  private editComment(comment: Comment): void {
    if (this.editor !== undefined) { this.notice = "Save or cancel the current comment first."; this.requestUpdate(); return; }
    this.editor = { ...comment };
    this.source = comment.source;
    void this.loadList(); void this.openFile(comment.path);
  }
  private async transfer(copy: boolean): Promise<void> {
    if (this.transferring) return;
    this.transferring = true; this.error = ""; this.requestUpdate();
    try {
      const comments = this.requireStore().load(workspaceKey(this.context));
      const markdown = reviewMarkdown(comments);
      if (markdown === "") throw new Error("There are no saved comments");
      if (copy) {
        if (!("clipboard" in navigator)) throw new Error("Clipboard unavailable. Expand Feedback Markdown (manual copy) below to copy your feedback.");
        await navigator.clipboard.writeText(markdown);
        this.notice = "Feedback copied. Saved comments were retained.";
      } else {
        await insertFeedback(this.context, this.selection, comments, this.lifetime);
        this.notice = "Feedback inserted, not sent. Saved comments were retained.";
      }
    } catch (error) { this.fail(error); }
    finally { this.transferring = false; this.requestUpdate(); }
  }
  private changeEditor(field: "body" | "start" | "end", event: Event): void {
    if (this.editor === undefined || !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) return;
    this.editor = { ...this.editor, [field]: field === "body" ? event.target.value : Number(event.target.value) };
    this.requestUpdate();
  }
  private renderEditor() {
    const editor = this.editor;
    if (editor === undefined) return null;
    const valid = !this.viewLoading && editor.hash === this.view?.hash && anchorInSnapshot(editor, this.view);
    return html`<section class="editor" aria-label="Comment editor">
      <strong>${anchorLabel(editor)}</strong>
      <div class="toolbar"><label>Start line <input type="number" min="1" step="1" .value=${String(editor.start)} @input=${(event: Event) => { this.changeEditor("start", event); }}></label>
      <label>End line <input type="number" min="1" step="1" .value=${String(editor.end)} @input=${(event: Event) => { this.changeEditor("end", event); }}></label></div>
      ${valid ? null : html`<p role="alert">Choose a valid range in the current snapshot on one side. Omitted diff lines cannot be selected. Changed snapshots cannot be re-anchored automatically.</p>`}
      <label>Comment (Markdown)<textarea rows="4" .value=${editor.body} @input=${(event: Event) => { this.changeEditor("body", event); }} @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); this.saveEditor(); }
      }}></textarea></label>
      <div class="toolbar"><button ?disabled=${!valid || editor.body.trim() === ""} @click=${() => { this.saveEditor(); }}>Save comment</button>
      <button @click=${() => { this.editor = undefined; this.notice = ""; this.requestUpdate(); }}>Cancel edit</button></div>
    </section>`;
  }
  override render() {
    const view = this.view;
    return html`<section aria-label="Code Review">
      <h2>Code Review</h2>
      <p>Saved comments belong to this workspace in this browser. Insert or copy them when ready; remove them after sending.</p>
      <div class="toolbar"><label>Source <select .value=${this.source} @change=${(event: Event) => { if (event.target instanceof HTMLSelectElement) this.selectSource(event.target.value); }}>
        <option value="files">Files (including untracked)</option><option value="git-unstaged">Git unstaged</option><option value="git-staged">Git staged</option>
      </select></label><button @click=${() => { void this.refresh(); }}>Refresh</button></div>
      ${this.source === "files" ? html`<form class="toolbar" @submit=${(event: SubmitEvent) => {
        event.preventDefault(); const form = event.currentTarget;
        if (form instanceof HTMLFormElement) {
          const path = new FormData(form).get("path"); if (typeof path === "string") void this.openFile(path);
        }
      }}><label>File path <input name="path" placeholder="src/example.ts"></label><button>Open file</button></form>` : null}
      ${this.error === "" ? null : html`<p role="alert">${this.error}</p>`}
      <p role="status" aria-live="polite">${this.listLoading || this.viewLoading ? "Loading…" : this.notice}</p>
      <details class="file-list" open><summary>${this.source === "files" ? this.directory || "Workspace files" : `${sourceLabel(this.source)} files`}</summary>
        ${this.source === "files" && this.directory !== "" ? html`<button @click=${() => { this.directory = this.directory.split("/").slice(0, -1).join("/"); void this.loadList(); }}>Parent directory</button>` : null}
        ${this.entries.map((entry) => html`<button ?disabled=${this.listLoading} @click=${() => {
          if (entry.type === "directory") { this.directory = entry.path; void this.loadList(); }
          else void this.openFile(entry.path);
        }}>${entry.type === "directory" ? "📁 " : ""}${entry.name}</button>`)}
        ${!this.listLoading && this.entries.length === 0 ? html`<p>No files in this view.</p>` : null}
      </details>
      ${view === undefined ? null : html`<h3>${view.path} — ${sourceLabel(view.source)}</h3><p>Click a line number, then Shift-click to extend its range, or edit the range below (works on touch screens).</p>
        <div class="code" aria-label="Review source" aria-busy=${String(this.viewLoading)}>${view.rows.map((row) => {
          const anchor = row.line === undefined || row.side === undefined ? undefined : { path: view.path, source: view.source, side: row.side, start: row.line, end: row.line };
          const selected = anchor !== undefined && this.editor?.path === view.path && this.editor.source === view.source && this.editor.hash === view.hash
            && this.editor.side === row.side && anchor.start >= this.editor.start && anchor.start <= this.editor.end;
          const comments = anchor === undefined ? [] : this.comments.filter((comment) => comment.path === view.path && comment.source === view.source && comment.hash === view.hash && comment.side === row.side && comment.start === row.line);
          return html`<div class=${`row ${row.kind}${selected ? " selected" : ""}`}>
            ${anchor === undefined ? html`<span class="line"></span>` : html`<button class="line" aria-label=${`${row.side === "old" ? "Deleted" : "Current"} line ${String(row.line)}`} aria-pressed=${String(selected)} ?disabled=${this.viewLoading} @click=${(event: MouseEvent) => { this.selectLine(row, event.shiftKey); }}>${row.line}</button>`}
            <code>${row.text || " "}</code></div>${comments.map((comment) => html`<div class="inline-comment">${renderReviewMarkdown(html, comment.body)}</div>`)}`;
        })}</div>${view.rows.length === 0 ? html`<p>No text lines to review.</p>` : null}`}
      ${this.renderEditor()}
      <h3>Saved comments (${this.comments.length})</h3>
      <div class="toolbar"><button ?disabled=${this.comments.length === 0 || this.transferring} @click=${() => { void this.transfer(false); }}>Insert into prompt</button>
        <button ?disabled=${this.comments.length === 0 || this.transferring} @click=${() => { void this.transfer(true); }}>Copy feedback</button></div>
      ${this.comments.map((comment) => html`<article><strong>${anchorLabel(comment)}</strong>
        ${comment.path === view?.path && comment.source === view.source && comment.hash !== view.hash ? html`<p class="stale">Source changed since this comment was saved. Verify its coordinates before sending.</p>` : null}
        <div class="markdown">${renderReviewMarkdown(html, comment.body)}</div>
        <div class="toolbar"><button @click=${() => { this.editComment(comment); }}>Edit comment</button><button @click=${() => { this.removeComment(comment); }}>Remove comment</button></div>
      </article>`)}
      <details><summary>Feedback Markdown (manual copy)</summary><textarea aria-label="Feedback Markdown" readonly rows="8" .value=${reviewMarkdown(this.comments)}></textarea></details>
    </section>`;
  }
  static override styles = css`
    :host { display: block; color: var(--pi-text, #ddd); font: 14px system-ui, sans-serif; }
    section { padding: 12px; } h2 { margin-top: 0; } p { line-height: 1.5; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin: 8px 0; }
    label { display: flex; flex-direction: column; gap: 4px; }
    button, select, input, textarea { color: inherit; background: var(--pi-surface, #222); border: 1px solid var(--pi-border, #666); border-radius: 4px; padding: 6px; font: inherit; }
    button { cursor: pointer; } button:disabled { opacity: .5; cursor: default; } button:focus-visible { outline: 2px solid var(--pi-accent, #6cf); }
    textarea { box-sizing: border-box; width: 100%; resize: vertical; } input[type=number] { width: 6em; }
    .file-list { max-height: 220px; overflow: auto; margin: 12px 0; } .file-list button { display: block; text-align: left; margin: 3px 0; overflow-wrap: anywhere; }
    .code { max-height: 55vh; overflow: auto; border: 1px solid var(--pi-border, #666); }
    .row { display: flex; min-width: max-content; } .row code { white-space: pre; padding: 2px 8px; font: 12px ui-monospace, monospace; }
    .line { flex: 0 0 4em; border-radius: 0; padding: 2px; font: 12px ui-monospace, monospace; text-align: right; }
    .add { background: #22883325; } .remove { background: #bb222225; } .meta { color: var(--pi-muted, #999); }
    .selected { background: var(--pi-selection-bg, #336699); } .inline-comment, article, .editor { padding: 10px; margin: 8px 0; border: 1px solid var(--pi-border, #666); border-radius: 6px; white-space: normal; overflow-wrap: anywhere; }
    .inline-comment { max-width: 75ch; } [role=alert], .stale { color: var(--pi-warning, #ecb65b); }
    .markdown pre, .inline-comment pre { overflow: auto; } a { color: var(--pi-accent, #6cf); }
  `;
}
