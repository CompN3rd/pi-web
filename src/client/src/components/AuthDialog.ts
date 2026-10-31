import { LocalizationController } from "../localization/browser";
import { authMessages as messages } from "../authMessages";
import { stylesheetIntegrationCapability } from "../plugins/styles";
import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { AuthDialogState } from "../appState";
import type { AuthProviderOption, OAuthFlowState } from "../api";
import { LOCAL_MACHINE_ID } from "../machineKeys";
import { keyboardEventOriginatesFromNativeActivationControl } from "./keyboardEventTarget";
import "./ModalSurface";
import type { ModalSurface } from "./ModalSurface";
import { scrollWhenSelected } from "./scrollWhenSelected";
import { uiDialogStyles, uiFormStyles, uiSelectionStyles } from "./ui/dialogStyles";

/** One keyboard-navigable choice on the option-list steps (method, providers, logout). */
interface AuthDialogOption {
  /** Stable identity, used to avoid redundant scrolling on re-render. */
  key: string;
  title: TemplateResult | string;
  detail: string;
  /** Plain text matched by the provider search box, independent of the rendered title. */
  searchText: string;
  run: () => void;
}

@customElement("auth-dialog")
export class AuthDialog extends LitElement {
  constructor() {
    super();
    new LocalizationController(this);
    stylesheetIntegrationCapability.createController(this);
  }

  @property({ attribute: false }) state?: AuthDialogState;
  @property({ attribute: false }) onChooseMethod?: (authType: "oauth" | "api_key") => void;
  @property({ attribute: false }) onSelectProvider?: (providerId: string, authType: "oauth" | "api_key") => void;
  @property({ attribute: false }) onLogoutProvider?: (providerId: string) => void;
  @property({ attribute: false }) onOAuthInput?: (value: string) => void;
  @property({ attribute: false }) onOAuthRespond?: (value?: string) => void;
  @property({ attribute: false }) onOAuthCancel?: () => void;
  @property({ attribute: false }) onCancel?: () => void;
  @query("modal-surface") private surface?: ModalSurface;
  @state() private selectedIndex = 0;
  /** Search box text on the provider-list steps; scoped to the current step. */
  @state() private query = "";

  override render() {
    const state = this.state;
    if (state === undefined) return null;
    return html`
      <modal-surface
        .onClose=${() => { this.cancel(); }}
        .initialFocus=${this.initialFocusTarget(state)}
        .label=${this.dialogTitle(state)}
        @keydown=${(event: KeyboardEvent) => { this.handleKeyDown(event); }}
      >
        <header class="ui-dialog-header">
          <strong class="ui-dialog-title">${this.dialogTitle(state)}</strong>
          <button class="ui-button ui-button--icon" title=${messages.t("close")} aria-label=${messages.t("close")} @click=${() => { this.cancel(); }}>×</button>
        </header>
        ${this.renderBody(state)}
      </modal-surface>
    `;
  }

  /** Selectable choices for the option-list steps; undefined on the oauth step, which has no roving selection. */
  private optionsFor(state: AuthDialogState): AuthDialogOption[] | undefined {
    switch (state.step) {
      case "method":
        return [
          { key: "oauth", title: messages.t("subscription"), detail: messages.t("subscriptionDetail"), searchText: messages.t("subscription"), run: () => { this.onChooseMethod?.("oauth"); } },
          { key: "api_key", title: messages.t("credentials"), detail: messages.t("credentialsDetail"), searchText: messages.t("credentials"), run: () => { this.onChooseMethod?.("api_key"); } },
        ];
      case "providers":
        return state.providers.map((provider) => ({
          key: provider.id,
          title: html`<bdi>${provider.name}</bdi>${provider.status.source !== undefined ? html` <em>${statusLabel(provider)}</em>` : null}`,
          detail: messages.t("providerDetail", { provider: provider.id, type: authTypeLabel(provider.authType) }),
          searchText: provider.name,
          run: () => { this.onSelectProvider?.(provider.id, provider.authType); },
        }));
      case "logout":
        return state.providers.map((provider) => ({
          key: provider.id,
          title: html`<bdi>${provider.name}</bdi>`,
          detail: messages.t("providerDetail", { provider: provider.id, type: authTypeLabel(provider.authType) }),
          searchText: provider.name,
          run: () => { this.onLogoutProvider?.(provider.id); },
        }));
      case "starting":
      case "oauth":
        return undefined;
    }
  }

