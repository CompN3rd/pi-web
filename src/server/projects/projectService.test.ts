import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ProjectStore } from "../storage/projectStore.js";
import { InvalidProjectPathError, ProjectService } from "./projectService.js";

it("marks only project-path validation failures as client errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-path-"));
  try {
    const store = new ProjectStore(join(root, "projects.json"));
    const service = new ProjectService(store);
    await writeFile(join(root, "file"), "not a directory");
    await expect(service.add({ path: join(root, "missing") })).rejects.toBeInstanceOf(InvalidProjectPathError);
    await expect(service.add({ path: join(root, "file") })).rejects.toBeInstanceOf(InvalidProjectPathError);
    const denied = Object.assign(new Error("Catalog write denied"), { code: "EACCES" });
    vi.spyOn(store, "add").mockRejectedValue(denied);
    await expect(service.add({ path: root })).rejects.toBe(denied);
  } finally {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});
