import type { WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { SelectionService } from "./selection.js";
import { reviewMarkdown, workspaceKey, type Comment } from "./model.js";

/** Public prompt insertion is not a send acknowledgement. Never delete the source comments. */
export async function insertFeedback(context: WorkspacePanelContext, selection: SelectionService | undefined, comments: readonly Comment[], signal?: AbortSignal): Promise<void> {
  if (selection === undefined) throw new Error("Update PI WEB for selection-safe prompt insertion, or copy the feedback instead");
  const target = selection.getSnapshot();
  const session = target.selectedSession;
  const matches = () => {
    const current = selection.getSnapshot();
    return signal?.aborted !== true && current.selectedMachine?.id === context.machine.id
      && current.selectedWorkspace !== undefined
      && workspaceKey({ machine: context.machine, workspace: current.selectedWorkspace }) === workspaceKey(context)
      && current.selectedSession?.id === session?.id && current.selectedSession?.pending === false
      && !current.selectedSession.archived && current.selectedSession.cwd === context.workspace.path;
  };
  if (session === undefined || !matches()) throw new Error("Select an existing, unarchived session in this workspace first");
  const markdown = reviewMarkdown(comments);
  if (markdown === "") throw new Error("There are no saved comments to insert");
  await context.navigate({ machineId: context.machine.id, projectId: context.workspace.projectId, workspaceId: context.workspace.id, sessionId: session.id, view: "chat" });
  if (!matches()) throw new Error("Selection changed; feedback was not inserted");
  if (context.prompt.getSelection() !== null) throw new Error("Deselect the highlighted prompt text before inserting feedback, or copy it instead");
  const before = context.prompt.getText();
  context.prompt.insertText(`\n\n${markdown}\n`);
  const after = context.prompt.getText();
  if (after === before || !after.includes(markdown)) throw new Error("Prompt insertion could not be confirmed. Open the chat editor and retry, or copy the feedback");
}
