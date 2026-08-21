import { describe, expect, it } from "vitest";
import type { CommandOption, SessionModelCatalogEntry } from "../api";
import { filterModelOptions, modelCatalogEntryValue, modelCatalogToggleAllPlan, modelCatalogView } from "./ModelPicker";

function entry(provider: string, id: string, enabled: boolean, name?: string): SessionModelCatalogEntry {
  return { provider, id, enabled, ...(name === undefined ? {} : { name }) };
}

const catalog: SessionModelCatalogEntry[] = [
  entry("openai", "gpt-5", true),
  entry("anthropic", "claude-sonnet-4-5", true, "Claude Sonnet 4.5"),
  entry("openai", "gpt-4o", false),
  entry("google", "gemini-2.5-pro", false),
];

describe("filterModelOptions", () => {
  it("returns the options untouched in order for a blank query", () => {
    const options: CommandOption[] = [{ value: "openai/gpt-5", label: "gpt-5" }, { value: "anthropic/claude", label: "claude", description: "anthropic" }];

    expect(filterModelOptions(options, "  ")).toEqual(options);
  });

  it("matches label, description, and value case-insensitively and preserves order", () => {
    const options: CommandOption[] = [
      { value: "openai/gpt-5", label: "gpt-5", description: "openai" },
      { value: "anthropic/claude", label: "claude", description: "anthropic" },
      { value: "google/gemini", label: "gemini", description: "google" },
    ];

    expect(filterModelOptions(options, "ANTHROPIC").map((option) => option.value)).toEqual(["anthropic/claude"]);
    expect(filterModelOptions(options, "openai/g").map((option) => option.value)).toEqual(["openai/gpt-5"]);
    expect(filterModelOptions(options, "gpt").map((option) => option.value)).toEqual(["openai/gpt-5"]);
  });
});

describe("modelCatalogToggleAllPlan", () => {
  it("narrows any non-empty multi-model selection to the current model", () => {
    expect(modelCatalogToggleAllPlan(catalog, "openai/gpt-5")).toEqual({
      mode: "current",
      canApply: true,
      hasChanges: true,
    });
  });

  it("selects every model when none or only the current model is enabled", () => {
    const disabledCatalog = catalog.map((row) => ({ ...row, enabled: false }));
    const onlyCurrentCatalog = disabledCatalog.map((row) => ({ ...row, enabled: modelCatalogEntryValue(row) === "openai/gpt-5" }));

    expect(modelCatalogToggleAllPlan(disabledCatalog, "openai/gpt-5")).toEqual({ mode: "all", canApply: true, hasChanges: true });
    expect(modelCatalogToggleAllPlan(onlyCurrentCatalog, "openai/gpt-5")).toEqual({ mode: "all", canApply: true, hasChanges: true });
  });

  it("cannot narrow the scope when the current model is unavailable", () => {
    expect(modelCatalogToggleAllPlan(catalog, "missing/model")).toEqual({ mode: "current", canApply: false, hasChanges: false });
  });
});

describe("modelCatalogView", () => {
  it("keeps the server's enabled-first order for a blank query and shows group headers for a mixed list", () => {
    const view = modelCatalogView(catalog, "");

    expect(view.rows.map(modelCatalogEntryValue)).toEqual(["openai/gpt-5", "anthropic/claude-sonnet-4-5", "openai/gpt-4o", "google/gemini-2.5-pro"]);
    expect(view.showGroupHeaders).toBe(true);
  });

  it("filters by provider, id, and display name case-insensitively, preserving catalog order", () => {
    expect(modelCatalogView(catalog, "gpt").rows.map(modelCatalogEntryValue)).toEqual(["openai/gpt-5", "openai/gpt-4o"]);
    expect(modelCatalogView(catalog, "GOOGLE").rows.map(modelCatalogEntryValue)).toEqual(["google/gemini-2.5-pro"]);
    expect(modelCatalogView(catalog, "sonnet 4.5").rows.map(modelCatalogEntryValue)).toEqual(["anthropic/claude-sonnet-4-5"]);
  });

  it("hides group headers while searching or when only one group exists", () => {
    expect(modelCatalogView(catalog, "gpt").showGroupHeaders).toBe(false);
    expect(modelCatalogView(catalog.map((row) => ({ ...row, enabled: true })), "").showGroupHeaders).toBe(false);
    expect(modelCatalogView(catalog.map((row) => ({ ...row, enabled: false })), "").showGroupHeaders).toBe(false);
    expect(modelCatalogView([], "").showGroupHeaders).toBe(false);
  });
});
