// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { toSafeMarkdownHtml } from "../formatting/markdown";
import { buildReviewMarkdown } from "./reviewMarkdown";
import type { ReviewComment } from "./reviewTypes";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("renders review end markers as Markdown without exposing HTML wrappers or changing body boundaries", () => {
  const comment: ReviewComment = {
    id: "review-1", anchor: { filePath: "a.ts", source: "files", range: { side: "new", start: 1, end: 2 } },
    body: "**Check this**\n\n- first\n- second\n\n```ts\nconst x = 1;\n```\n\n<small>literal HTML</small>",
    createdAt: 1, updatedAt: 1, sourceHash: "hash",
  };
  const second: ReviewComment = { ...comment, id: "review-2", anchor: { ...comment.anchor, filePath: "b.ts" }, body: "Another comment" };
  const rendered = document.createElement("div");
  rendered.innerHTML = toSafeMarkdownHtml(buildReviewMarkdown([second, comment]));
  expect([...rendered.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["C1: a.ts:1-2 (Files)", "C2: b.ts:1-2 (Files)"]);
  expect([...rendered.querySelectorAll("em")].map((marker) => marker.textContent)).toEqual(["-- end of C1 --", "-- end of C2 --"]);
  expect(rendered.querySelector("strong")?.textContent).toBe("Check this");
  expect(rendered.querySelectorAll("li")).toHaveLength(2);
  expect(rendered.querySelector("pre code")?.textContent).toContain("const x = 1;");
  expect(rendered.textContent).not.toContain("<sub>");
  expect(rendered.textContent).not.toContain("<sup>");
  expect(rendered.textContent).toContain("<small>literal HTML</small>");
  expect(rendered.querySelector("small")).toBeNull();
});
