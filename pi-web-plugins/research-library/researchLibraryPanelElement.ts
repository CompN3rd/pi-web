import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { MAX_RESEARCH_ANNOTATION_BODY, RESEARCH_ANNOTATIONS_ROOT, type ResearchAnnotation, type ResearchAnnotationKind } from "./annotationModel.js";
import { createPaperAnnotation, deleteAnnotationRecord, loadPaperAnnotations, saveAnnotationChanges } from "./annotationsClient.js";
import { citedByPaperIds, paperById, RESEARCH_LIBRARY_CONFIG_PATH, type SyntheticPaper, type SyntheticResearchLibraryConfig } from "./config.js";
import { loadSyntheticAnswerDrafts, type SyntheticAnswerDraft, type SyntheticDraftsLoadResult } from "./draftsClient.js";
import { getOrLoadResearchLibrarySource, refreshResearchLibrarySource, type ResearchLibrarySourceState } from "./fixtureCache.js";
import { pilotPaperById, RESEARCH_LIBRARY_PILOT_CONFIG_PATH, type LocalPilotPaper, type LocalResearchLibraryPilotConfig } from "./pilotConfig.js";
import {
  researchLibraryPdfViewerTagName,
  researchPdfAnnotationEventName,
  researchPdfSelectionEventName,
  type ResearchLibraryPdfViewerElement,
  type ResearchPdfSelectionDetail,
} from "./pdfViewerElement.js";
import { prepareResearchDispatch, type ResearchDispatchIntent } from "./researchLibraryClient.js";

export const researchLibraryPanelTagName = "pi-web-research-library-panel";

interface PanelStatus { kind: "info" | "success" | "error"; message: string }
type DraftState = { kind: "loading" } | SyntheticDraftsLoadResult;
type AnnotationState =
  | { kind: "loading" }
  | { kind: "loaded"; annotations: ResearchAnnotation[]; warnings: string[] }
  | { kind: "unavailable"; error: string };

export function defineResearchLibraryPanelElement(): void {
  if (!customElements.get(researchLibraryPanelTagName)) customElements.define(researchLibraryPanelTagName, PiWebResearchLibraryPanel);
}

