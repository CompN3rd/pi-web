import { mkdir, realpath, stat } from "node:fs/promises";
import type { ProjectStore } from "../storage/projectStore.js";
import type { Project } from "../types.js";
import { expandUserPath } from "./directorySuggestions.js";

export class InvalidProjectPathError extends Error {
  override name = "InvalidProjectPathError";
}

export class ProjectService {
  constructor(private readonly store: ProjectStore) {}

  list(): Promise<Project[]> {
    return this.store.list();
  }

  async add(input: { name?: string; path: string; create?: boolean }): Promise<Project> {
    // Trim so stray whitespace cannot diverge the stored path from the
    // trimmed key the trust lookup (projectTrustRoutes) previews decisions for.
    const requestedPath = expandUserPath(input.path.trim());
    let resolved: string;
    try {
      if (input.create === true) await mkdir(requestedPath, { recursive: true });
      resolved = await realpath(requestedPath);
      if (!(await stat(resolved)).isDirectory()) throw new InvalidProjectPathError("Project path must be a directory");
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && typeof cause.code === "string"
        && ["ENOENT", "ENOTDIR", "EEXIST", "EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ELOOP", "ERR_INVALID_ARG_VALUE"].includes(cause.code)) {
        throw new InvalidProjectPathError(cause.message, { cause });
      }
      throw cause;
    }
    return this.store.add(input.name === undefined ? { path: resolved } : { name: input.name, path: resolved });
  }

  async close(id: string): Promise<void> {
    if (!(await this.store.remove(id))) throw new Error("Project not found");
  }

  async requireProject(id: string): Promise<Project> {
    const project = await this.store.get(id);
    if (!project) throw new Error("Project not found");
    return project;
  }
}
