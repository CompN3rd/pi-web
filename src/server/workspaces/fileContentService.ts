import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import type { DeleteWorkspaceFileResponse, FileContentResponse, MoveWorkspaceFileOptions, MoveWorkspaceFileResponse, PiWebPathAccessConfig, WriteWorkspaceFileOptions, WriteWorkspaceFileResponse } from "../../shared/apiTypes.js";
import { imageMimeTypeForPath } from "./imagePreviewService.js";
import { resolveWorkspacePathAccessTarget } from "./pathAccessPolicy.js";
import { ensureInside, isNodeErrorWithCode, resolveInsideWorkspace, resolveParentInsideWorkspace } from "./pathSafety.js";

const MAX_BYTES = 512 * 1024;

export async function readWorkspaceFile(rootPath: string, path: string | undefined, pathAccess?: PiWebPathAccessConfig): Promise<FileContentResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  const { target, displayPath } = await resolveWorkspacePathAccessTarget(rootPath, path, pathAccess);
  const s = await stat(target);
  if (!s.isFile()) throw new Error("Path is not a file");
  const bytesToRead = Math.min(s.size, MAX_BYTES);
  const buffer = await readFilePrefix(target, bytesToRead);
  const media = mediaForPath(displayPath);
  const binary = media.mediaType === "image" || isProbablyBinary(buffer);
  return {
    path: displayPath,
    ...languageForPath(displayPath),
    ...media,
    encoding: "utf8",
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    content: binary ? "" : buffer.toString("utf8"),
    truncated: s.size > MAX_BYTES,
    binary,
  };
}

async function readFilePrefix(target: string, bytesToRead: number): Promise<Buffer> {
  if (bytesToRead === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(target, "r");
  try {
    const result = await handle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceFile(rootPath: string, path: string | undefined, content: Buffer, options: WriteWorkspaceFileOptions = {}): Promise<WriteWorkspaceFileResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");

  const createDirs = options.createDirs ?? true;
  const overwrite = options.overwrite ?? true;

  let existingTarget: string | undefined;
  if (overwrite) {
    try {
      const resolved = await resolveInsideWorkspace(rootPath, path);
      const s = await stat(resolved.target);
      if (!s.isFile()) throw new Error("Path is not a file");
      existingTarget = resolved.target;
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) { /* expected for creation — continue */ }
      else if (error instanceof Error && error.message === "Path does not exist") { /* expected for creation — continue */ }
      else throw error; // re-throw permission errors, "not a file", traversal errors, etc.
    }
  }

  // Use resolveParentInsideWorkspace for the actual write since the target may not exist yet
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  const newTarget = await resolveOrCreateWorkspaceFileTarget(root, target, createDirs);

  let writtenTarget: string;
  let created = false;
  if (existingTarget !== undefined) {
    await writeFile(existingTarget, content);
    writtenTarget = existingTarget;
  } else if (await publishFileExclusive(newTarget, content)) {
    writtenTarget = newTarget;
    created = true;
  } else {
    if (!overwrite) throw new Error(`File already exists: ${relativePath}`);
    let racedTarget: string;
    try {
      const resolved = await resolveInsideWorkspace(rootPath, path);
      racedTarget = resolved.target;
    } catch (error) {
      throw new Error(`File exists but cannot be safely resolved: ${relativePath}`, { cause: error });
    }
    const racedStat = await stat(racedTarget);
    if (!racedStat.isFile()) throw new Error("Path is not a file");
    await writeFile(racedTarget, content);
    writtenTarget = racedTarget;
  }

  const s = await stat(writtenTarget);
  return {
    path: relativePath,
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
    created,
  };
}

export async function deleteWorkspaceFile(rootPath: string, path: string | undefined): Promise<DeleteWorkspaceFileResponse> {
  if (path === undefined || path === "") throw new Error("path query parameter is required");
  // Use resolveParentInsideWorkspace + lstat so that deleting a symlink
  // deletes the symlink itself, not the target it points to.
  // resolveInsideWorkspace would call realpath on the target, following
  // symlinks and resolving the symlink's destination instead.
  const { root, target, relativePath } = await resolveParentInsideWorkspace(rootPath, path);
  try {
    // Resolve symlinks in the parent path to prevent escape via a symlinked
    // parent directory. The final path component is intentionally NOT resolved
    // so that lstat/unlink act on the entry itself (deleting a symlink rather
    // than the file it points to).
    const realParent = await realpath(dirname(target));
    const realTarget = join(realParent, basename(target));
    ensureInside(root, realTarget);
    const s = await lstat(realTarget);
    // Allow deleting regular files and symlinks, but not directories
    if (s.isDirectory()) throw new Error("Path is a directory, use directory deletion instead");
    await unlink(realTarget);
    return { path: relativePath, existed: true };
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) return { path: relativePath, existed: false };
    if (error instanceof Error && error.message === "Path does not exist") return { path: relativePath, existed: false };
    throw error;
  }
}

