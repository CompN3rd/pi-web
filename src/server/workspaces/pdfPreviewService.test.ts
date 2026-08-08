import { appendFile, mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PDF_PREVIEW_BYTES } from "../../shared/workspaceFiles";
import { PdfRangeNotSatisfiableError, inlinePdfDisposition, parsePdfByteRange, readWorkspacePdfPreview } from "./pdfPreviewService";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("parsePdfByteRange", () => {
  it("parses closed, open, and suffix ranges", () => {
    expect(parsePdfByteRange(undefined, 20)).toBeUndefined();
    expect(parsePdfByteRange("bytes=2-5", 20)).toEqual({ start: 2, end: 5 });
    expect(parsePdfByteRange("bytes=7-", 20)).toEqual({ start: 7, end: 19 });
    expect(parsePdfByteRange("bytes=-4", 20)).toEqual({ start: 16, end: 19 });
    expect(parsePdfByteRange("bytes=18-99", 20)).toEqual({ start: 18, end: 19 });
    expect(parsePdfByteRange("BYTES=1-2", 20)).toEqual({ start: 1, end: 2 });
    expect(parsePdfByteRange("bytes=1-999999999999999999999", 20)).toEqual({ start: 1, end: 19 });
    expect(parsePdfByteRange("bytes=-999999999999999999999", 20)).toEqual({ start: 0, end: 19 });
  });

  it.each(["bytes=", "items=1-2", "bytes=1-2,4-5", "bytes=8-2", "bytes=x-y"])("ignores unsupported or malformed range %s", (header) => {
    expect(parsePdfByteRange(header, 20)).toBeUndefined();
  });

  it.each(["bytes=20-", "bytes=-0", "bytes=999999999999999999999-"])("rejects satisfiable-syntax range outside the representation %s", (header) => {
    expect(() => parsePdfByteRange(header, 20)).toThrow(PdfRangeNotSatisfiableError);
  });
});

describe("readWorkspacePdfPreview", () => {
  it("opens once, verifies PDF magic, and streams exact full/range bytes", async () => {
    const root = await fixtureRoot();
    const bytes = Buffer.from("%PDF-1.7\n0123456789", "ascii");
    await writeFile(join(root, "paper.pdf"), bytes);

    const full = await readWorkspacePdfPreview(root, "paper.pdf", undefined);
    expect(full.range).toBeUndefined();
    expect(full.contentLength).toBe(bytes.length);
    expect(await streamBytes(full.stream)).toEqual(bytes);

    const range = await readWorkspacePdfPreview(root, "paper.pdf", "bytes=5-9");
    expect(range.range).toEqual({ start: 5, end: 9 });
    expect(range.contentLength).toBe(5);
    expect(await streamBytes(range.stream)).toEqual(bytes.subarray(5, 10));
  });

  it("bounds a full response to the validated file size when the file grows before consumption", async () => {
    const root = await fixtureRoot();
    const original = Buffer.from("%PDF-1.7\noriginal", "ascii");
    const path = join(root, "paper.pdf");
    await writeFile(path, original);

    const preview = await readWorkspacePdfPreview(root, "paper.pdf", undefined);
    await appendFile(path, "-appended-after-validation");

    expect(preview.contentLength).toBe(original.length);
    expect(await streamBytes(preview.stream)).toEqual(original);
  });

  it("detects deterministic path replacement after the descriptor opens", async () => {
    const root = await fixtureRoot();
    const path = join(root, "paper.pdf");
    await writeFile(path, "%PDF-1.7\nfirst");

    await expect(readWorkspacePdfPreview(root, "paper.pdf", undefined, undefined, {
      afterOpen: async () => {
        await rename(path, join(root, "opened.pdf"));
        await writeFile(path, "%PDF-1.7\nreplacement");
      },
    })).rejects.toThrow("changed while opening");
  });

  it("refuses wrong extensions, magic, directories, and oversized sparse files", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "paper.txt"), "%PDF-1.7\n");
    await writeFile(join(root, "fake.pdf"), "not pdf");
    await mkdir(join(root, "folder.pdf"));
    await writeFile(join(root, "huge.pdf"), "%PDF-");
    await truncate(join(root, "huge.pdf"), MAX_PDF_PREVIEW_BYTES + 1);

    await expect(readWorkspacePdfPreview(root, "paper.txt", undefined)).rejects.toThrow("requires a .pdf");
    await expect(readWorkspacePdfPreview(root, "fake.pdf", undefined)).rejects.toThrow("not a PDF");
    await expect(readWorkspacePdfPreview(root, "folder.pdf", undefined)).rejects.toThrow("regular file");
    await expect(readWorkspacePdfPreview(root, "huge.pdf", undefined)).rejects.toThrow("128 MB");
  });

  it("allows internal symlinks and refuses external symlink escapes", async () => {
    const root = await fixtureRoot();
    const external = await fixtureRoot();
    await writeFile(join(root, "inside.pdf"), "%PDF-1.7\ninside");
    await writeFile(join(external, "outside.pdf"), "%PDF-1.7\noutside");
    await symlink(join(root, "inside.pdf"), join(root, "internal.pdf"), "file");
    await symlink(join(external, "outside.pdf"), join(root, "external.pdf"), "file");

    const internal = await readWorkspacePdfPreview(root, "internal.pdf", undefined);
    expect((await streamBytes(internal.stream)).toString()).toContain("inside");
    await expect(readWorkspacePdfPreview(root, "external.pdf", undefined)).rejects.toThrow("escapes workspace");
  });

  it("sanitizes inline filenames without losing the encoded Unicode name", () => {
    const value = inlinePdfDisposition("folder/quo\"te-論文.pdf");
    expect(value).toContain('filename="quo_te-__.pdf"');
    expect(value).toContain("filename*=UTF-8''quo%22te-%E8%AB%96%E6%96%87.pdf");
    expect(inlinePdfDisposition("a'b(c)*.pdf")).toContain("filename*=UTF-8''a%27b%28c%29%2A.pdf");
    expect(value).not.toContain("\r");
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pdf-preview-"));
  roots.push(root);
  return root;
}

async function streamBytes(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else if (chunk instanceof Uint8Array || typeof chunk === "string") chunks.push(Buffer.from(chunk));
      else reject(new Error("Unexpected stream chunk"));
    });
    stream.once("error", reject);
    stream.once("end", () => { resolve(Buffer.concat(chunks)); });
  });
}
