import { describe, expect, it } from "vitest";
import { workspaceMarkdownFilePath } from "./workspaceLinks";

const workspace = { machineId: "local", projectId: "p", workspaceId: "w", root: "/work" };

describe("workspace Markdown path normalization", () => {
  it.each([".", "./", "././", "/work/./", "%2E/%2E"])("does not classify workspace-root reference %s as a file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it.each(["../secret", "./dir/../secret", "dir/%2E%2E/secret", "/work/dir/../secret"])("preserves traversal in %s for server rejection", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)?.split("/")).toContain("..");
  });

  it.each(["https://example.com/./file", "//example.com/./file", "mailto:a@example.com", "javascript:alert(1)", "#section", "?query", "/elsewhere/./file", "/work-other/file", "bad%ZZ", "dir%5Cfile", "file%00.txt"])("does not normalize excluded reference %s into a workspace file", (href) => {
    expect(workspaceMarkdownFilePath(href, workspace)).toBeUndefined();
  });

  it.each([
    ["C:\\repo", "C:/repo/docs/a.md"],
    ["C:/repo/", "c:\\repo\\docs\\a.md"],
    ["C:\\repo", "C%3A%5Crepo%5Cdocs%5Ca.md"],
    ["\\\\server\\share\\repo", "\\\\SERVER\\share\\repo\\docs\\a.md"],
  ])("classifies native absolute links within %s", (root, reference) => {
    expect(workspaceMarkdownFilePath(reference, { ...workspace, root })).toBe("docs/a.md");
  });

  it.each(["C:/elsewhere/a.md", "D:/repo/a.md", "C:/repo-other/a.md", "C:relative.md", "\\\\other\\share\\a.md", "//server/share/repo/a.md"])("does not treat outside or web references as workspace files: %s", (reference) => {
    expect(workspaceMarkdownFilePath(reference, { ...workspace, root: "C:/repo" })).toBeUndefined();
  });

  it("preserves Windows traversal for the native server's containment checks", () => {
    expect(workspaceMarkdownFilePath("C:\\repo\\..\\outside.md", { ...workspace, root: "C:\\repo" })).toBe("../outside.md");
  });

  it("decodes only once and preserves meaningful filename characters", () => {
    expect(workspaceMarkdownFilePath("./.hidden//%252E%252E/a%20%23%3F%25.txt", workspace)).toBe(".hidden/%2E%2E/a #?%.txt");
  });
});
