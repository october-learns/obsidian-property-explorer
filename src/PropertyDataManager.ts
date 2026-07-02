import { App, TFile } from 'obsidian';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ValueEntry {
  value: string;
  files: TFile[];
}

export interface PropertyEntry {
  key: string;  
  type: string; 
  noteCount: number;  
  values: Map<string, ValueEntry>;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface FilePropData {
  key: string;
  values: string[];
}

// ─── PropertyDataManager ──────────────────────────────────────────────────────

export class PropertyDataManager {
  refreshTypes() {
    throw new Error('Method not implemented.');
  }
  private readonly app: App | undefined;

  private index = new Map<string, PropertyEntry>();

  private fileIndex = new Map<string, FilePropData[]>();

  constructor(app: App) {
    this.app = app;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /** Full vault scan. Call once on plugin load / settings change. */
  async buildIndex(): Promise<void> {
    this.index.clear();
    this.fileIndex.clear();

    const files = this.app.vault.getMarkdownFiles();

    // Process in batches to avoid blocking the UI thread on large vaults
    const BATCH = 50;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(files.slice(i, i + BATCH).map(f => this.indexFile(f)));
    }
  }

  async updateFile(file: TFile): Promise<void> {
    this.removeFileFromIndex(file);
    await this.indexFile(file);
  }

  removeFile(file: TFile): void {
    this.removeFileFromIndex(file);
  }

  renameFile(file: TFile, oldPath: string): void {
    const props = this.fileIndex.get(oldPath);
    if (props) {
      this.fileIndex.delete(oldPath);
      this.fileIndex.set(file.path, props);
    }
  }

  getEntries(): PropertyEntry[] {
    return Array.from(this.index.values());
  }

  // ─── Indexing ──────────────────────────────────────────────────────────────

  private async indexFile(file: TFile): Promise<void> {
    const props = await this.extractProperty(file);
    if (props.length === 0) return;

    this.fileIndex.set(file.path, props);

    for (const { key, values } of props) {
      if (!this.index.has(key)) {
        this.index.set(key, {
          key,
          type: this.getPropertyType(key),
          noteCount: 0,
          values: new Map(),
        });
      }

      const entry = this.index.get(key)!;
      entry.noteCount++; 

      for (const value of values) {
        if (!entry.values.has(value)) {
          entry.values.set(value, { value, files: [] });
        }
        entry.values.get(value)!.files.push(file);
      }
    }
  }

  private removeFileFromIndex(file: TFile): void {
    const oldProps = this.fileIndex.get(file.path);
    if (!oldProps) return;

    for (const { key, values } of oldProps) {
      const entry = this.index.get(key);
      if (!entry) continue;

      entry.noteCount = Math.max(0, entry.noteCount - 1);

      for (const value of values) {
        const valEntry = entry.values.get(value);
        if (valEntry) {
          valEntry.files = valEntry.files.filter(f => f.path !== file.path);
          if (valEntry.files.length === 0) {
            entry.values.delete(value);
          }
        }
      }

      if (entry.noteCount === 0) {
        this.index.delete(key);
      }
    }

    this.fileIndex.delete(file.path);
  }

  // ─── Property extraction ───────────────────────────────────────────────────

  private async extractProperty(file: TFile): Promise<FilePropData[]> {
    const accumulated = new Map<string, Set<string>>();

    const addValues = (key: string, values: string[]) => {
      if (!accumulated.has(key)) accumulated.set(key, new Set());
      const set = accumulated.get(key)!;
      values.forEach(v => set.add(v));
    };

    // 1. Frontmatter via metadataCache (fast — no file read needed)
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter) {
      for (const [key, rawValue] of Object.entries(cache.frontmatter)) {
        if (key === 'position') continue;
        addValues(key, this.normaliseValue(rawValue));
      }
    }

    const result: FilePropData[] = [];
    for (const [key, valSet] of accumulated) {
      result.push({ key, values: Array.from(valSet) });
    }
    return result;
  }

  private normaliseValue(raw: unknown): string[] {
    if (raw === null || raw === undefined) return [EMPTY_VALUE];
    if (Array.isArray(raw)) {
      const flat = raw.flatMap(v => this.normaliseValue(v));
      return flat.length > 0 ? flat : [EMPTY_VALUE];
    }
    const str = String(raw).trim();
    return str.length > 0 ? [str] : [EMPTY_VALUE];
  }


  // ─── Type resolution ───────────────────────────────────────────────────────

  private getPropertyType(key: string): string {

    interface PropertyInfo {
      type?: string;
    }
    interface MetadataTypeManager {
      getPropertyInfo?: (key: string) => PropertyInfo | undefined;
      properties?: Record<string, PropertyInfo>;
      property?:   Record<string, PropertyInfo>;
    }
    interface AppWithTypeManager {
      metadataTypeManager?: MetadataTypeManager;
    }

    try {
      const { metadataTypeManager: tm } = this.app as unknown as AppWithTypeManager;
      if (!tm) return 'text';
 
      if (typeof tm.getPropertyInfo === 'function') {
        const info = tm.getPropertyInfo(key);
        if (info?.type) return info.type;
      }
 
      // Fallback: direct map (older builds) — keys are always lowercase
      const map = tm.properties ?? tm.property;
      const info = map?.[key.toLowerCase()];
      if (info?.type) return info.type;
    } catch { /* empty */ }
    return 'text';
  }
}

export const EMPTY_VALUE = '(empty)';