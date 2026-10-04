import type { PluginPromptChip, PluginPromptEditor, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { ReviewStore, reviewMarkdown, workspaceKey, type Comment } from "./model.js";

interface Attachment {
  workspace: string;
  target: string;
  id: string;
  prompt: PluginPromptEditor;
  comments: readonly Comment[];
}

/** Activation-owned chip bookkeeping; independent of panel mounting and current selection. */
export class ReviewChips {
  private readonly attachments = new Map<string, Attachment>();
  private readonly pending = new Map<string, object>();
  private readonly epochs = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly store: ReviewStore,
    private readonly notify: (workspace: string, message: string, error?: unknown, kind?: "action" | "acceptance") => void,
  ) {}

  async attach(context: WorkspacePanelContext, isCurrent: () => boolean = () => true): Promise<void> {
    const { state, prompt } = context;
    const session = state?.selectedSession;
    if (session === undefined || session.pending || session.archived || session.cwd !== context.workspace.path
      || state?.selectedMachine?.id !== context.machine.id) {
      throw new Error("Select a ready, unarchived conversation in this workspace before attaching review feedback");
    }
    if (prompt.setChip === undefined || prompt.removeChip === undefined) {
      throw new Error("Code Review requires the PI WEB release containing main's composer-chip API");
    }
    const workspace = workspaceKey(context);
    const target = JSON.stringify([workspace, session.id]);
    const token = {}; this.pending.set(target, token);
    const epoch = this.epochs.get(workspace);
    // Capture ownership before awaiting; never redirect to a new selection.
    let comments: Comment[];
    let latest: boolean;
    try {
      comments = (await this.store.load(workspace)).map((comment) => ({ ...comment }));
      latest = this.pending.get(target) === token;
    } finally {
      if (this.pending.get(target) === token) this.pending.delete(target);
    }
    if (this.disposed || !isCurrent() || !latest || this.epochs.get(workspace) !== epoch
      || workspaceKey(context) !== workspace || context.state?.selectedSession?.id !== session.id
      || context.state.selectedSession.pending || context.state.selectedSession.archived
      || context.state.selectedMachine?.id !== context.machine.id) return;
    if (comments.length === 0) throw new Error("There are no saved comments to attach");
    const attachment: Attachment = {
      workspace,
      target,
      id: `review:${workspace}`,
      prompt,
      comments,
    };
    const chip: PluginPromptChip = {
      id: attachment.id,
      label: `Review (${String(comments.length)})`,
      text: reviewMarkdown(comments),
      onRemove: (reason) => this.settle(attachment, reason),
    };
    // The host binds this facade to its original machine/conversation. No
    // navigation, prompt DOM access, or redirection through live selection.
    prompt.setChip(chip);
    this.attachments.set(attachment.target, attachment);
    this.notify(workspace, "Review attached to this conversation. Send normally; failed sends retain it.");
  }

  /** Called before a local edit/delete. Withdrawal is silent and never deletes durable feedback. */
  withdrawWorkspace(workspace: string): void {
    this.epochs.set(workspace, (this.epochs.get(workspace) ?? 0) + 1);
    for (const [target, attachment] of this.attachments) {
      if (attachment.workspace !== workspace) continue;
      if (attachment.prompt.removeChip === undefined) throw new Error("Composer-chip withdrawal is unavailable");
      attachment.prompt.removeChip(attachment.id);
      this.attachments.delete(target);
    }
  }

  /** Another tab changed saved data. Withdraw this activation's now-outdated copies. */
  storageChanged(workspace?: string): void {
    const workspaces = workspace === undefined
      ? new Set([...this.attachments.values()].map((attachment) => attachment.workspace)) : new Set([workspace]);
    for (const key of workspaces) {
      try {
        this.withdrawWorkspace(key);
        this.notify(key, "Saved feedback changed in another tab. Attach it again before sending.");
      } catch (error) {
        this.notify(key, "Could not withdraw changed feedback. Remove its composer chip before sending.", error);
      }
    }
  }

  dispose(): void {
    this.disposed = true; this.pending.clear();
    for (const workspace of new Set([...this.attachments.values()].map((attachment) => attachment.workspace))) {
      try { this.withdrawWorkspace(workspace); }
      catch (error) { this.notify(workspace, "Could not withdraw review chips during plugin shutdown.", error); }
    }
    this.attachments.clear();
  }

  private async settle(attachment: Attachment, reason: "user" | "submitted"): Promise<void> {
    // A replaced chip's submitted callback still belongs to its older snapshot.
    // Do not forget the newer attachment, or delete feedback edited in flight.
    if (this.disposed) return;
    let replaced = false;
    try {
      if (reason === "submitted") await this.store.removeUnchanged(attachment.workspace, attachment.comments, () => {
        const current = this.attachments.get(attachment.target);
        replaced = current !== undefined && current !== attachment;
        return !this.disposed && !replaced;
      });
      if (this.disposed) return;
      if (this.attachments.get(attachment.target) === attachment) this.attachments.delete(attachment.target);
      this.notify(attachment.workspace, reason === "submitted"
        ? replaced ? "An earlier review was accepted. The newer attached review and saved comments were retained."
          : "Review accepted by the server. Unchanged submitted comments were cleared; later edits were retained."
        : "Review detached from the composer. Saved comments were retained.");
    } catch (error) {
      if (!this.disposed) this.notify(attachment.workspace, "The review was accepted, but saved feedback could not be cleared. Check the conversation before attaching it again.", error, "acceptance");
      throw error; // The host also logs callback failures with the plugin owner identity.
    }
  }
}
