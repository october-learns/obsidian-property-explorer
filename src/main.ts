import { Plugin } from 'obsidian';
import {
  VIEW_TYPE_Property_EXPLORER,
  PropertyExplorerView,
} from './PropertyExplorerView';

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class PropertyExplorer extends Plugin {

  async onload(): Promise<void> {

    this.registerView(
      VIEW_TYPE_Property_EXPLORER,
      (leaf) => new PropertyExplorerView(leaf, this),
    );

    this.addCommand({
      id: 'open-explorer-pane',
      name: 'Open explorer pane',
      callback: () => this.activateView(),
    });

    this.app.workspace.onLayoutReady(() => {
      void this.initView();
    });
  }

  onunload(): void {
    
  }

  // ─── View management ───────────────────────────────────────────────────────
 
  /** Creates the leaf in the right sidebar if it doesn't exist yet, without focusing it. */
  private async initView(): Promise<void> {
    const { workspace } = this.app;
 
    if (workspace.getLeavesOfType(VIEW_TYPE_Property_EXPLORER).length > 0) {
      return;
    }
 
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
 
    await leaf.setViewState({
      type: VIEW_TYPE_Property_EXPLORER,
      active: false, 
    });
  }
 
  async activateView(): Promise<void> {
    const { workspace } = this.app;
 
    const existing = workspace.getLeavesOfType(VIEW_TYPE_Property_EXPLORER);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]!);
      return;
    }
 
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
 
    await leaf.setViewState({
      type: VIEW_TYPE_Property_EXPLORER,
      active: true,
    });
 
    await workspace.revealLeaf(leaf);
  }
 
}