class PiWebResearchLibraryPanel extends HTMLElement {
  private contextValue: WorkspacePanelContext | undefined;
  private selectedPaperId: string | undefined;
  private searchQuery = "";
  private scopeKind: ResearchDispatchIntent["scope"]["kind"] = "current-paper";
  private status: PanelStatus | undefined;
  private draftState: DraftState = { kind: "loading" };
  private annotationState: AnnotationState = { kind: "loading" };
  private annotationStatus: PanelStatus | undefined;
  private pendingSelection: ResearchPdfSelectionDetail | undefined;
  private draftKind: ResearchAnnotationKind = "question";
  private draftBody = "";
  private editingAnnotationId: string | undefined;
  private editBody = "";
  private activeAnnotationId: string | undefined;
  private annotationBusy = false;
  private loadToken = 0;
  private annotationToken = 0;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.addEventListener("click", (event) => { this.handleClick(event); });
    this.root.addEventListener("input", (event) => { this.handleInput(event); });
    this.root.addEventListener("change", (event) => { this.handleChange(event); });
    this.root.addEventListener(researchPdfSelectionEventName, (event) => { this.handleRegionSelected(event); });
    this.root.addEventListener(researchPdfAnnotationEventName, (event) => { this.handleMarkerActivated(event); });
  }

  set context(value: WorkspacePanelContext | undefined) {
    const previousKey = this.contextValue === undefined ? undefined : contextKey(this.contextValue);
    const nextKey = value === undefined ? undefined : contextKey(value);
    this.contextValue = value;
    if (previousKey === nextKey) return;
    this.selectedPaperId = undefined;
    this.searchQuery = "";
    this.status = undefined;
    this.draftState = { kind: "loading" };
    this.resetAnnotationEditing();
    this.render();
    if (value !== undefined) {
      void this.loadDrafts(value);
      void this.loadAnnotations(value);
    }
  }

  connectedCallback(): void {
    if (this.root.childNodes.length === 0) this.render();
  }

  private handleClick(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const refresh = target?.closest("button[data-refresh]");
    if (refresh !== null && refresh !== undefined) {
      void this.refresh();
      return;
    }
    const refreshDrafts = target?.closest("button[data-refresh-drafts]");
    if (refreshDrafts !== null && refreshDrafts !== undefined) {
      const context = this.contextValue;
      if (context !== undefined) void this.loadDrafts(context);
      return;
    }
    const paperButton = target?.closest("button[data-paper-id]");
    if (paperButton !== null && paperButton !== undefined) {
      this.selectedPaperId = paperButton.getAttribute("data-paper-id") ?? undefined;
      this.status = undefined;
      this.resetAnnotationEditing();
      this.annotationState = { kind: "loading" };
      this.render();
      const context = this.contextValue;
      if (context !== undefined) void this.loadAnnotations(context);
      return;
    }
    if (this.handleAnnotationClick(target)) return;
    const passageButton = target?.closest("button[data-passage-id]");
    if (passageButton !== null && passageButton !== undefined) {
      const passageId = passageButton.getAttribute("data-passage-id");
      if (passageId !== null) void this.dispatchPassage(passageId);
    }
  }

  private handleInput(event: Event): void {
    const field = event.target;
    if (field instanceof HTMLTextAreaElement) {
      if (field.matches("textarea[data-annotation-body]")) this.draftBody = field.value;
      if (field.matches("textarea[data-annotation-edit-body]")) this.editBody = field.value;
      return;
    }
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("input[data-paper-search]")) return;
    this.searchQuery = input.value;
    const context = this.contextValue;
    const state = context === undefined ? undefined : getOrLoadResearchLibrarySource(context);
    if (state?.kind === "loaded" && state.source.mode === "local-pilot" && this.updatePilotSearchResults(state.source.pilot.config)) return;
    this.render();
    const replacement = this.root.querySelector<HTMLInputElement>("input[data-paper-search]");
    replacement?.focus();
    replacement?.setSelectionRange(this.searchQuery.length, this.searchQuery.length);
  }

  private handleChange(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement)) return;
    if (select.matches("select[data-annotation-kind]")) {
      if (select.value === "question" || select.value === "note") this.draftKind = select.value;
      return;
    }
    if (!select.matches("select[data-search-scope]")) return;
    if (select.value === "current-paper" || select.value === "synthetic-library") this.scopeKind = select.value;
  }

  private async refresh(): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) return;
    this.status = { kind: "info", message: `Refreshing ${RESEARCH_LIBRARY_CONFIG_PATH} and ${RESEARCH_LIBRARY_PILOT_CONFIG_PATH}…` };
    this.render();
    const state = await refreshResearchLibrarySource(context);
    if (!this.isCurrentContext(context)) return;
    this.selectedPaperId = firstPaperId(state);
    this.status = state.kind === "loaded"
      ? { kind: "success", message: state.source.mode === "synthetic" ? "Synthetic research fixture refreshed." : "Read-only local pilot refreshed." }
      : undefined;
    this.resetAnnotationEditing();
    this.render();
    await this.loadDrafts(context);
    await this.loadAnnotations(context);
  }

  private async loadAnnotations(context: WorkspacePanelContext): Promise<void> {
    const scope = this.pilotScope(context);
    const token = ++this.annotationToken;
    if (scope === undefined) {
      this.annotationState = { kind: "loaded", annotations: [], warnings: [] };
      this.updateAnnotationsSection();
      return;
    }
    this.annotationState = { kind: "loading" };
    this.updateAnnotationsSection();
    const result = await loadPaperAnnotations(context.files, scope);
    if (!this.isCurrentContext(context) || token !== this.annotationToken) return;
    this.annotationState = result;
    this.updateAnnotationsSection();
  }

  /** The pilot library, paper, and PDF revision every annotation write binds to. */
  private pilotScope(context: WorkspacePanelContext): { libraryId: string; paperId: string; pdfSha256: string } | undefined {
    const state = getOrLoadResearchLibrarySource(context);
    if (state.kind !== "loaded" || state.source.mode !== "local-pilot") return undefined;
    const config = state.source.pilot.config;
    const paper = pilotPaperById(config, this.selectedPaperId ?? "") ?? config.papers[0];
    return paper === undefined ? undefined : { libraryId: config.libraryId, paperId: paper.id, pdfSha256: paper.pdf.sha256 };
  }

  private handleRegionSelected(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!isSelectionDetail(detail)) return;
    this.pendingSelection = detail;
    this.editingAnnotationId = undefined;
    this.annotationStatus = undefined;
    this.updateAnnotationsSection();
    this.root.querySelector<HTMLTextAreaElement>("textarea[data-annotation-body]")?.focus();
  }

  private handleMarkerActivated(event: Event): void {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (!isRecord(detail) || typeof detail["id"] !== "string") return;
    this.activeAnnotationId = detail["id"];
    this.updateAnnotationsSection();
  }

  private handleAnnotationClick(target: Element | null): boolean {
    const button = target?.closest("button[data-annotation-action]");
    if (button === null || button === undefined) return false;
    const id = button.getAttribute("data-annotation-id") ?? undefined;
    switch (button.getAttribute("data-annotation-action") ?? "") {
      case "save": void this.saveNewAnnotation(); return true;
      case "cancel": this.resetAnnotationEditing(); this.updateAnnotationsSection(); return true;
      case "show": this.showAnnotation(id); return true;
      case "edit": this.beginAnnotationEdit(id); return true;
      case "edit-save": void this.commitAnnotationEdit(id); return true;
      case "edit-cancel": this.editingAnnotationId = undefined; this.editBody = ""; this.updateAnnotationsSection(); return true;
      case "toggle-status": void this.toggleAnnotationStatus(id); return true;
      case "delete": void this.deleteAnnotation(id); return true;
      default: return false;
    }
  }

  private async saveNewAnnotation(): Promise<void> {
    const context = this.contextValue;
    const selection = this.pendingSelection;
    const scope = context === undefined ? undefined : this.pilotScope(context);
    if (context === undefined || selection === undefined || scope === undefined) return;
    const body = this.draftBody.trim();
    if (body === "") {
      this.annotationStatus = { kind: "error", message: "Write the question or note before saving this region." };
      this.updateAnnotationsSection();
      return;
    }
    await this.runAnnotationWrite(context, async () => {
      const created = await createPaperAnnotation(context.files, {
        ...scope,
        page: selection.page,
        rect: selection.rect,
        quote: selection.quote,
        kind: this.draftKind,
        body,
      });
      this.pendingSelection = undefined;
      this.draftBody = "";
      this.activeAnnotationId = created.id;
      return `Saved ${created.kind === "question" ? "question" : "note"} on page ${String(created.page)}.`;
    });
  }

  private beginAnnotationEdit(id: string | undefined): void {
    const annotation = this.annotationById(id);
    if (annotation === undefined) return;
    this.editingAnnotationId = annotation.id;
    this.editBody = annotation.body;
    this.activeAnnotationId = annotation.id;
    this.annotationStatus = undefined;
    this.updateAnnotationsSection();
    this.root.querySelector<HTMLTextAreaElement>("textarea[data-annotation-edit-body]")?.focus();
  }

  private async commitAnnotationEdit(id: string | undefined): Promise<void> {
    const context = this.contextValue;
    const annotation = this.annotationById(id);
    if (context === undefined || annotation === undefined) return;
    const body = this.editBody.trim();
    if (body === "") {
      this.annotationStatus = { kind: "error", message: "An annotation cannot be emptied. Delete it instead." };
      this.updateAnnotationsSection();
      return;
    }
    await this.runAnnotationWrite(context, async () => {
      await saveAnnotationChanges(context.files, annotation, { body });
      this.editingAnnotationId = undefined;
      this.editBody = "";
      return "Annotation updated.";
    });
  }

  private async toggleAnnotationStatus(id: string | undefined): Promise<void> {
    const context = this.contextValue;
    const annotation = this.annotationById(id);
    if (context === undefined || annotation === undefined) return;
    const status = annotation.status === "open" ? "resolved" : "open";
    await this.runAnnotationWrite(context, async () => {
      await saveAnnotationChanges(context.files, annotation, { status });
      return status === "resolved" ? "Marked resolved." : "Reopened.";
    });
  }

  private async deleteAnnotation(id: string | undefined): Promise<void> {
    const context = this.contextValue;
    const annotation = this.annotationById(id);
    if (context === undefined || annotation === undefined) return;
    if (!window.confirm(`Delete this ${annotation.kind} on page ${String(annotation.page)}? The PDF and source note are not changed.`)) return;
    await this.runAnnotationWrite(context, async () => {
      await deleteAnnotationRecord(context.files, annotation);
      if (this.activeAnnotationId === annotation.id) this.activeAnnotationId = undefined;
      if (this.editingAnnotationId === annotation.id) this.editingAnnotationId = undefined;
      return "Annotation deleted.";
    });
  }

  /** Run one annotation write, then reload the durable list it changed. */
  private async runAnnotationWrite(context: WorkspacePanelContext, operation: () => Promise<string>): Promise<void> {
    if (this.annotationBusy) return;
    this.annotationBusy = true;
    this.annotationStatus = undefined;
    this.updateAnnotationsSection();
    let status: PanelStatus;
    try {
      status = { kind: "success", message: await operation() };
    } catch (error) {
      status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    this.annotationBusy = false;
    if (!this.isCurrentContext(context)) return;
    this.annotationStatus = status;
    await this.loadAnnotations(context);
  }

  private showAnnotation(id: string | undefined): void {
    const annotation = this.annotationById(id);
    if (annotation === undefined) return;
    this.activeAnnotationId = annotation.id;
    this.root.querySelector<ResearchLibraryPdfViewerElement>(researchLibraryPdfViewerTagName)?.showPage(annotation.page);
    this.updateAnnotationsSection();
  }

  private annotationById(id: string | undefined): ResearchAnnotation | undefined {
    if (id === undefined || this.annotationState.kind !== "loaded") return undefined;
    return this.annotationState.annotations.find((annotation) => annotation.id === id);
  }

  private resetAnnotationEditing(): void {
    this.pendingSelection = undefined;
    this.draftBody = "";
    this.draftKind = "question";
    this.editingAnnotationId = undefined;
    this.editBody = "";
    this.annotationStatus = undefined;
    this.activeAnnotationId = undefined;
  }

  private async loadDrafts(context: WorkspacePanelContext): Promise<void> {
    const state = getOrLoadResearchLibrarySource(context);
    if (state.kind !== "loaded" || state.source.mode !== "synthetic") return;
    const token = ++this.loadToken;
    this.draftState = { kind: "loading" };
    this.render();
    const drafts = await loadSyntheticAnswerDrafts(context.files, state.source.fixture.config.libraryId);
    if (!this.isCurrentContext(context) || token !== this.loadToken) return;
    this.draftState = drafts;
    this.render();
  }

  private async dispatchPassage(passageId: string): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) return;
    const state = getOrLoadResearchLibrarySource(context);
    if (state.kind !== "loaded" || state.source.mode !== "synthetic") return;
    const fixture = state.source.fixture;
    const paperId = this.selectedPaperId ?? fixture.config.papers[0]?.id;
    if (paperId === undefined) return;
    const paper = paperById(fixture.config, paperId);
    const passage = paper?.passages.find((candidate) => candidate.id === passageId);
    if (paper === undefined || passage === undefined) {
      this.status = { kind: "error", message: "That synthetic passage is no longer available. Refresh and try again." };
      this.render();
      return;
    }
    if (!window.confirm(`Send this synthetic question to the active Pi prompt?\n\n${passage.question}`)) return;

    this.status = { kind: "info", message: "Creating a bounded synthetic dispatch intent…" };
    this.render();
    try {
      const dispatch = await prepareResearchDispatch({ fixture, paperId, passageId, scopeKind: this.scopeKind }, {
        files: context.files,
        prompt: context.prompt,
      });
      if (!this.isCurrentContext(context)) return;
      this.status = { kind: "success", message: `Inserted only the opaque token into the active prompt. Review and send it before ${new Date(dispatch.expiresAt).toLocaleTimeString()}.` };
    } catch (error) {
      if (!this.isCurrentContext(context)) return;
      this.status = { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }

  private render(): void {
    const context = this.contextValue;
    if (context === undefined) {
      this.root.innerHTML = `${styles()}<section class="empty">Select a workspace.</section>`;
      return;
    }
    const state = getOrLoadResearchLibrarySource(context);
    const subtitle = state.kind === "loaded" && state.source.mode === "local-pilot" ? "Read-only local pilot" : "Synthetic contract preview";
    this.root.innerHTML = `
      ${styles()}
      <section class="toolbar">
        <div><strong>Research Library</strong><small>${escapeHtml(subtitle)}</small></div>
        <button class="secondary" data-refresh ${state.kind === "loading" ? "disabled" : ""}>Refresh</button>
      </section>
      ${this.renderStatus()}
      <section class="viewer">${this.renderSourceState(state, context)}</section>
    `;
    this.bindPilotPdfViewer(state, context);
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    const semantics = this.status.kind === "error" ? `role="alert"` : `role="status" aria-live="polite"`;
    return `<div class="status ${escapeAttr(this.status.kind)}" ${semantics}>${escapeHtml(this.status.message)}</div>`;
  }

  private renderSourceState(state: ResearchLibrarySourceState, context: WorkspacePanelContext): string {
    if (state.kind === "loading") return `<p class="muted" role="status" aria-live="polite">Checking ${escapeHtml(RESEARCH_LIBRARY_CONFIG_PATH)} and ${escapeHtml(RESEARCH_LIBRARY_PILOT_CONFIG_PATH)}…</p>`;
    if (state.kind === "missing") return `<div class="empty-state" role="status" aria-live="polite"><strong>No research preview source.</strong><p>Create either ${escapeHtml(RESEARCH_LIBRARY_CONFIG_PATH)} or ${escapeHtml(RESEARCH_LIBRARY_PILOT_CONFIG_PATH)}.</p></div>`;
    if (state.kind === "unavailable") return `<div class="status error" role="alert"><strong>Research source unavailable.</strong><p class="pre-wrap">${escapeHtml(state.error)}</p></div>`;
    return state.source.mode === "synthetic"
      ? this.renderSyntheticFixture(state.source.fixture.config)
      : this.renderPilot(state.source.pilot.config, context);
  }

  private renderSyntheticFixture(config: SyntheticResearchLibraryConfig): string {
    const papers = filteredSyntheticPapers(config.papers, this.searchQuery);
    const selected = paperById(config, this.selectedPaperId ?? "") ?? papers[0] ?? config.papers[0];
    this.selectedPaperId = selected?.id;
    return `
      <div class="safety-note"><strong>Synthetic only.</strong> This preview has no network, real-PDF, import, or external-library access.</div>
      <label class="search-label">Search synthetic papers
        <input type="search" data-paper-search value="${escapeAttr(this.searchQuery)}" placeholder="Title, author, tag, collection">
      </label>
      <div class="library-layout">
        <nav class="paper-list" aria-label="Synthetic papers">
          ${papers.length === 0 ? renderNoMatchingPapers() : papers.map((paper) => renderSyntheticPaperButton(paper, paper.id === selected?.id)).join("")}
        </nav>
        <section class="paper-detail">${selected === undefined ? `<p class="muted">Select a paper.</p>` : this.renderSyntheticPaper(config, selected)}</section>
      </div>
      ${this.renderDrafts()}
    `;
  }

  private renderSyntheticPaper(config: SyntheticResearchLibraryConfig, paper: SyntheticPaper): string {
    const citedPapers = paper.cites.map((id) => paperById(config, id)).filter((candidate): candidate is SyntheticPaper => candidate !== undefined);
    const backlinks = citedByPaperIds(config, paper.id).map((id) => paperById(config, id)).filter((candidate): candidate is SyntheticPaper => candidate !== undefined);
    return `
      <header class="paper-header">
        <h2>${escapeHtml(paper.title)}</h2>
        <p>${escapeHtml(paper.authors.join(", "))}${paper.year === undefined ? "" : ` · ${String(paper.year)}`}</p>
      </header>
      ${paper.abstract === undefined ? "" : `<p>${escapeHtml(paper.abstract)}</p>`}
      ${renderChips("Tags", paper.tags)}
      ${renderChips("Collections", paper.collections)}
      <section class="connections"><h3>Citation graph preview</h3>${renderConnections("Cites", citedPapers)}${renderConnections("Cited by", backlinks)}</section>
      <section class="passages">
        <div class="section-heading"><h3>Marked synthetic questions</h3>
          <label>Agent search scope
            <select data-search-scope>
              <option value="current-paper" ${this.scopeKind === "current-paper" ? "selected" : ""}>Current paper</option>
              <option value="synthetic-library" ${this.scopeKind === "synthetic-library" ? "selected" : ""}>Entire synthetic fixture</option>
            </select>
          </label>
        </div>
        ${paper.passages.length === 0 ? `<p class="muted">No marked passages.</p>` : paper.passages.map((passage) => `
          <article class="passage-card">
            <span class="locator">Page ${String(passage.page)}</span>
            <blockquote>${escapeHtml(passage.quote)}</blockquote>
            <strong>${escapeHtml(passage.question)}</strong>
            <button data-passage-id="${escapeAttr(passage.id)}">Send token to active agent</button>
          </article>
        `).join("")}
      </section>
      <p class="muted">Actual PDF streaming/rendering is intentionally deferred for the synthetic fixture.</p>
    `;
  }

  private renderPilot(config: LocalResearchLibraryPilotConfig, context: WorkspacePanelContext): string {
    const papers = filteredPilotPapers(config.papers, this.searchQuery);
    const selected = papers.find((paper) => paper.id === this.selectedPaperId) ?? papers[0];
    this.selectedPaperId = selected?.id;
    return `
      <div class="safety-note"><strong>Read-only local pilot.</strong> Source notes and PDFs are displayed without modification. Agent dispatch is disabled pending disclosure approval. Digests, sizes, provenance, and source URLs are manifest-declared; the panel does not rehash note/PDF bytes or verify URL ownership at display time.</div>
      <label class="search-label">Search pilot papers
        <input type="search" data-paper-search value="${escapeAttr(this.searchQuery)}" placeholder="Title, author, bibkey, topic, meta category">
      </label>
      <div class="library-layout pilot-layout">
        <nav class="paper-list" aria-label="Local pilot papers">
          ${renderPilotPaperList(papers, selected?.id)}
        </nav>
        <section class="paper-detail">${selected === undefined ? `<p class="muted">Select a paper.</p>` : this.renderPilotPaper(selected, context)}</section>
      </div>
    `;
  }

  private renderPilotPaper(paper: LocalPilotPaper, context: WorkspacePanelContext): string {
    const pdf = paper.pdf;
    const viewer = context.files.pdfPreviewUrl === undefined
      ? `<div class="status error compatibility-error" role="alert">This PI WEB host does not expose the bounded pdfPreviewUrl helper. Update the selected machine before opening pilot PDFs.</div>`
      : `<${researchLibraryPdfViewerTagName} data-pilot-pdf-viewer></${researchLibraryPdfViewerTagName}>`;
    return `
      <header class="paper-header">
        <h2>${escapeHtml(paper.title)}</h2>
        <p>${escapeHtml(paper.authors.join(", "))}${paper.year === undefined ? "" : ` · ${String(paper.year)}`} · ${escapeHtml(paper.bibkey)}</p>
      </header>
      ${paper.abstract === undefined ? "" : `<p>${escapeHtml(paper.abstract)}</p>`}
      ${renderChips("Related topics", paper.relatedTopics)}
      ${renderChips("Meta categories", paper.metaCategories)}
      <section class="provenance">
        <h3>Manifest-declared wiki binding</h3>
        <dl>
          <dt>Source note</dt><dd>${escapeHtml(paper.sourceNotePath)}</dd>
          <dt>Declared note SHA-256</dt><dd><code class="digest">${escapeHtml(paper.sourceNoteSha256)}</code></dd>
          <dt>Used By</dt><dd>${paper.usedBy.length === 0 ? `<span class="muted">none recorded</span>` : `<ul>${paper.usedBy.map((path) => `<li>${escapeHtml(path)}</li>`).join("")}</ul>`}</dd>
        </dl>
      </section>
      <section class="provenance">
        <h3>Manifest-declared PDF provenance</h3>
        <dl>
          <dt>Path</dt><dd>${escapeHtml(pdf.path)}</dd>
          <dt>Declared SHA-256</dt><dd><code class="digest">${escapeHtml(pdf.sha256)}</code></dd>
          <dt>Declared size</dt><dd>${escapeHtml(formatBytes(pdf.size))}</dd>
          <dt>Declared retrieval time</dt><dd>${escapeHtml(pdf.retrievedAt)}</dd>
          <dt>Declared rights</dt><dd>${escapeHtml(pdf.rights)}</dd>
          <dt>Declared PDF source URL</dt><dd class="url-text">${escapeHtml(pdf.sourceUrl)}</dd>
          <dt>Declared source-page URL</dt><dd class="url-text">${escapeHtml(pdf.sourcePageUrl)}</dd>
        </dl>
      </section>
      <section class="pdf-section"><h3>PDF reader</h3><div data-pdf-reader-host>${viewer}</div></section>
      <section class="annotations" data-annotations-host>${this.renderAnnotationsInner()}</section>
      <div class="safety-note"><strong>Agent tools disabled for this pilot.</strong> No prompt insertion, runtime intent, answer queue, or search-budget operation is available for real papers.</div>
    `;
  }

  private renderAnnotationsInner(): string {
    const state = this.annotationState;
    const pending = this.pendingSelection;
    const status = this.annotationStatus === undefined
      ? ""
      : `<div class="status ${escapeAttr(this.annotationStatus.kind)}" ${this.annotationStatus.kind === "error" ? `role="alert"` : `role="status" aria-live="polite"`}>${escapeHtml(this.annotationStatus.message)}</div>`;
    const body = state.kind === "loading"
      ? `<p class="muted" role="status" aria-live="polite">Loading annotations…</p>`
      : state.kind === "unavailable"
        ? `<div class="status error" role="alert">${escapeHtml(state.error)}</div>`
        : this.renderAnnotationList(state.annotations, state.warnings);
    return `
      <div class="section-heading">
        <h3>Marked questions and notes</h3>
        <span class="muted">${escapeHtml(annotationCountLabel(state))}</span>
      </div>
      <p class="muted">Choose <strong>Mark region</strong> in the reader, then drag across a passage. Records are stored under <code>${escapeHtml(RESEARCH_ANNOTATIONS_ROOT)}</code>; the PDF and its source note are never changed.</p>
      ${status}
      ${pending === undefined ? "" : this.renderPendingSelection(pending)}
      ${body}
    `;
  }

  private renderPendingSelection(selection: ResearchPdfSelectionDetail): string {
    return `
      <form class="annotation-form" data-annotation-form>
        <div class="section-heading"><strong>New annotation · page ${String(selection.page)}</strong></div>
        ${selection.quote === ""
          ? `<p class="muted">No text was found in that region; the marked area is still recorded.</p>`
          : `<blockquote>${escapeHtml(selection.quote)}</blockquote>`}
        <label>Kind
          <select data-annotation-kind>
            <option value="question" ${this.draftKind === "question" ? "selected" : ""}>Question</option>
            <option value="note" ${this.draftKind === "note" ? "selected" : ""}>Note</option>
          </select>
        </label>
        <label>Text
          <textarea data-annotation-body rows="3" maxlength="${String(MAX_RESEARCH_ANNOTATION_BODY)}" placeholder="What do you want to ask or remember about this passage?">${escapeHtml(this.draftBody)}</textarea>
        </label>
        <div class="annotation-actions">
          <button type="button" data-annotation-action="save" ${this.annotationBusy ? "disabled" : ""}>Save annotation</button>
          <button type="button" class="secondary" data-annotation-action="cancel" ${this.annotationBusy ? "disabled" : ""}>Discard region</button>
        </div>
      </form>
    `;
  }

  private renderAnnotationList(annotations: ResearchAnnotation[], warnings: string[]): string {
    const skipped = warnings.length === 0 ? "" : `<div class="status error">Ignored ${String(warnings.length)} unreadable annotation file(s).</div>`;
    if (annotations.length === 0) return `${skipped}<p class="muted">No annotations yet for this paper.</p>`;
    return `${skipped}${annotations.map((annotation) => this.renderAnnotationCard(annotation)).join("")}`;
  }

  private renderAnnotationCard(annotation: ResearchAnnotation): string {
    const editing = this.editingAnnotationId === annotation.id;
    const busy = this.annotationBusy ? "disabled" : "";
    const action = (name: string, label: string, extraClass = "secondary"): string =>
      `<button type="button" class="${extraClass}" data-annotation-action="${name}" data-annotation-id="${escapeAttr(annotation.id)}" ${busy}>${escapeHtml(label)}</button>`;
    return `
      <article class="annotation-card${annotation.id === this.activeAnnotationId ? " selected" : ""}" data-annotation-card="${escapeAttr(annotation.id)}">
        <span class="locator">${escapeHtml(annotation.kind === "question" ? "Question" : "Note")} · page ${String(annotation.page)} · ${escapeHtml(annotation.status)}</span>
        ${annotation.quote === "" ? "" : `<blockquote>${escapeHtml(annotation.quote)}</blockquote>`}
        ${editing
          ? `<label>Text<textarea data-annotation-edit-body rows="3" maxlength="${String(MAX_RESEARCH_ANNOTATION_BODY)}">${escapeHtml(this.editBody)}</textarea></label>`
          : `<p class="annotation-body">${escapeHtml(annotation.body)}</p>`}
        <div class="annotation-actions">
          ${action("show", "Show on page")}
          ${editing ? action("edit-save", "Save", "") : action("edit", "Edit")}
          ${editing ? action("edit-cancel", "Cancel") : action("toggle-status", annotation.status === "open" ? "Mark resolved" : "Reopen")}
          ${editing ? "" : action("delete", "Delete")}
        </div>
      </article>
    `;
  }

  /** Patch only the annotation section so the mounted PDF is never reloaded. */
  private updateAnnotationsSection(): void {
    const host = this.root.querySelector<HTMLElement>("[data-annotations-host]");
    if (host !== null) host.innerHTML = this.renderAnnotationsInner();
    this.updateViewerMarkers();
  }

  private updateViewerMarkers(): void {
    const viewer = this.root.querySelector<ResearchLibraryPdfViewerElement>(researchLibraryPdfViewerTagName);
    if (viewer === null) return;
    viewer.annotations = this.annotationState.kind === "loaded"
      ? this.annotationState.annotations.map((annotation) => ({
        id: annotation.id,
        page: annotation.page,
        rect: annotation.rect,
        kind: annotation.kind,
        status: annotation.status,
        label: annotation.body,
      }))
      : [];
    viewer.activeAnnotationId = this.activeAnnotationId;
  }

  private bindPilotPdfViewer(state: ResearchLibrarySourceState, context: WorkspacePanelContext): void {
    if (state.kind !== "loaded" || state.source.mode !== "local-pilot" || context.files.pdfPreviewUrl === undefined) return;
    const config = state.source.pilot.config;
    const paper = pilotPaperById(config, this.selectedPaperId ?? "") ?? config.papers[0];
    if (paper === undefined) return;
    const viewer = this.root.querySelector<ResearchLibraryPdfViewerElement>(researchLibraryPdfViewerTagName);
    if (viewer === null) return;
    this.updateViewerMarkers();
    try {
      viewer.sourceUrl = context.files.pdfPreviewUrl(paper.pdf.path, { modifiedAt: paper.pdf.sha256 });
    } catch (error) {
      const host = viewer.closest<HTMLElement>("[data-pdf-reader-host]");
      if (host === null) return;
      const message = document.createElement("div");
      message.className = "status error compatibility-error";
      message.setAttribute("role", "alert");
      message.textContent = `Unable to create PDF preview URL: ${error instanceof Error ? error.message : String(error)}`;
      host.replaceChildren(message);
    }
  }

  private updatePilotSearchResults(config: LocalResearchLibraryPilotConfig): boolean {
    const papers = filteredPilotPapers(config.papers, this.searchQuery);
    const selected = pilotPaperById(config, this.selectedPaperId ?? "");
    const selectedStillMatches = selected !== undefined && papers.some((paper) => paper.id === selected.id);
    if (papers.length > 0 && !selectedStillMatches) {
      this.selectedPaperId = papers[0]?.id;
      return false;
    }

    const list = this.root.querySelector<HTMLElement>("nav.paper-list");
    if (list === null) return false;
    list.innerHTML = renderPilotPaperList(papers, selected?.id);
    return true;
  }

  private renderDrafts(): string {
    const state = this.draftState;
    if (state.kind === "loading") return `<section class="drafts"><h3>Answer queue</h3><p class="muted" role="status" aria-live="polite">Loading synthetic drafts…</p></section>`;
    if (state.kind === "unavailable") return `<section class="drafts"><h3>Answer queue</h3><div class="status error" role="alert">${escapeHtml(state.error)}</div></section>`;
    return `
      <section class="drafts">
        <div class="section-heading"><h3>Answer queue</h3><button class="secondary" data-refresh-drafts>Refresh drafts</button></div>
        ${state.warnings.length === 0 ? "" : `<div class="status error">Ignored ${String(state.warnings.length)} invalid draft file(s).</div>`}
        ${state.drafts.length === 0 ? `<p class="muted">No synthetic answer drafts yet.</p>` : state.drafts.map(renderDraft).join("")}
      </section>
    `;
  }

  private isCurrentContext(context: WorkspacePanelContext): boolean {
    return this.contextValue !== undefined && contextKey(this.contextValue) === contextKey(context);
  }
}

