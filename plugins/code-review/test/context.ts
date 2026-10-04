import { vi } from "vitest";
import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { Comment } from "../src/browser/model.js";

export const savedComment: Comment = { id: "c1", path: "a.ts", source: "files", side: "new", start: 1, end: 1, body: "Please fix this", hash: "a".repeat(64), createdAt: 1 };
export function context(): WorkspacePanelContext {
  return {
    machine: { id: "local", name: "Local", kind: "local" },
    workspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true },
    state: {
      selectedMachine: { id: "local", name: "Local", kind: "local" },
      selectedWorkspace: { id: "w", projectId: "p", path: "/repo", label: "main", isMain: true },
      selectedSession: { id: "s", cwd: "/repo", archived: false, pending: false },
    },
    files: {
      listFiles: vi.fn().mockResolvedValue({ path: "", scannedAt: "now", truncated: false, entries: [{ path: "a.ts", name: "a.ts", type: "file" }] }),
      readFile: vi.fn().mockResolvedValue({ path: "a.ts", content: "one\ntwo\nthree\n", encoding: "utf8", size: 14, modifiedAt: "now", binary: false, truncated: false }),
      writeFile: vi.fn(), deleteFile: vi.fn(), moveFile: vi.fn(),
    },
    peer: { request: vi.fn().mockResolvedValue([]) },
    host: { requestRender: vi.fn() },
    navigate: vi.fn().mockResolvedValue(undefined),
    prompt: { insertText: vi.fn(), getText: () => "", getSelection: () => null, setChip: vi.fn(), removeChip: vi.fn() },
    terminal: { open: vi.fn(), runCommand: vi.fn() },
  };
}
