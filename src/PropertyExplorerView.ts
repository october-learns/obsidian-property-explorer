import {
  ItemView, WorkspaceLeaf, TFile,
  TAbstractFile, setIcon, Menu, debounce, Events
} from 'obsidian';
import { PropertyDataManager, PropertyEntry, ValueEntry, EMPTY_VALUE } from './PropertyDataManager';
import type PropertyExplorer from './main';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VIEW_TYPE_Property_EXPLORER = 'property-explorer';
 
type SortMode = 'name-asc' | 'name-desc' | 'freq-desc' | 'freq-asc';
type SearchScope = 'any' | 'key' | 'value' | 'note';
 
const SORT_CONFIG: { mode: SortMode; label: string; icon: string }[] = [
  { mode: 'name-asc',  label: 'Name (A → Z)',          icon: 'sort-asc'  },
  { mode: 'name-desc', label: 'Name (Z → A)',           icon: 'sort-desc' },
  { mode: 'freq-desc', label: 'Frequency (High → Low)', icon: 'arrow-down-wide-narrow' },
  { mode: 'freq-asc',  label: 'Frequency (Low → High)', icon: 'arrow-up-narrow-wide'  },
];
 
/** Maps Obsidian property type strings to Lucide icon names. */
const TYPE_ICONS: Record<string, string> = {
  text:       'type',
  multitext:  'list',
  number:     'hash',
  checkbox:   'check-square',
  date:       'calendar',
  datetime:   'calendar-clock',
  aliases:    'forward',
  tags:       'tags',
};
 
const SCOPE_OPTIONS: { value: SearchScope; label: string }[] = [
  { value: 'any',   label: 'Any (key, value & note)' },
  { value: 'key',   label: 'Key only' },
  { value: 'value', label: 'Value only' },
  { value: 'note',  label: 'Note title only' },
];
 

// ─── PropertyExplorerView ───────────────────────────────────────────────────

export class PropertyExplorerView extends ItemView {
  private readonly plugin: PropertyExplorer;
  readonly dataManager: PropertyDataManager;

  // ── UI state
  private searchQuery = '';
  private searchScope: SearchScope = 'any';
  private sortMode: SortMode = 'freq-desc';

  // ── Expand/collapse state (persists across re-renders)
  private expandedProps  = new Set<string>();
  private expandedValues = new Set<string>(); // composite key: "propKey\x00value"

