// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { html } from "lit";
import { ChatView } from "./ChatView";
import { normalizeMessage, textMessage } from "../chatMessages";
import type { FormattedText } from "./FormattedText";
import type { ContentRendererHost } from "./ContentRendererHost";
import { createContentRenderingService } from "../formatting/contentRendering";

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

it("distinguishes projected lines while keeping their keys stable across pagination", async () => {
  const view = new ChatView();
  view.sessionId = "projection-session";
  const projected = normalizeMessage({ entryId: "shared-entry", role: "assistant", content: [{ type: "text", text: "Partial reply" }],
    stopReason: "error", errorMessage: "Provider failed" });
  view.messages = projected;
  document.body.append(view);
  await view.updateComplete;
  const keys = () => [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")].map((element) => element.intentKey);
  const initial = keys();
  expect(initial).toHaveLength(2);
  expect(new Set(initial).size).toBe(2);
  expect(projected.map((line) => line.entryId)).toEqual(["shared-entry", "shared-entry"]);
  view.messages = [textMessage("user", "Older message"), ...projected];
  await view.updateComplete;
  expect(keys().slice(1)).toEqual(initial);
});

it("scopes chat intent by machine, session, message, part and block rather than duplicate text", async () => {
  const view = new ChatView();
  view.sessionId = "intent-session";
  view.contentRendering = createContentRenderingService(() => [{ id: "manual", label: "Manual", renderer: { id: "manual", render: () => html`<b>Diagram</b>` } }]);
  const text = "```diagram\nsame\n```\n\n```diagram\nsame\n```";
  view.messages = ["one", "two"].map((entryId) => ({ entryId, role: "user", parts: [{ type: "text", text }, { type: "text", text }] }));
  document.body.append(view);
  await view.updateComplete;

  async function hosts() {
    await view.updateComplete;
    const formatted = [...view.renderRoot.querySelectorAll<FormattedText>("formatted-text")];
    await Promise.all(formatted.map((element) => element.updateComplete));
    const result = formatted.flatMap((element) => [...element.renderRoot.querySelectorAll<ContentRendererHost>("pi-web-content-renderer")]);
    await Promise.all(result.map((element) => element.updateComplete));
    expect(result).toHaveLength(8);
    return result;
  }

  const initial = await hosts();
  const first = initial[0];
  if (first === undefined) throw new Error("Expected first diagram");
  first.renderRoot.querySelector<HTMLButtonElement>("button")?.click();
  await first.updateComplete;
  expect(initial.map((host) => host.renderRoot.querySelector("b") !== null)).toEqual([true, false, false, false, false, false, false, false]);
  view.sessionId = "another-session";
  expect((await hosts()).every((host) => host.renderRoot.querySelector("pre") !== null)).toBe(true);
  view.sessionId = "intent-session";
  expect((await hosts())[0]?.renderRoot.querySelector("b")).not.toBeNull();
  view.machineId = "other-machine";
  expect((await hosts()).every((host) => host.renderRoot.querySelector("pre") !== null)).toBe(true);
  view.machineId = "local";
  expect((await hosts())[0]?.renderRoot.querySelector("b")).not.toBeNull();
  expect(localStorage.length).toBe(0);
});
