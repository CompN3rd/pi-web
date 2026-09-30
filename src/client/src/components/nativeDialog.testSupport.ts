import { vi } from "vitest";

/** happy-dom exposes showModal() but does not implement the browser's :modal state. */
export function mockNativeDialogModality(dialog: HTMLDialogElement): void {
  const matches = dialog.matches.bind(dialog);
  const show = dialog.show.bind(dialog);
  const showModal = dialog.showModal.bind(dialog);
  const close = dialog.close.bind(dialog);
  let modal = false;
  vi.spyOn(dialog, "show").mockImplementation(() => {
    if (dialog.open && modal) throw new DOMException("Dialog is already modal", "InvalidStateError");
    show(); modal = false;
  });
  vi.spyOn(dialog, "showModal").mockImplementation(() => {
    if (dialog.open && !modal) throw new DOMException("Dialog is already modeless", "InvalidStateError");
    showModal(); modal = true;
  });
  vi.spyOn(dialog, "close").mockImplementation((returnValue) => { close(returnValue); modal = false; });
  vi.spyOn(dialog, "matches").mockImplementation((selector) => selector === ":modal" ? modal && dialog.open : matches(selector));
}