  /** The search box target for the step: the OAuth prompt input or the provider search box. */
  private initialFocusTarget(state: AuthDialogState): string | undefined {
    if (state.step === "oauth") return state.flow.prompt !== undefined ? "input" : undefined;
    if (state.step === "providers" || state.step === "logout") return state.providers.length > 0 ? "input" : undefined;
    return undefined;
  }

  /** Whether the step renders a searchable provider list (selecting or removing stored credentials). */
  private stepHasSearch(state: AuthDialogState): boolean {
    return state.step === "providers" || state.step === "logout";
  }

  private handleSearchInput(event: Event): void {
    if (event.target instanceof HTMLInputElement) {
      this.query = event.target.value;
      // Filtering replaces the list beneath the roving selection: start back at its first option.
      this.selectedIndex = 0;
    }
  }

  private filteredOptions(options: AuthDialogOption[]): AuthDialogOption[] {
    const query = this.query.trim().toLowerCase();
    if (query === "") return options;
    return options.filter((option) => `${option.searchText} ${option.detail} ${option.key}`.toLowerCase().includes(query));
  }

  /** The options actually rendered for the step: the roving selection and keyboard navigation see these. */
  private visibleOptions(state: AuthDialogState): AuthDialogOption[] {
    const options = this.optionsFor(state);
    return options === undefined ? [] : this.filteredOptions(options);
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("state") && authDialogStateStep(changed.get("state")) !== this.state?.step) {
      // Selection and search text are scoped to the visible option list:
      // entering a step starts at its first option with an empty query.
      this.selectedIndex = 0;
      this.query = "";
      return;
    }
    const options = this.state === undefined ? undefined : this.visibleOptions(this.state);
    if (options !== undefined) this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, options.length - 1));
  }

  protected override updated(changed: PropertyValues): void {
    if (!changed.has("state")) return;
    const previousStep = authDialogStateStep(changed.get("state"));
    if (previousStep === undefined) return;
    const currentStep = this.state?.step;
    const stepChanged = previousStep !== currentStep;
    const oauthInteractionChanged = previousStep === "oauth"
      && currentStep === "oauth"
      && oauthInteractionKey(changed.get("state")) !== oauthInteractionKey(this.state);
    // Step changes and same-step OAuth interaction changes can replace the
    // focused control. Reapply the surface's input-or-dialog focus contract so
    // keyboard events never become stranded on the page.
    if (stepChanged || oauthInteractionChanged) this.surface?.focusDialog();
  }

  private dialogTitle(state: AuthDialogState): string {
    switch (state.step) {
      case "method": return messages.t("methodTitle");
      case "starting": return messages.t(state.mode === "login" ? "startMcpLogin" : "startMcpLogout");
      case "providers": return messages.t(state.authType === undefined ? "selectProvider" : state.authType === "oauth" ? "selectSubscription" : "selectCredentials");
      case "oauth": return state.flow.target === "mcp"
        ? state.flow.mcpMode === undefined ? messages.t("mcpAuthentication") : state.flow.select === undefined
          ? messages.t(state.flow.mcpMode === "login" ? "mcpLoginProvider" : "mcpLogoutProvider", { provider: state.flow.providerName })
          : messages.t(state.flow.mcpMode === "login" ? "mcpLogin" : "mcpLogout")
        : messages.t("loginProvider", { provider: state.flow.providerName });
      case "logout": return messages.t("removeTitle");
    }
  }

  private renderBody(state: AuthDialogState) {
    if (state.step === "oauth") return this.renderOAuth(state);
    if (state.step === "starting") return html`
      <div class="ui-dialog-body ui-form-body">
        ${state.error === undefined ? html`<p role="status">${messages.t("startingMcp")}</p>` : html`<p class="ui-form-error" role="alert">${state.error}</p>`}
        <div class="ui-form-actions"><button class="ui-button" @click=${() => { this.onCancel?.(); }}>${messages.t(state.error === undefined ? "cancel" : "close")}</button></div>
      </div>`;
    const options = this.optionsFor(state) ?? [];
    const visible = this.filteredOptions(options);
    return html`
      ${this.stepHasSearch(state) && options.length > 0 ? html`
        <div class="ui-dialog-search-row">
          <input class="ui-dialog-search" aria-label=${messages.t("search")} placeholder=${messages.t("search")} .value=${this.query} @input=${(event: Event) => { this.handleSearchInput(event); }}>
        </div>
      ` : null}
      <div class="options ui-selection-list">
        ${options.length === 0 ? html`<div class="empty ui-dialog-empty">${state.step === "logout" ? messages.t("noCredentials") : messages.t("noProviders")}</div>`
        : visible.length === 0 ? html`<div class="empty ui-dialog-empty">${messages.t("noMatches")}</div>`
        : visible.map((option, index) => html`
          <button
            class=${`ui-button ui-selection-option ${index === this.selectedIndex ? "selected" : ""}`}
            aria-current=${index === this.selectedIndex ? "true" : nothing}
            ${scrollWhenSelected(index === this.selectedIndex, option.key)}
            @focus=${() => { this.selectedIndex = index; }}
            @click=${() => { option.run(); }}
          >
            <span>${option.title}</span>
            <small class="ui-selection-detail"><bdi>${option.detail}</bdi></small>
          </button>
        `)}
      </div>
    `;
  }

  private renderOAuth(state: Extract<AuthDialogState, { step: "oauth" }>) {
    const flow = state.flow;
    const isMcp = flow.target === "mcp";
    const running = flow.status === "running";
    const prompt = running && flow.cancelRequested !== true ? flow.prompt : undefined;
    const select = running && flow.cancelRequested !== true ? flow.select : undefined;
    const showAuthorization = flow.auth !== undefined && (!isMcp || (running && flow.cancelRequested !== true));
    const promptInputType = prompt === undefined ? undefined : oauthPromptInputType(prompt.promptType);
    // Pi's MCP bridge uses a text input for its redirect fallback; provider
    // flows identify this interaction explicitly with manual_code.
    const showPasteNote = (isMcp || isBrowserRemoteOAuthMachine(state.machineId, window.location.hostname))
      && flow.status === "running"
      && (isMcp ? prompt !== undefined && flow.auth !== undefined : prompt?.promptType === "manual_code");
    return html`
      <div class="form ui-dialog-body ui-form-body">
        ${showAuthorization && flow.auth !== undefined ? html`
          <p>${isMcp ? messages.t("approveBrowser") : messages.t("authorizationLink")}</p>
          <p><a class=${isMcp ? "ui-button ui-button--action" : nothing} href=${flow.auth.url} target="_blank" rel="noopener noreferrer">${isMcp ? messages.t("authorizationPage") : html`<bdi dir="ltr">${flow.auth.url}</bdi>`}</a></p>
          ${flow.auth.deviceCode !== undefined ? html`
            <p class="warning">${messages.rich("enterCode", { codeTag: (chunks) => html`<code dir="ltr">${chunks}</code>`, code: flow.auth.deviceCode.userCode })}</p>
          ` : flow.auth.instructions !== undefined ? html`<p class="warning">${flow.auth.instructions}</p>` : null}
        ` : isMcp ? select !== undefined ? null : html`<p role="status">${flow.cancelRequested === true && running ? messages.t("cancellationRequested") : !running ? messages.t("finished") : messages.t("waiting")}</p>` : html`<p>${messages.t("startingLogin")}</p>`}
        ${isMcp && flow.mcpMode === "logout" ? html`<p class="warning">${messages.t("logoutWarning")}</p>` : null}
        ${isMcp && flow.mcpMode === "login" && flow.status === "complete" && flow.auth === undefined && flow.cancelRequested !== true ? html`<p>${messages.t("reusedCredentials")}</p>` : null}
        ${isMcp && flow.cancelRequested === true ? html`<p class="warning">${messages.t("cancelWarning")}</p>` : null}
        ${showPasteNote ? html`<p class="warning">${isMcp ? messages.t("mcpPasteNote") : messages.t("remotePasteNote")}</p>` : null}
        ${flow.progress.length > 0 ? html`<ul class="progress" aria-label=${messages.t("messages")}>${flow.progress.map((line) => html`<li dir="auto">${line}</li>`)}</ul>` : null}
        ${flow.info?.map((item) => item.links === undefined || item.links.length === 0 ? null : html`
          <div class="info-links" aria-label=${messages.t("related")}>
            ${item.links.map((link) => html`<a href=${link.url} target="_blank" rel="noreferrer" title=${item.message}>${link.label ?? link.url}</a>`)}
          </div>
        `) ?? null}
        ${prompt !== undefined ? html`
          <label class="ui-form-field" for="oauth-prompt">
            <bdi>${prompt.message}</bdi>
            <input class="ui-input" dir="auto" id="oauth-prompt" type=${promptInputType} autocomplete=${promptInputType === "password" ? "off" : "on"} .value=${state.inputValue ?? ""} placeholder=${prompt.placeholder ?? ""} @input=${(event: Event) => { if (event.target instanceof HTMLInputElement) this.onOAuthInput?.(event.target.value); }}>
          </label>
          <div class="actions ui-form-actions"><button class="ui-button" @click=${() => { this.onOAuthCancel?.(); }}>${messages.t("cancel")}</button><button class="ui-button ui-button--primary" ?disabled=${state.responding === true} @click=${() => { this.onOAuthRespond?.(); }}>${messages.t("submit")}</button></div>
        ` : null}
        ${select !== undefined ? html`
          <p>${select.message}</p>
          <div class="inline-options ui-selection-list">${select.options.map((option) => html`
            <button class="ui-button ui-selection-option" ?disabled=${state.responding === true} @click=${() => { this.onOAuthRespond?.(option.value); }}>
              <span><bdi>${option.label}</bdi></span>
              ${option.description === undefined ? null : html`<small class="ui-selection-detail">${option.description}</small>`}
            </button>
          `)}</div>
        ` : null}
        ${state.error !== undefined && state.error !== "" ? html`<div class="error-text ui-form-error">${state.error}</div>` : null}
        ${flow.status === "error" || flow.status === "cancelled" ? html`<div class="error-text ui-form-error" role="alert">${flow.error ?? messages.t(flow.status === "error" ? "failed" : "cancelled")}</div>` : null}
        ${!running ? html`<div class="actions ui-form-actions"><button class="ui-button" @click=${() => { this.cancel(); }}>${messages.t("close")}</button></div>` : null}
        ${prompt === undefined && (select === undefined || isMcp) && running ? html`<div class="actions ui-form-actions"><button class="ui-button" @click=${() => { if (flow.cancelRequested === true) this.onCancel?.(); else this.onOAuthCancel?.(); }}>${messages.t(flow.cancelRequested === true ? "close" : "cancel")}</button></div>` : null}
      </div>
    `;
  }

  // Escape is owned by the modal surface (routed to `cancel`). List-level
  // navigation and prompt submission deliberately defer to native buttons so
  // their focused Enter behavior remains authoritative.
  private handleKeyDown(event: KeyboardEvent): void {
    const state = this.state;
    if (state === undefined || keyboardEventOriginatesFromNativeActivationControl(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const options = this.visibleOptions(state);
      if (options.length === 0) return;
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + delta + options.length) % options.length;
      return;
    }
    if (event.key !== "Enter") return;
    if (state.step === "oauth") {
      if (state.flow.prompt === undefined) return;
      event.preventDefault();
      this.onOAuthRespond?.();
      return;
    }
    const option = this.visibleOptions(state)[this.selectedIndex];
    if (option === undefined) return;
    event.preventDefault();
    option.run();
  }

  private cancel(): void {
    const state = this.state;
    if (state?.step === "oauth" && state.flow.cancelRequested !== true) this.onOAuthCancel?.();
    else this.onCancel?.();
  }

  static override styles = [uiDialogStyles, uiFormStyles, uiSelectionStyles, css`
    .form p { margin: 0; color: var(--pi-text-secondary); overflow-wrap: anywhere; }
    .form a { color: var(--pi-accent); overflow-wrap: anywhere; }
    .form code { border: 1px solid var(--pi-border); border-radius: 4px; background: var(--pi-surface); padding: 1px 4px; }
    .warning { color: var(--pi-warning); }
    .progress { margin: 0; padding-inline-start: 18px; color: var(--pi-muted); }
    .info-links { display: flex; flex-wrap: wrap; gap: 8px 12px; }
    em { color: var(--pi-success); font-style: normal; font-size: 12px; }
  `];
}

