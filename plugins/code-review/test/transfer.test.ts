import { describe, expect, it, vi } from "vitest";
import { insertFeedback } from "../src/browser/transfer.js";
import { context, savedComment } from "./context.js";

describe("explicit feedback handoff", () => {
  it("navigates to the exact session, inserts Markdown, and does not mutate comments", async () => {
    const ctx = context(); let text = "Please review";
    ctx.prompt = { insertText: (value) => { text += value; }, getText: () => text, getSelection: () => null };
    const comments = [savedComment];
    await insertFeedback(ctx, { getSnapshot: () => ctx.state ?? {} }, comments);
    expect(ctx.navigate).toHaveBeenCalledWith({ machineId: "local", projectId: "p", workspaceId: "w", sessionId: "s", view: "chat" });
    expect(text).toContain("Please review\n\n### Code review comments (1)");
    expect(comments).toEqual([savedComment]);
  });
  it("does not insert into a new selection after async navigation", async () => {
    const ctx = context();
    const insert = vi.fn(); ctx.prompt.insertText = insert;
    ctx.navigate = vi.fn(() => { ctx.state = {}; return Promise.resolve(); });
    await expect(insertFeedback(ctx, { getSnapshot: () => ctx.state ?? {} }, [savedComment])).rejects.toThrow("Selection changed");
    expect(insert).not.toHaveBeenCalled();
  });
  it("does not insert after the plugin lifetime ends during navigation", async () => {
    const ctx = context(); const lifetime = new AbortController(); const insert = vi.fn();
    ctx.prompt.insertText = insert;
    ctx.navigate = () => { lifetime.abort(); return Promise.resolve(); };
    await expect(insertFeedback(ctx, { getSnapshot: () => ctx.state ?? {} }, [savedComment], lifetime.signal)).rejects.toThrow("Selection changed");
    expect(insert).not.toHaveBeenCalled();
  });
  it("rejects a missing editor, old host, and selected prompt text rather than claiming success", async () => {
    const ctx = context(); const selection = { getSnapshot: () => ctx.state ?? {} };
    await expect(insertFeedback(ctx, undefined, [savedComment])).rejects.toThrow("Update PI WEB");
    await expect(insertFeedback(ctx, selection, [savedComment])).rejects.toThrow("could not be confirmed");
    ctx.prompt.getSelection = () => ({ start: 0, end: 1, text: "x" });
    await expect(insertFeedback(ctx, selection, [savedComment])).rejects.toThrow("Deselect");
  });
  it.each(["pending", "archived", "workspace"])("rejects %s targets", async (reason) => {
    const ctx = context();
    const session = ctx.state?.selectedSession;
    if (session === undefined) throw new Error("Missing session fixture");
    if (reason === "workspace") session.cwd = "/other";
    else if (reason === "pending") session.pending = true;
    else session.archived = true;
    await expect(insertFeedback(ctx, { getSnapshot: () => ctx.state ?? {} }, [savedComment])).rejects.toThrow("Select an existing");
    expect(ctx.navigate).not.toHaveBeenCalled();
  });
});
