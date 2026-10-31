import { html } from "lit";
import type { AppState } from "../appState";
import type { Workspace } from "../api";
import type { PiWebPluginRegistration, PluginAction, PluginRuntimeContext, QualifiedContributionId, QualifiedPluginAction, QualifiedThemeContribution, QualifiedThemePairContribution, QualifiedWorkspaceLabelContribution, QualifiedWorkspacePanelContribution, ThemeContribution, ThemePairContribution, WorkspaceLabelContribution, WorkspaceLabelItem, WorkspacePanelContribution } from "./types";

const idPattern = /^[a-z][a-z0-9.-]*$/u;
const localIdPattern = /^[a-z][a-z0-9.-]*$/u;

type RegisteredPluginAction = Omit<PluginAction, "id"> & {
  id: QualifiedContributionId;
  pluginId: string;
  localId: string;
};

export class PluginRegistry {
  private readonly actions: RegisteredPluginAction[] = [];
  private readonly workspacePanels: QualifiedWorkspacePanelContribution[] = [];
  private readonly workspaceLabels: QualifiedWorkspaceLabelContribution[] = [];
  private readonly themes: QualifiedThemeContribution[] = [];
  private readonly themePairs: QualifiedThemePairContribution[] = [];
  private readonly pluginIds = new Set<string>();
  private readonly contributionIds = new Set<QualifiedContributionId>();

  private readonly disposers = new Map<string, () => void>();

  constructor(private readonly onDisposeError: (id: string, error: unknown) => void = (id, error) => {
    console.warn(`Failed to dispose PI WEB plugin ${id}`, error);
  }) {}

  register(registration: PiWebPluginRegistration): void {
    if (this.pluginIds.has(registration.id)) throw new Error(`Duplicate plugin id: ${registration.id}`);
    this.replace(registration);
  }

  /** Validate a fresh activation before removing the previous plugin's contributions. */
  replace(registration: PiWebPluginRegistration): void {
    const staged = new PluginRegistry(this.onDisposeError);
    try {
      staged.activate(registration);
    } catch (error) {
      staged.dispose();
      throw error;
    }
    this.unregister(registration.id);
    this.pluginIds.add(registration.id);
    for (const id of staged.contributionIds) this.contributionIds.add(id);
    for (const [id, dispose] of staged.disposers) this.disposers.set(id, dispose);
    this.actions.push(...staged.actions);
    this.workspacePanels.push(...staged.workspacePanels);
    this.workspaceLabels.push(...staged.workspaceLabels);
    this.themes.push(...staged.themes);
    this.themePairs.push(...staged.themePairs);
  }

  unregister(id: string): void {
    this.pluginIds.delete(id);
    for (const contributions of [this.actions, this.workspacePanels, this.workspaceLabels, this.themes, this.themePairs]) {
      for (let index = contributions.length - 1; index >= 0; index--) {
        if (contributions[index]?.pluginId === id) contributions.splice(index, 1);
      }
    }
    for (const contributionId of this.contributionIds) {
      if (contributionId.startsWith(`${id}:`)) this.contributionIds.delete(contributionId);
    }
    const dispose = this.disposers.get(id);
    this.disposers.delete(id);
    try {
      dispose?.();
    } catch (error) {
      this.onDisposeError(id, error);
    }
  }

  dispose(): void {
    for (const id of [...this.pluginIds]) this.unregister(id);
  }

  private activate({ id, plugin }: PiWebPluginRegistration): void {
    this.validatePluginId(id);
    const apiVersion: unknown = plugin.apiVersion;
    if (apiVersion !== 1) throw new Error(`Unsupported plugin API version for ${id}: ${String(apiVersion)}`);
    const result = plugin.activate({ apiVersion: 1, pluginId: id, html });
    this.pluginIds.add(id);
    if (result.dispose !== undefined) this.disposers.set(id, () => result.dispose?.());
    const contributions = result.contributions;
    for (const action of contributions.actions ?? []) this.actions.push(this.qualifyAction(id, action));
    for (const panel of contributions.workspacePanels ?? []) this.workspacePanels.push(this.qualifyWorkspacePanel(id, panel));
    for (const contribution of contributions.workspaceLabels ?? []) this.workspaceLabels.push(this.qualifyWorkspaceLabelContribution(id, contribution));
    for (const theme of contributions.themes ?? []) this.themes.push(this.qualifyTheme(id, theme));
    for (const pair of contributions.themePairs ?? []) this.themePairs.push(this.qualifyThemePair(id, pair));
  }

