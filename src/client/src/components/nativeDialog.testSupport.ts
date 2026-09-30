import { vi } from "vitest";

/** happy-dom exposes showModal() but does not implement the browser's :modal state. */
export function mockNativeDialogModality(dialog: HTMLDialogElement): void {
  const matches = dialog.matches.bind(dialog);
  const show = dialog.show.bind(dialog);
  const showModal = dialog.showModal.bind(dialog);
  let modal = false;
  vi.spyOn(dialog, "show").mockImplementation(() => { show(); modal = false; });
  vi.spyOn(dialog, "showModal").mockImplementation(() => { showModal(); modal = true; });
  vi.spyOn(dialog, "matches").mockImplementation((selector) => selector === ":modal" ? modal && dialog.open : matches(selector));
}