export async function moveWorkspaceFile(rootPath: string, fromPath: string | undefined, toPath: string | undefined, options: MoveWorkspaceFileOptions = {}): Promise<MoveWorkspaceFileResponse> {
  if (fromPath === undefined || fromPath === "") throw new Error("fromPath query parameter is required");
  if (toPath === undefined || toPath === "") throw new Error("toPath query parameter is required");

  const createDirs = options.createDirs ?? true;
  const overwrite = options.overwrite ?? false;

  // Source: must exist and be a file (uses realpath via resolveInsideWorkspace)
  const { target: source, relativePath: fromRelative } = await resolveInsideWorkspace(rootPath, fromPath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new Error("Source path is not a file");

  // Target: uses resolveParentInsideWorkspace + realpath(dirname) pattern (same as writeFile)
  const { root, target: dest, relativePath: destRelative } = await resolveParentInsideWorkspace(rootPath, toPath);

  const realDest = await resolveOrCreateWorkspaceFileTarget(root, dest, createDirs);

  if (!overwrite) {
    try {
      const destStat = await stat(realDest);
      if (destStat.isFile()) throw new Error(`File already exists: ${destRelative}`);
    } catch (error: unknown) {
      if (isNodeErrorWithCode(error, "ENOENT")) { /* expected — target doesn't exist */ }
      else if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
      else throw error;
    }
  }

  await rename(source, realDest);
  const finalStat = await stat(realDest);
  return { fromPath: fromRelative, toPath: destRelative, size: finalStat.size, modifiedAt: finalStat.mtime.toISOString() };
}

async function publishFileExclusive(target: string, content: Buffer): Promise<boolean> {
  const parent = dirname(target);
  const temporary = join(parent, `.${basename(target)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
      return true;
    } catch (error) {
      if (isNodeErrorWithCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      });
    }
  }
}

async function resolveOrCreateWorkspaceFileTarget(root: string, target: string, createDirs: boolean): Promise<string> {
  const parentRelation = relative(root, dirname(target));
  const parentParts = parentRelation === "" ? [] : parentRelation.split(sep);
  let current = root;
  for (const part of parentParts) {
    const candidate = join(current, part);
    try {
      const resolved = await realpath(candidate);
      ensureInside(root, resolved);
      if (!(await stat(resolved)).isDirectory()) throw new Error("Parent path is not a directory");
      current = resolved;
      continue;
    } catch (error: unknown) {
      if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      if (!createDirs) throw error;
    }
    await mkdir(candidate).catch((error: unknown) => {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    });
    const created = await realpath(candidate);
    ensureInside(root, created);
    if (!(await stat(created)).isDirectory()) throw new Error("Created parent path is not a directory");
    current = created;
  }
  const resolvedTarget = join(current, basename(target));
  ensureInside(root, resolvedTarget);
  return resolvedTarget;
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function languageForPath(path: string): { language?: string } {
  const ext = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string | undefined> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    sh: "shell",
    yml: "yaml",
    yaml: "yaml",
  };
  const language = ext === undefined ? undefined : languages[ext];
  return language === undefined ? {} : { language };
}

function mediaForPath(path: string): { mediaType?: "image"; mimeType?: string } {
  const mimeType = imageMimeTypeForPath(path);
  return mimeType === undefined ? {} : { mediaType: "image", mimeType };
}
