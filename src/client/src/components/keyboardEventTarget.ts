/**
 * Whether a composed keyboard event originated from a native button, including
 * one inside an open shadow root. List-level keyboard shortcuts must defer to
 * these controls so Enter keeps the button's native activation behavior.
 */
export function keyboardEventOriginatesFromButton(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => target instanceof HTMLButtonElement);
}
