// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../api";
import { WorkspaceList } from "./WorkspaceList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("workspace-list removal actions", () => {
  it("shows provider wording for neutral removal metadata and ignores legacy Git fields", async () => {
    const removable = workspace("neutral", {
      isGitRepo: false,
      isGitWorktree: false,
      removal: {
        actionLabel: "Disconnect view",
        confirmation: "Disconnect this view without deleting files?",
        precondition: "removal-v1",
      },
    });
    const legacyGitOnly = workspace("legacy", { isGitRepo: true, isGitWorktree: true });
    const onDelete = vi.fn();
    const list = new WorkspaceList();
    list.workspaces = [removable, legacyGitOnly];
    list.onDelete = onDelete;
    document.body.append(list);
    await list.updateComplete;

    const toggles = list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle");
    toggles?.[0]?.click();
    await list.updateComplete;

    const action = list.shadowRoot?.querySelector<HTMLButtonElement>(".workspace-menu-actions .danger");
    expect(action?.textContent).toBe("Disconnect view");
    expect(action?.title).toBe("Disconnect view");
    action?.click();
    expect(onDelete).toHaveBeenCalledWith(removable);
    await list.updateComplete;

    list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle")[1]?.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".workspace-menu-actions")).toBeNull();
  });
});

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return {
    id,
    projectId: "project-1",
    path: `/workspaces/${id}`,
    label: id,
    isMain: false,
    isGitRepo: false,
    isGitWorktree: false,
    ...patch,
  };
}