  getActions(context: PluginRuntimeContext): QualifiedPluginAction[] {
    return this.actions.map((action) => {
      const enabled = action.enabled?.(context);
      const qualified: QualifiedPluginAction = {
        id: action.id,
        pluginId: action.pluginId,
        localId: action.localId,
        title: action.title,
        run: () => action.run(context),
      };
      if (action.description !== undefined) qualified.description = action.description;
      if (action.shortcut !== undefined) qualified.shortcut = action.shortcut;
      if (action.group !== undefined) qualified.group = action.group;
      if (enabled !== undefined) qualified.enabled = enabled;
      return qualified;
    });
  }

  getWorkspacePanels(): QualifiedWorkspacePanelContribution[] {
    return [...this.workspacePanels].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.title.localeCompare(right.title));
  }

  getThemes(): QualifiedThemeContribution[] {
    return [...this.themes].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getThemePairs(): QualifiedThemePairContribution[] {
    return [...this.themePairs].sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.name.localeCompare(right.name));
  }

  getWorkspaceLabelItems(state: AppState, workspace: Workspace): WorkspaceLabelItem[] {
    const context = { state, workspace };
    return [...this.workspaceLabels]
      .sort((left, right) => (left.order ?? 1000) - (right.order ?? 1000) || left.id.localeCompare(right.id))
      .flatMap((contribution) => {
        if (contribution.visible?.(context) === false) return [];
        return contribution.items(context);
      });
  }

  private qualifyAction(pluginId: string, action: PluginAction): RegisteredPluginAction {
    const id = this.qualify(pluginId, action.id);
    return { ...action, id, pluginId, localId: action.id };
  }

  private qualifyWorkspacePanel(pluginId: string, panel: WorkspacePanelContribution): QualifiedWorkspacePanelContribution {
    const id = this.qualify(pluginId, panel.id);
    return { ...panel, id, pluginId, localId: panel.id };
  }

  private qualifyWorkspaceLabelContribution(pluginId: string, contribution: WorkspaceLabelContribution): QualifiedWorkspaceLabelContribution {
    const id = this.qualify(pluginId, contribution.id);
    return { ...contribution, id, pluginId, localId: contribution.id };
  }

  private qualifyTheme(pluginId: string, theme: ThemeContribution): QualifiedThemeContribution {
    const id = this.qualify(pluginId, theme.id);
    return { ...theme, id, pluginId, localId: theme.id };
  }

  private qualifyThemePair(pluginId: string, pair: ThemePairContribution): QualifiedThemePairContribution {
    const id = this.qualify(pluginId, pair.id);
    return {
      ...pair,
      id,
      pluginId,
      localId: pair.id,
      light: this.qualifyReference(pluginId, pair.light),
      dark: this.qualifyReference(pluginId, pair.dark),
    };
  }

  private qualify(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    const qualified: QualifiedContributionId = `${pluginId}:${localId}`;
    if (this.contributionIds.has(qualified)) throw new Error(`Duplicate contribution id: ${qualified}`);
    this.contributionIds.add(qualified);
    return qualified;
  }

  private qualifyReference(pluginId: string, localId: string): QualifiedContributionId {
    this.validateLocalId(localId);
    return `${pluginId}:${localId}`;
  }

  private validatePluginId(pluginId: string): void {
    if (!idPattern.test(pluginId)) throw new Error(`Invalid plugin id: ${pluginId}`);
  }

  private validateLocalId(localId: string): void {
    if (!localIdPattern.test(localId)) throw new Error(`Invalid contribution id: ${localId}`);
  }
}