export function oauthPromptInputType(promptType: NonNullable<OAuthFlowState["prompt"]>["promptType"]): "text" | "password" {
  return promptType === "secret" ? "password" : "text";
}

const loopbackHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when `hostname` names the machine the browser itself runs on. */
export function isLoopbackHostname(hostname: string): boolean {
  // Browsers report IPv6 hostnames bracketed, e.g. "[::1]".
  return loopbackHostnames.has(hostname.trim().replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * True when the OAuth loopback redirect (`http://localhost:<port>/callback`) cannot
 * reach the runtime from this browser: the flow runs on a federated machine, or the
 * gateway host is not loopback-local to the browser. The user must then paste the
 * redirect URL manually.
 */
export function isBrowserRemoteOAuthMachine(machineId: string, hostname: string): boolean {
  return machineId !== LOCAL_MACHINE_ID || !isLoopbackHostname(hostname);
}

function authTypeLabel(authType: "oauth" | "api_key"): string {
  return messages.t(authType === "oauth" ? "typeSubscription" : "typeCredentials");
}

/**
 * Identity of the controls rendered for an OAuth interaction. Polling updates
 * that preserve this key must not steal focus; changes indicate that the
 * focused prompt/selection/action may have been replaced.
 */
function oauthInteractionKey(value: unknown): string | undefined {
  if (authDialogStateStep(value) !== "oauth" || typeof value !== "object" || value === null || !("flow" in value)) return undefined;
  const flow = value.flow;
  if (typeof flow !== "object" || flow === null) return undefined;
  const flowId = "flowId" in flow && typeof flow.flowId === "string" ? flow.flowId : "";
  const promptRequestId = "prompt" in flow ? oauthInteractionRequestId(flow.prompt) : undefined;
  if (promptRequestId !== undefined) {
    const responsePhase = "responding" in value && value.responding === true ? "responding" : "ready";
    return `${flowId}:prompt:${promptRequestId}:${responsePhase}`;
  }
  const selectRequestId = "select" in flow ? oauthInteractionRequestId(flow.select) : undefined;
  if (selectRequestId !== undefined) return `${flowId}:select:${selectRequestId}`;
  const status = "status" in flow && typeof flow.status === "string" ? flow.status : "unknown";
  return `${flowId}:waiting:${status}`;
}

function oauthInteractionRequestId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return undefined;
  return typeof value.requestId === "string" ? value.requestId : undefined;
}

/** Step of a previous `state` value read from a PropertyValues map, without type assertions. */
function authDialogStateStep(value: unknown): AuthDialogState["step"] | undefined {
  if (typeof value !== "object" || value === null || !("step" in value)) return undefined;
  switch (value.step) {
    case "method":
    case "starting":
    case "providers":
    case "oauth":
    case "logout":
      return value.step;
    default:
      return undefined;
  }
}

function statusLabel(provider: AuthProviderOption): string {
  if (provider.status.source === undefined) return "";
  switch (provider.status.source) {
    case "stored": return messages.t("configured");
    case "environment": return provider.status.label === undefined ? messages.t("environment") : messages.t("environmentLabel", { label: provider.status.label });
    case "runtime": return messages.t("runtime");
    case "fallback": return messages.t("customKey");
    case "models_json_key": return messages.t("modelsKey");
    case "models_json_command": return messages.t("modelsCommand");
    default: return "";
  }
}

