import type { PiWebPlugin } from "../types";
import { createCoreActions } from "./actions";
import { createCoreMessageActions } from "./messageActions";
import { createCoreNoticesPanel } from "./notices";
export const corePlugin: PiWebPlugin = {
  apiVersion: 5,
  name: "PI WEB Core",
  activate: () => ({
    contributions: {
      actions: createCoreActions(),
      messageActions: createCoreMessageActions(),
      applicationPanels: [createCoreNoticesPanel()],
    },
  }),
};