  // ── DOM refs
  private listEl!:    HTMLElement;
  private loadingEl!: HTMLElement;
  private sortBtn!:   HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: PropertyExplorer) {
    super(leaf);
    this.plugin = plugin;
    this.dataManager = new PropertyDataManager(plugin.app);
  }

  // ─── ItemView overrides ──────────────────────────────────────────────────

  getViewType():    string { return VIEW_TYPE_Property_EXPLORER; }
  getDisplayText(): string { return 'Property explorer'; }
  getIcon():        string { return 'tags'; }

  async onOpen(): Promise<void> {
    this.buildStaticUI();
    this.registerVaultEvents();
    this.loadingEl.show();
    const cache = this.app.metadataCache;
 
    const buildWhenReady = () => {
      void this.loadData();
    };
 
    const ref = cache.on('resolved', () => {
      cache.offref(ref);
      buildWhenReady();
    });
    this.registerEvent(ref);
 
    this.app.workspace.onLayoutReady(() => {
      const alreadyResolved = Object.keys(cache.resolvedLinks).length > 0
        || (cache as unknown as { initialized?: boolean }).initialized === true;
      if (alreadyResolved) {
        cache.offref(ref);   
        buildWhenReady();
      }
    });
  }

  async onClose(): Promise<void> {
    // this.app.workspace.unregisterHoverLinkSource(VIEW_TYPE_Property_EXPLORER);

    (this.app.workspace as any).unregisterHoverLinkSource(VIEW_TYPE_Property_EXPLORER);
    this.expandedValues.clear();
  }

  // ─── Public ──────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    this.expandedProps.clear();
    this.expandedValues.clear();
    await this.loadData();
  }

  // ─── Static UI construction ───────────────────────────────────────────────

  private buildStaticUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('pe-root');

    this.buildToolbar(root);

    this.loadingEl = root.createDiv({ cls: 'pe-loading' });
    setIcon(this.loadingEl.createDiv('pe-loading-icon'), 'loader');
    this.loadingEl.createSpan({ text: 'Indexing vault…' });
    this.loadingEl.hide();

    this.listEl = root.createDiv('pe-list');
  }

  private buildToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv('pe-toolbar');

    // ── Row 1: search input + sort button ──────────────────────────────────
    const searchRow = toolbar.createDiv('pe-search-row');

    // Search input wrapper
    const searchWrap = searchRow.createDiv('pe-search-wrap');
    const searchIcon = searchWrap.createDiv('pe-search-icon');
    setIcon(searchIcon, 'search');

    const searchInput = searchWrap.createEl('input', {
      cls: 'pe-search-input',
      // attr: { type: 'text', placeholder: 'Search property…', spellcheck: 'false' },
      attr: { placeholder: 'Search property…', spellcheck: 'false' },
    });

    // Clear button
    const clearBtn = searchWrap.createDiv({ cls: 'pe-search-clear', attr: { 'aria-label': 'Clear search' } });
    setIcon(clearBtn, 'x');
    clearBtn.hide();
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      this.searchQuery = '';
      clearBtn.hide();
      this.renderList();
      searchInput.focus();
    });

    searchInput.addEventListener('input', debounce(() => {
      this.searchQuery = searchInput.value.trim();
      if (this.searchQuery) clearBtn.show(); else clearBtn.hide();
      this.renderList();
    }, 150, true));

    // Sort button
    this.sortBtn = searchRow.createDiv({
      cls: 'pe-sort-btn clickable-icon',
      attr: { 'aria-label': 'Sort property' },
    });
    setIcon(this.sortBtn, 'arrow-up-down');
    this.sortBtn.addEventListener('click', (e) => this.showSortMenu(e));

    // ── Row 2: search scope selector ────────────────────────────────────────
    const scopeRow = toolbar.createDiv('pe-scope-row');
    const scopeLabel = scopeRow.createEl('label', { cls: 'pe-scope-label', text: 'Search in:' });
    const scopeId = 'pe-scope-select';
    scopeLabel.setAttribute('for', scopeId);

    const scopeSelect = scopeRow.createEl('select', { cls: 'pe-scope-select', attr: { id: scopeId } });
    for (const opt of SCOPE_OPTIONS) {
      scopeSelect.createEl('option', { value: opt.value, text: opt.label });
    }
    scopeSelect.addEventListener('change', () => {
      this.searchScope = scopeSelect.value as SearchScope;
      this.renderList();
    });
  }

  // ─── Data loading ─────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    this.loadingEl.show();
    this.listEl.empty();
    await this.dataManager.buildIndex();
    this.loadingEl.hide();
    this.renderList();
  }

  // ─── Event registration ───────────────────────────────────────────────────

  private registerVaultEvents(): void {
    const onChanged = debounce(async (file: TFile) => {
      if (file.extension !== 'md') return;
      await this.dataManager.updateFile(file);
      this.renderList();
    }, 500, true);

    this.registerEvent(this.app.metadataCache.on('changed', onChanged));

    this.registerEvent(this.app.vault.on('delete', (abstractFile: TAbstractFile) => {
      if (!(abstractFile instanceof TFile) || abstractFile.extension !== 'md') return;
      this.dataManager.removeFile(abstractFile);
      this.renderList();
    }));

    this.registerEvent(this.app.vault.on('rename', (abstractFile: TAbstractFile, oldPath: string) => {
      if (!(abstractFile instanceof TFile) || abstractFile.extension !== 'md') return;
      this.dataManager.renameFile(abstractFile, oldPath);
      this.renderList();
    }));

    const typeManager = (this.app as unknown as { metadataTypeManager?: Events }).metadataTypeManager;
    if (typeManager) {
      this.registerEvent(typeManager.on('changed', () => {
        this.dataManager.refreshTypes();
        this.renderList();
      }));
    }

    this.app.workspace.registerHoverLinkSource(VIEW_TYPE_Property_EXPLORER, {
      defaultMod: true,
      display: 'Property Explorer',
    });
  }


  // ─── Sort menu ────────────────────────────────────────────────────────────

  private showSortMenu(e: MouseEvent): void {
    const menu = new Menu();
    for (const { mode, label } of SORT_CONFIG) {
      menu.addItem(item => {
        item.setTitle(label);
        if (this.sortMode === mode) item.setChecked(true);
        item.onClick(() => {
          this.sortMode = mode;
          this.renderList();
        });
      });
    }
    menu.showAtMouseEvent(e);
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  private renderList(): void {
    this.listEl.empty();

    const entries = this.getFilteredSorted();

    if (entries.length === 0) {
      const empty = this.listEl.createDiv('pe-empty');
      setIcon(empty.createDiv('pe-empty-icon'), this.searchQuery ? 'search-x' : 'inbox');
      empty.createDiv({
        cls: 'pe-empty-text',
        text: this.searchQuery
          ? `No property match "${this.searchQuery}"`
          : 'No property found in this vault.',
      });
      return;
    }

    const frag = activeDocument.createDocumentFragment();
    for (const entry of entries) {
      frag.appendChild(this.buildPropertyEl(entry));
    }
    this.listEl.appendChild(frag);
  }

  // ─── Property row (Level 1) ───────────────────────────────────────────────

  private buildPropertyEl(entry: PropertyEntry): HTMLElement {
    const isExpanded = this.expandedProps.has(entry.key);
    const wrap = createDiv('pe-prop-wrap');

    // Header
    const header = wrap.createDiv('pe-prop-header');
    if (isExpanded) header.addClass('is-expanded');

    const chevron = header.createDiv('pe-chevron');
    setIcon(chevron, 'chevron-right');

    // const typeIcon = header.createDiv('pe-type-icon');
    // setIcon(typeIcon, TYPE_ICONS[entry.type] ?? 'type');
    // typeIcon.setAttribute('aria-label', entry.type);

    this.highlightText(
      header.createDiv('pe-prop-key'),
      entry.key,
      this.searchScope === 'key' || this.searchScope === 'any',
    );

    header.createDiv({ cls: 'pe-count', text: String(entry.noteCount) });

    header.addEventListener('click', () => {
      if (isExpanded) this.expandedProps.delete(entry.key);
      else            this.expandedProps.add(entry.key);
      this.renderList();
    });

    // Children
    if (isExpanded) {
      const childWrap = wrap.createDiv('pe-children-wrap');
      for (const valEntry of this.getSortedValues(entry)) {
        childWrap.appendChild(this.buildValueEl(entry.key, valEntry));
      }
    }

    return wrap;
  }

  // ─── Value row (Level 2) ─────────────────────────────────────────────────

  private buildValueEl(propKey: string, valEntry: ValueEntry): HTMLElement {
    const expandKey = `${propKey}\x00${valEntry.value}`;
    const isExpanded = this.expandedValues.has(expandKey);
    const wrap = createDiv('pe-value-wrap');

    // Header
    const header = wrap.createDiv('pe-value-header');
    if (isExpanded) header.addClass('is-expanded');

    const chevron = header.createDiv('pe-chevron');
    setIcon(chevron, 'chevron-right');

    const isEmptyVal = valEntry.value === EMPTY_VALUE;
    const valueEl = header.createDiv({ cls: `pe-value-text${isEmptyVal ? ' is-empty' : ''}` });
    this.highlightText(
      valueEl,
      valEntry.value,
      this.searchScope === 'value' || this.searchScope === 'any',
    );

    header.createDiv({ cls: 'pe-count', text: String(valEntry.files.length) });

    header.addEventListener('click', () => {
      if (isExpanded) this.expandedValues.delete(expandKey);
      else            this.expandedValues.add(expandKey);
      this.renderList();
    });

    // Children
    if (isExpanded) {
      const childWrap = wrap.createDiv('pe-children-wrap');
      const files = this.getFilteredNotes(valEntry.files);
      const sorted = [...files].sort((a, b) => a.basename.localeCompare(b.basename));
      for (const file of sorted) {
        childWrap.appendChild(this.buildNoteEl(file));
      }
      if (sorted.length === 0 && this.searchQuery) {
        childWrap.createDiv({ cls: 'pe-no-notes', text: 'No notes match search.' });
      }
    }

    return wrap;
  }

  // ─── Note row (Level 3) ──────────────────────────────────────────────────

  private buildNoteEl(file: TFile): HTMLElement {
    const row = createDiv('pe-note-row');

    const noteIcon = row.createDiv('pe-note-icon');
    setIcon(noteIcon, 'file-text');

    const nameEl = row.createDiv('pe-note-name');
    this.highlightText(
      nameEl,
      file.basename,
      this.searchScope === 'note' || this.searchScope === 'any',
    );

    // Show folder path as secondary info if note is not in root
    if (file.parent && file.parent.path !== '/') {
      row.createDiv({ cls: 'pe-note-path', text: file.parent.path });
    }

    row.addEventListener('click', () => {
      void this.app.workspace.getLeaf(false).openFile(file);
    });

    // Page Preview integration
    row.addEventListener('mouseover', (e) => {
      this.app.workspace.trigger('hover-link', {
        event: e,
        source:       VIEW_TYPE_Property_EXPLORER,
        hoverParent:  row,
        targetEl:     row,
        linktext:     file.path,
      });
    });

    return row;
  }

  // ─── Filter & sort ────────────────────────────────────────────────────────

  private getFilteredSorted(): PropertyEntry[] {
    let entries = this.dataManager.getEntries();

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      entries = entries.filter(e => this.entryMatchesSearch(e, q));
    }

    entries.sort((a, b) => {
      switch (this.sortMode) {
        case 'name-asc':  return a.key.localeCompare(b.key);
        case 'name-desc': return b.key.localeCompare(a.key);
        case 'freq-desc': return b.noteCount - a.noteCount;
        case 'freq-asc':  return a.noteCount - b.noteCount;
      }
    });

    return entries;
  }

  private entryMatchesSearch(entry: PropertyEntry, q: string): boolean {
    const scope = this.searchScope;

    if (scope === 'any' || scope === 'key') {
      if (entry.key.toLowerCase().includes(q)) return true;
    }

    if (scope === 'any' || scope === 'value') {
      for (const [v] of entry.values) {
        if (v.toLowerCase().includes(q)) return true;
      }
    }

    if (scope === 'any' || scope === 'note') {
      for (const valEntry of entry.values.values()) {
        for (const file of valEntry.files) {
          if (file.basename.toLowerCase().includes(q)) return true;
        }
      }
    }

    return false;
  }

  /** Sort values by file count descending; when searching by value, matched values float to top. */
  private getSortedValues(entry: PropertyEntry): ValueEntry[] {
    const values = Array.from(entry.values.values());

    if (this.searchQuery && (this.searchScope === 'value' || this.searchScope === 'any')) {
      const q = this.searchQuery.toLowerCase();
      values.sort((a, b) => {
        const aMatch = a.value.toLowerCase().includes(q) ? 0 : 1;
        const bMatch = b.value.toLowerCase().includes(q) ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return b.files.length - a.files.length;
      });
    } else {
      values.sort((a, b) => b.files.length - a.files.length);
    }

    return values;
  }

  /** Filter note list to those matching search when scope includes notes. */
  private getFilteredNotes(files: TFile[]): TFile[] {
    if (!this.searchQuery || this.searchScope === 'key' || this.searchScope === 'value') {
      return files;
    }
    const q = this.searchQuery.toLowerCase();
    return files.filter(f => f.basename.toLowerCase().includes(q));
  }

  // ─── Search highlighting ──────────────────────────────────────────────────

  
  private highlightText(el: HTMLElement, text: string, shouldHighlight: boolean): void {
    if (!this.searchQuery || !shouldHighlight) {
      el.textContent = text;
      return;
    }

    const q = this.searchQuery.toLowerCase();
    const idx = text.toLowerCase().indexOf(q);
    if (idx === -1) {
      el.textContent = text;
      return;
    }

    el.createSpan({ text: text.slice(0, idx) });
    el.createEl('mark', { cls: 'pe-highlight', text: text.slice(idx, idx + q.length) });
    el.createSpan({ text: text.slice(idx + q.length) });
  }
}