function firstPaperId(state: ResearchLibrarySourceState): string | undefined {
  if (state.kind !== "loaded") return undefined;
  return state.source.mode === "synthetic" ? state.source.fixture.config.papers[0]?.id : state.source.pilot.config.papers[0]?.id;
}

function filteredSyntheticPapers(papers: SyntheticPaper[], query: string): SyntheticPaper[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return papers;
  return papers.filter((paper) => [paper.title, ...paper.authors, ...paper.tags, ...paper.collections]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}

function filteredPilotPapers(papers: LocalPilotPaper[], query: string): LocalPilotPaper[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return papers;
  return papers.filter((paper) => [paper.title, paper.bibkey, ...paper.authors, ...paper.relatedTopics, ...paper.metaCategories]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}

function renderSyntheticPaperButton(paper: SyntheticPaper, selected: boolean): string {
  return `<button class="paper-button ${selected ? "selected" : ""}" data-paper-id="${escapeAttr(paper.id)}" aria-pressed="${selected ? "true" : "false"}"><strong>${escapeHtml(paper.title)}</strong><span>${escapeHtml(paper.authors.join(", "))}</span></button>`;
}

function renderPilotPaperList(papers: LocalPilotPaper[], selectedPaperId: string | undefined): string {
  return papers.length === 0
    ? renderNoMatchingPapers()
    : papers.map((paper) => renderPilotPaperButton(paper, paper.id === selectedPaperId)).join("");
}

function renderPilotPaperButton(paper: LocalPilotPaper, selected: boolean): string {
  return `<button class="paper-button ${selected ? "selected" : ""}" data-paper-id="${escapeAttr(paper.id)}" aria-pressed="${selected ? "true" : "false"}"><strong>${escapeHtml(paper.title)}</strong><span>${escapeHtml(paper.bibkey)} · ${escapeHtml(paper.authors.join(", "))}</span></button>`;
}

function renderNoMatchingPapers(): string {
  return `<p class="muted" role="status" aria-live="polite">No matching papers.</p>`;
}

function renderChips(label: string, values: string[]): string {
  if (values.length === 0) return "";
  return `<div class="chips"><span>${escapeHtml(label)}</span>${values.map((value) => `<code>${escapeHtml(value)}</code>`).join("")}</div>`;
}

function renderConnections(label: string, papers: SyntheticPaper[]): string {
  return `<div><strong>${escapeHtml(label)}:</strong> ${papers.length === 0 ? `<span class="muted">none</span>` : papers.map((paper) => `<span class="connection">${escapeHtml(paper.title)}</span>`).join("")}</div>`;
}

function renderDraft(draft: SyntheticAnswerDraft): string {
  return `<article class="draft-card"><span class="locator">Draft · ${escapeHtml(new Date(draft.createdAt).toLocaleString())}</span><strong>${escapeHtml(draft.question)}</strong><p>${escapeHtml(draft.answer)}</p><small>${String(draft.evidenceIds.length)} evidence reference(s)</small></article>`;
}

function annotationCountLabel(state: AnnotationState): string {
  if (state.kind !== "loaded") return "";
  const open = state.annotations.filter((annotation) => annotation.status === "open").length;
  return `${String(state.annotations.length)} total · ${String(open)} open`;
}

function isSelectionDetail(value: unknown): value is ResearchPdfSelectionDetail {
  if (!isRecord(value) || typeof value["quote"] !== "string") return false;
  const page = value["page"];
  if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) return false;
  const rect = value["rect"];
  if (!isRecord(rect)) return false;
  return ["x", "y", "width", "height"].every((key) => {
    const candidate = rect[key];
    return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 && candidate <= 1;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function contextKey(context: WorkspacePanelContext): string {
  return `${context.machine.id}:${context.workspace.projectId}:${context.workspace.id}`;
}

function styles(): string {
  return `<style>
    :host { display: contents; }
    * { box-sizing: border-box; }
    .toolbar, .section-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .toolbar { padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .toolbar div { display: grid; gap: 2px; }
    .toolbar small, .muted, .paper-button span, .paper-header p, .draft-card small { color: var(--pi-muted); }
    .viewer { min-height: 0; overflow: auto; padding: 12px; }
    .safety-note, .status, .empty-state { border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px; }
    .safety-note { margin-bottom: 12px; border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
    .status { margin: 12px; }
    .paper-detail .status { margin: 0; }
    .status.success { color: var(--pi-success); border-color: var(--pi-success-border); background: var(--pi-success-surface); }
    .status.error { color: var(--pi-danger); border-color: var(--pi-danger); }
    .status.info { border-color: var(--pi-accent-border); }
    .pre-wrap { white-space: pre-wrap; }
    .search-label { display: grid; gap: 5px; margin-bottom: 12px; font-size: 12px; color: var(--pi-text-secondary); }
    input, select { min-width: 0; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 7px; font: inherit; }
    .library-layout { display: grid; grid-template-columns: minmax(150px, 0.38fr) minmax(0, 1fr); gap: 12px; }
    .paper-list { display: grid; align-content: start; gap: 7px; }
    .pilot-layout { grid-template-columns: minmax(0, 1fr); }
    .pilot-layout .paper-list { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
    .paper-button { display: grid; gap: 3px; width: 100%; min-width: 0; overflow-wrap: anywhere; text-align: left; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 9px; cursor: pointer; }
    .paper-button.selected { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
    .paper-detail { min-width: 0; }
    .paper-header h2 { margin: 0; font-size: 18px; }
    .paper-header p { margin: 4px 0 12px; }
    .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 8px 0; }
    .chips > span { color: var(--pi-muted); font-size: 12px; }
    code, .connection { border: 1px solid var(--pi-border-muted); border-radius: 999px; padding: 2px 6px; font-size: 11px; }
    code.digest { overflow-wrap: anywhere; border-radius: 4px; }
    .connections, .passages, .drafts, .provenance, .pdf-section { display: grid; gap: 9px; margin-top: 18px; }
    h3 { margin: 0; font-size: 14px; }
    .connections > div { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
    .passage-card, .draft-card, .provenance { border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-surface); padding: 10px; }
    .passage-card, .draft-card { display: grid; gap: 8px; }
    .annotations { scroll-margin-top: 8px; }
    .annotation-form, .annotation-card { display: grid; gap: 8px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-surface); padding: 10px; }
    .annotation-card.selected { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
    .annotation-body { margin: 0; white-space: pre-wrap; }
    .annotation-form label, .annotation-card label { display: grid; gap: 4px; font-size: 12px; color: var(--pi-text-secondary); }
    textarea { min-width: 0; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 7px; font: inherit; resize: vertical; }
    .annotation-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    dl { display: grid; grid-template-columns: minmax(95px, .25fr) minmax(0, 1fr); gap: 6px 10px; margin: 0; }
    dt { color: var(--pi-muted); font-size: 12px; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    dd ul { margin: 0; padding-left: 18px; }
    .url-text { font-family: ui-monospace, monospace; font-size: 11px; }
    blockquote { margin: 0; border-left: 3px solid var(--pi-accent-border); padding-left: 9px; color: var(--pi-text-secondary); white-space: pre-wrap; }
    .locator { color: var(--pi-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
    button { border: 1px solid var(--pi-accent-border); border-radius: 7px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; padding: 6px 9px; font: inherit; }
    button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
    button:disabled { cursor: wait; opacity: .65; }
    @media (max-width: 760px) { .library-layout { grid-template-columns: 1fr; } }
  </style>`;
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
