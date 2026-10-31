// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { SessionInfo } from "../api";
import { installPopoverFake } from "./anchoredPopup.testSupport";
installPopoverFake();
import { SessionList } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("orphan child row indicator", () => {
  it("marks a session whose parent is missing as a child rather than a root row", async () => {
    const list = await renderList({ sessions: [orphan()] });

    const marker = row(list).querySelector(".tree-marker.orphan-marker");
    // Same glyph as an ordinary child: the left marker answers "is this a child",
    // not "where is the parent".
    expect(marker?.textContent).toBe("↳");
    expect(marker?.getAttribute("aria-label")).toBe("parent unavailable");
    expect(marker?.getAttribute("title")).toBe("Parent session is not available in this workspace");
  });

  it("adds no orphan marker to an ordinary root session", async () => {
    const list = await renderList({ sessions: [session("root")] });

    expect(row(list).querySelector(".orphan-marker")).toBeNull();
    expect(row(list).querySelector("small")?.textContent).toBe("3 messages");
  });

  it("shows a nested child under a present parent with the ordinary child marker", async () => {
    const parent = session("parent");
    const child = session("child", { parentSessionPath: parent.path });
    const list = await renderList({ sessions: [parent, child] });

    const childRow = [...list.shadowRoot?.querySelectorAll(".action-row") ?? []][1];
    expect(childRow?.querySelector(".tree-marker")?.textContent).toBe("↳");
    expect(childRow?.querySelector(".orphan-marker")).toBeNull();
  });

  it("keeps the transient-session prefix on the meta line", async () => {
    const list = await renderList({ sessions: [session("new", { persisted: false })] });

    expect(row(list).querySelector("small")?.textContent).toBe("new · 3 messages");
  });
});

async function renderList(options: { sessions: SessionInfo[] }): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = options.sessions;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function row(list: SessionList, index = 0): Element {
  const found = [...list.shadowRoot?.querySelectorAll(".action-row") ?? []][index];
  if (found === undefined) throw new Error(`No session row at index ${String(index)}`);
  return found;
}

function orphan(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return session("child", {
    parentSessionPath: "/sessions/--srv-dev-pi-web-feature--/parent.jsonl",
    ...overrides,
  });
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/srv/dev/pi-web",
    created: "2026-07-28T00:00:00.000Z",
    modified: "2026-07-28T00:00:00.000Z",
    messageCount: 3,
    firstMessage: id,
    ...overrides,
  };
}
