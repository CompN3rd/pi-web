import { css, html } from "lit";
import { pickerMessages as messages } from "../pickerMessages";

/** Shared native control, rendered in the picker's DOM beside (never inside) its row button. */
export function defaultPin(label: string, active: boolean, disabled: boolean, onClick: () => void) {
  const help = messages.t("useDefault", { label });
  return html`<button type="button" class="default-pin ui-button ui-button--icon" aria-label=${help} title=${help}
    aria-pressed=${String(active)} ?disabled=${disabled} @click=${onClick}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill=${active ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8">
      <path stroke-linejoin="round" d="m12 3 2.78 5.63L21 9.54l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.93 1.06-6.2L3 9.54l6.22-.91Z" />
    </svg>
  </button>`;
}

/** Evaluate at render time so picker controllers refresh this shared guidance. */
export function defaultPinHelp() {
  return html`<div class="default-help"><strong>${messages.t("defaultHelp")}</strong></div>`;
}

export const defaultPinStyles = css`
  .default-help { display: flex; justify-content: space-between; gap: 12px; padding: 8px 12px; color: var(--pi-muted); }
  .default-pin { align-self: stretch; }
  .default-pin[aria-pressed="true"] svg { color: var(--pi-accent); }
`;
