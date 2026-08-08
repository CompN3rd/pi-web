import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { citedByPaperIds, paperById, RESEARCH_LIBRARY_CONFIG_PATH, type SyntheticPaper, type SyntheticResearchLibraryConfig } from "./config.js";
import { loadSyntheticAnswerDrafts, type SyntheticAnswerDraft, type SyntheticDraftsLoadResult } from "./draftsClient.js";
import { getOrLoadResearchLibraryFixture, refreshResearchLibraryFixture, type ResearchLibraryFixtureState } from "./fixtureCache.js";
import { prepareResearchDispatch, type ResearchDispatchIntent } from "./researchLibraryClient.js";

export const researchLibraryPanelTagName = "pi-web-research-library-panel";

interface PanelStatus { kind: "info" | "success" | "error"; message: string }
type DraftState = { kind: "loading" } | SyntheticDraftsLoadResult;

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
  private loadToken = 0;
  private readonly root: ShadowRoot;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.root.addEventListener("click", (event) => { this.handleClick(event); });
    this.root.addEventListener("input", (event) => { this.handleInput(event); });
    this.root.addEventListener("change", (event) => { this.handleChange(event); });
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
    this.render();
    if (value !== undefined) void this.loadDrafts(value);
  }

  connectedCallback(): void {
    this.render();
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
      this.render();
      return;
    }
    const passageButton = target?.closest("button[data-passage-id]");
    if (passageButton !== null && passageButton !== undefined) {
      const passageId = passageButton.getAttribute("data-passage-id");
      if (passageId !== null) void this.dispatchPassage(passageId);
    }
  }

  private handleInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.matches("input[data-paper-search]")) return;
    this.searchQuery = input.value;
    this.render();
    const replacement = this.root.querySelector<HTMLInputElement>("input[data-paper-search]");
    replacement?.focus();
    replacement?.setSelectionRange(this.searchQuery.length, this.searchQuery.length);
  }

  private handleChange(event: Event): void {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.matches("select[data-search-scope]")) return;
    if (select.value === "current-paper" || select.value === "synthetic-library") this.scopeKind = select.value;
  }

  private async refresh(): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) return;
    this.status = { kind: "info", message: `Refreshing ${RESEARCH_LIBRARY_CONFIG_PATH}…` };
    this.render();
    const state = await refreshResearchLibraryFixture(context);
    if (!this.isCurrentContext(context)) return;
    this.selectedPaperId = state.kind === "loaded" ? state.fixture.config.papers[0]?.id : undefined;
    this.status = state.kind === "loaded" ? { kind: "success", message: "Synthetic research fixture refreshed." } : undefined;
    this.render();
    await this.loadDrafts(context);
  }

  private async loadDrafts(context: WorkspacePanelContext): Promise<void> {
    const token = ++this.loadToken;
    this.draftState = { kind: "loading" };
    this.render();
    const state = getOrLoadResearchLibraryFixture(context);
    if (state.kind !== "loaded") return;
    const drafts = await loadSyntheticAnswerDrafts(context.files, state.fixture.config.libraryId);
    if (!this.isCurrentContext(context) || token !== this.loadToken) return;
    this.draftState = drafts;
    this.render();
  }

  private async dispatchPassage(passageId: string): Promise<void> {
    const context = this.contextValue;
    if (context === undefined) return;
    const state = getOrLoadResearchLibraryFixture(context);
    if (state.kind !== "loaded") return;
    const paperId = this.selectedPaperId ?? state.fixture.config.papers[0]?.id;
    if (paperId === undefined) return;
    const paper = paperById(state.fixture.config, paperId);
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
      const dispatch = await prepareResearchDispatch({ fixture: state.fixture, paperId, passageId, scopeKind: this.scopeKind }, {
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
    const state = getOrLoadResearchLibraryFixture(context);
    this.root.innerHTML = `
      ${styles()}
      <section class="toolbar">
        <div><strong>Research Library</strong><small>Synthetic contract preview</small></div>
        <button class="secondary" data-refresh ${state.kind === "loading" ? "disabled" : ""}>Refresh</button>
      </section>
      ${this.renderStatus()}
      <section class="viewer">${this.renderFixtureState(state)}</section>
    `;
  }

  private renderStatus(): string {
    if (this.status === undefined) return "";
    return `<div class="status ${escapeAttr(this.status.kind)}">${escapeHtml(this.status.message)}</div>`;
  }

  private renderFixtureState(state: ResearchLibraryFixtureState): string {
    if (state.kind === "loading") return `<p class="muted">Loading ${escapeHtml(RESEARCH_LIBRARY_CONFIG_PATH)}…</p>`;
    if (state.kind === "missing") return `<div class="empty-state"><strong>No synthetic research fixture.</strong><p>Create ${escapeHtml(RESEARCH_LIBRARY_CONFIG_PATH)} to enable this workspace-only preview.</p></div>`;
    if (state.kind === "unavailable") return `<div class="status error"><strong>Fixture unavailable.</strong><p>${escapeHtml(state.error)}</p></div>`;

    const config = state.fixture.config;
    const papers = filteredPapers(config.papers, this.searchQuery);
    const selected = paperById(config, this.selectedPaperId ?? "") ?? papers[0] ?? config.papers[0];
    this.selectedPaperId = selected?.id;
    return `
      <div class="safety-note"><strong>Synthetic only.</strong> This preview has no network, real-PDF, import, or external-library access.</div>
      <label class="search-label">Search synthetic papers
        <input type="search" data-paper-search value="${escapeAttr(this.searchQuery)}" placeholder="Title, author, tag, collection">
      </label>
      <div class="library-layout">
        <nav class="paper-list" aria-label="Synthetic papers">
          ${papers.length === 0 ? `<p class="muted">No matching papers.</p>` : papers.map((paper) => renderPaperButton(paper, paper.id === selected?.id)).join("")}
        </nav>
        <section class="paper-detail">${selected === undefined ? `<p class="muted">Select a paper.</p>` : this.renderPaper(config, selected)}</section>
      </div>
      ${this.renderDrafts()}
    `;
  }

  private renderPaper(config: SyntheticResearchLibraryConfig, paper: SyntheticPaper): string {
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
      <p class="muted">Actual PDF streaming/rendering is intentionally deferred until PI WEB has an approved bounded viewer transport.</p>
    `;
  }

  private renderDrafts(): string {
    const state = this.draftState;
    if (state.kind === "loading") return `<section class="drafts"><h3>Answer queue</h3><p class="muted">Loading synthetic drafts…</p></section>`;
    if (state.kind === "unavailable") return `<section class="drafts"><h3>Answer queue</h3><div class="status error">${escapeHtml(state.error)}</div></section>`;
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

function filteredPapers(papers: SyntheticPaper[], query: string): SyntheticPaper[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (normalized === "") return papers;
  return papers.filter((paper) => [paper.title, ...paper.authors, ...paper.tags, ...paper.collections]
    .some((value) => value.toLocaleLowerCase().includes(normalized)));
}

function renderPaperButton(paper: SyntheticPaper, selected: boolean): string {
  return `<button class="paper-button ${selected ? "selected" : ""}" data-paper-id="${escapeAttr(paper.id)}" aria-pressed="${selected ? "true" : "false"}"><strong>${escapeHtml(paper.title)}</strong><span>${escapeHtml(paper.authors.join(", "))}</span></button>`;
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
    .status.success { color: var(--pi-success); border-color: var(--pi-success-border); background: var(--pi-success-surface); }
    .status.error { color: var(--pi-danger); border-color: var(--pi-danger); }
    .status.info { border-color: var(--pi-accent-border); }
    .search-label { display: grid; gap: 5px; margin-bottom: 12px; font-size: 12px; color: var(--pi-text-secondary); }
    input, select { min-width: 0; border: 1px solid var(--pi-border); border-radius: 7px; background: var(--pi-bg); color: var(--pi-text); padding: 7px; font: inherit; }
    .library-layout { display: grid; grid-template-columns: minmax(150px, 0.38fr) minmax(0, 1fr); gap: 12px; }
    .paper-list { display: grid; align-content: start; gap: 7px; }
    .paper-button { display: grid; gap: 3px; width: 100%; text-align: left; border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); color: var(--pi-text); padding: 9px; cursor: pointer; }
    .paper-button.selected { border-color: var(--pi-accent-border); background: var(--pi-bg-overlay-soft); }
    .paper-detail { min-width: 0; }
    .paper-header h2 { margin: 0; font-size: 18px; }
    .paper-header p { margin: 4px 0 12px; }
    .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 8px 0; }
    .chips > span { color: var(--pi-muted); font-size: 12px; }
    code, .connection { border: 1px solid var(--pi-border-muted); border-radius: 999px; padding: 2px 6px; font-size: 11px; }
    .connections, .passages, .drafts { display: grid; gap: 9px; margin-top: 18px; }
    h3 { margin: 0; font-size: 14px; }
    .connections > div { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
    .passage-card, .draft-card { display: grid; gap: 8px; border: 1px solid var(--pi-border); border-radius: 9px; background: var(--pi-surface); padding: 10px; }
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
