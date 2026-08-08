import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  registerLocalPilotResearchLibraryTools,
  registerResearchLibraryTools,
  researchLibraryExtensionStatus,
} from "../research-library.js";

describe("research-library Pi extension", () => {
  it("registers only the three historical bounded synthetic tools", () => {
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

  it("registers only read-only pilot tools for real pilot content", () => {
    const tools: { name: string; description: string; promptSnippet: string | undefined; executionMode: string | undefined }[] = [];
    const registerTool: ExtensionAPI["registerTool"] = (tool) => {
      tools.push({ name: tool.name, description: tool.description, promptSnippet: tool.promptSnippet, executionMode: tool.executionMode });
    };

    registerLocalPilotResearchLibraryTools({ registerTool });

    expect(tools.map((tool) => tool.name)).toEqual([
      "research_library_list_papers",
      "research_library_list_annotations",
      "research_library_get_annotation",
    ]);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
    expect(tools.every((tool) => !tool.description.toLowerCase().includes("insert"))).toBe(true);
    expect(tools.every((tool) => tool.promptSnippet?.toLowerCase().includes("prompt") !== true)).toBe(true);
  });

  it("reports mutually exclusive source and lifecycle state", () => {
    const ready = researchLibraryExtensionStatus({ syntheticValid: true, pilotValid: false, toolsRegistered: true, registeredMode: "synthetic" });
    expect(ready.kind).toBe("info");
    expect(ready.message).toContain("Synthetic");

    const pilot = researchLibraryExtensionStatus({ syntheticValid: false, pilotValid: true, toolsRegistered: true, registeredMode: "local-pilot" });
    expect(pilot.kind).toBe("info");
    expect(pilot.message).toContain("Local pilot read tools");

    expect(researchLibraryExtensionStatus({ syntheticValid: true, pilotValid: true, toolsRegistered: false }).message).toContain("refuses");
    expect(researchLibraryExtensionStatus({ syntheticValid: false, pilotValid: true, toolsRegistered: false }).message).toContain("started without");
    expect(researchLibraryExtensionStatus({ syntheticValid: false, pilotValid: false, toolsRegistered: false }).message).toContain("not registered");
  });
});
