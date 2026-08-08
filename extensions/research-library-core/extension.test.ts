import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { registerResearchLibraryTools, researchLibraryExtensionStatus } from "../research-library.js";

describe("research-library Pi extension", () => {
  it("registers only the three bounded sequential tools", () => {
    const tools: { name: string; executionMode: string | undefined }[] = [];
    const registerTool: ExtensionAPI["registerTool"] = (tool) => { tools.push({ name: tool.name, executionMode: tool.executionMode }); };

    registerResearchLibraryTools({ registerTool });

    expect(tools.map((tool) => tool.name)).toEqual([
      "research_library_get_context",
      "research_library_search",
      "research_library_submit_answer_draft",
    ]);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain("research_library_review_answer");
  });

  it("reports fixture and lifecycle state without claiming unregistered tools are ready", () => {
    const ready = researchLibraryExtensionStatus(true, true);
    expect(ready.kind).toBe("info");
    expect(ready.message).toContain("tools are available");
    expect(researchLibraryExtensionStatus(true, false).message).toContain("started without");
    expect(researchLibraryExtensionStatus(false, true).message).toContain("fail closed");
    expect(researchLibraryExtensionStatus(false, false).message).toContain("not registered");
  });
});
