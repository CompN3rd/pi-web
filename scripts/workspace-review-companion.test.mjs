import { createEventBus } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import companion from "../examples/session-bridge-plugin/src/companion.ts";
import { REVIEW_REQUEST, REVIEW_REPLY } from "../examples/session-bridge-plugin/src/browser/protocol.ts";

// Exercise SDK callback ordering without constructing a provider-backed session.
it("settles pre-start interference as failure and admits a later request", () => {
  const hooks = new Map();
  const events = createEventBus();
  const replies = [];
  events.on(REVIEW_REPLY, (reply) => replies.push(reply));
  companion({ on: (name, handler) => hooks.set(name, handler), events, sendUserMessage: vi.fn() });
  hooks.get("session_start")({}, { isIdle: () => true, hasPendingMessages: () => false });
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  events.emit(REVIEW_REQUEST, { requestId: first });
  expect(replies.at(-1)).toMatchObject({ requestId: first, status: "accepted" });
  hooks.get("before_agent_start")({ prompt: "An unrelated prompt arrived first" });
  hooks.get("agent_settled")();
  expect(replies.at(-1)).toMatchObject({ requestId: first, status: "failed", error: expect.stringContaining("interfered") });
  events.emit(REVIEW_REQUEST, { requestId: second });
  expect(replies.at(-1)).toMatchObject({ requestId: second, status: "accepted" });
  hooks.get("session_shutdown")();
});
