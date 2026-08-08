import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import { researchLibraryPanelVisible } from "./fixtureCache.js";
import { defineResearchLibraryPanelElement } from "./researchLibraryPanelElement.js";

const plugin: PiWebPlugin = {
  apiVersion: 1,
  name: "Research Library (Synthetic Preview)",
  activate: ({ html, svg }) => {
    defineResearchLibraryPanelElement();

    return {
      contributions: {
        workspacePanels: [
          {
            id: "workspace.research-library",
            title: "Research",
            icon: svg`
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22z"></path>
                <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22z"></path>
                <path d="m16 8 1 1 2-2"></path>
              </svg>
            `,
            order: 60,
            visible: (context) => researchLibraryPanelVisible(context),
            render: (context) => html`<pi-web-research-library-panel .context=${context}></pi-web-research-library-panel>`,
          },
        ],
      },
    };
  },
};

export default plugin;
