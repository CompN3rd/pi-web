import { randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function readWorkspaceRegularText(cwd: string, components: readonly string[], maxBytes: number): Promise<string> {
  if (components.length === 0) throw new Error("Research-library path is empty");
  const root = await realpath(cwd);
  for (const component of components) validatePathComponent(component);
  const target = await realpath(join(root, ...components));
  ensureInsideWorkspace(root, target);
  const entry = await stat(target);
  if (!entry.isFile()) throw new Error("Research-library file must resolve to a regular file");
  if (entry.size > maxBytes) throw new Error(`Research-library file exceeds ${String(maxBytes)} bytes`);
  const handle = await open(target, "r");
  try {
    const content = await handle.readFile({ encoding: "utf8" });
    const finalEntry = await handle.stat();
    if (!finalEntry.isFile() || finalEntry.size !== entry.size || finalEntry.mtimeMs !== entry.mtimeMs) {
      throw new Error("Research-library file changed while it was being read");
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeJsonExclusive(cwd: string, directoryComponents: readonly string[], fileName: string, value: unknown): Promise<boolean> {
  validatePathComponent(fileName);
  const directory = await ensureWorkspaceDirectory(cwd, directoryComponents);
  const destination = join(directory, fileName);
  const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  const serialized = `${JSON.stringify(value)}\n`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }
}

export async function listRegularJsonFileNames(cwd: string, directoryComponents: readonly string[], limit: number): Promise<string[]> {
  let directory: string;
  try {
    directory = await workspaceDirectory(cwd, directoryComponents);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".json"));
  if (entries.some((entry) => entry.isSymbolicLink() || !entry.isFile())) throw new Error("Research-library runtime JSON entries must be regular files");
  if (entries.length > limit) throw new Error("Research-library runtime directory contains too many JSON entries");
  return entries.map((entry) => entry.name).sort();
}

export async function ensureWorkspaceDirectory(cwd: string, components: readonly string[]): Promise<string> {
  const root = await realpath(cwd);
  let current = root;
  for (const component of components) {
    validatePathComponent(component);
    const requested = join(current, component);
    try {
      const resolved = await realpath(requested);
      ensureInsideWorkspace(root, resolved);
      if (!(await stat(resolved)).isDirectory()) throw new Error("Research-library runtime path must resolve to a directory");
      current = resolved;
      continue;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    await mkdir(requested).catch((mkdirError: unknown) => {
      if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
    });
    const created = await realpath(requested);
    ensureInsideWorkspace(root, created);
    if (!(await stat(created)).isDirectory()) throw new Error("Research-library runtime directory creation was replaced");
    current = created;
  }
  return current;
}

async function workspaceDirectory(cwd: string, components: readonly string[]): Promise<string> {
  const root = await realpath(cwd);
  let current = root;
  for (const component of components) {
    validatePathComponent(component);
    current = await realpath(join(current, component));
    ensureInsideWorkspace(root, current);
    if (!(await stat(current)).isDirectory()) throw new Error("Research-library runtime path must resolve to a directory");
  }
  return current;
}

function ensureInsideWorkspace(root: string, target: string): void {
  const relation = relative(root, target);
  if (relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))) return;
  throw new Error("Research-library path escapes the workspace");
}

function validatePathComponent(component: string): void {
  if (!/^[A-Za-z0-9._-]+$/u.test(component) || component === "." || component === "..") throw new Error("Invalid research-library path component");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
