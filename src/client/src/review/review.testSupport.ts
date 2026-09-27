import type { WorkspaceReview } from "../../../plugin-api";

/** Inert review service for panels whose tests do not exercise review authoring. */
export function inactiveReview(): WorkspaceReview {
  return {
    total: () => 0,
    countForFile: () => 0,
    commentsForLine: () => [],
    draftForLine: () => null,
    lineState: () => ({ selected: false, commented: false }),
    canAuthor: () => false,
    beginSelection: () => undefined,
    extendSelection: () => undefined,
    commitSelection: () => undefined,
    cancelSelection: () => undefined,
    setDraftBody: () => undefined,
    submitDraft: () => undefined,
    cancelDraft: () => undefined,
    updateComment: () => undefined,
    removeComment: () => undefined,
  };
}
