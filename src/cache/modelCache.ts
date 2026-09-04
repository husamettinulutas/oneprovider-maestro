import * as vscode from 'vscode';
import { ProcessedModel, CacheMetadata } from '../types/models';
import { Logger } from '../utils/logger';

const CACHE_KEY = 'oneprovider-model-cache';
const CACHE_META_KEY = 'oneprovider-cache-meta';

/** Bump when ProcessedModel changes shape so stale entries are refetched. */
const CACHE_VERSION = '1';

/**
 * Model list cache, held in memory and mirrored into globalState so the browser
 * paints instantly on startup instead of waiting on the network.
 */
export class ModelCache {
  private inMemoryModels: ProcessedModel[] = [];

  constructor(private readonly globalState: vscode.Memento) {}

  getModels(): ProcessedModel[] {
    return this.inMemoryModels;
  }

  hasModels(): boolean {
    return this.inMemoryModels.length > 0;
  }

  async loadFromDisk(): Promise<ProcessedModel[]> {
    try {
      const meta = this.getMetadata();
      if (meta && meta.version !== CACHE_VERSION) {
        Logger.info(`Ignoring model cache version ${meta.version} (current ${CACHE_VERSION})`);
        return [];
      }

      const cached = this.globalState.get<ProcessedModel[]>(CACHE_KEY);
      if (Array.isArray(cached) && cached.length > 0) {
        this.inMemoryModels = cached;
        Logger.info(`Loaded ${cached.length} models from cache`);
        return cached;
      }
    } catch (error) {
      Logger.warn('Failed to load models from cache', error);
    }
    return [];
  }

  /** Seed the in-memory list without persisting it (bundled catalog fallback). */
  seed(models: ProcessedModel[]): void {
    if (this.inMemoryModels.length === 0) {
      this.inMemoryModels = models;
    }
  }

  async saveModels(models: ProcessedModel[]): Promise<void> {
    this.inMemoryModels = models;

    const meta: CacheMetadata = {
      lastUpdated: Date.now(),
      modelCount: models.length,
      version: CACHE_VERSION,
    };

    await this.globalState.update(CACHE_KEY, models);
    await this.globalState.update(CACHE_META_KEY, meta);
    Logger.info(`Cached ${models.length} models`);
  }

  getMetadata(): CacheMetadata | undefined {
    return this.globalState.get<CacheMetadata>(CACHE_META_KEY);
  }

  /** Number of live (key-verified) models currently cached. */
  liveCount(): number {
    return this.inMemoryModels.filter((m) => m.live).length;
  }

  isStale(): boolean {
    const meta = this.getMetadata();
    if (!meta) {
      return true;
    }
    const ttlMinutes = vscode.workspace
      .getConfiguration('oneproviderMaestro')
      .get<number>('cache.ttlMinutes', 60);
    return Date.now() - meta.lastUpdated > ttlMinutes * 60 * 1000;
  }

  async clear(): Promise<void> {
    this.inMemoryModels = [];
    await this.globalState.update(CACHE_KEY, undefined);
    await this.globalState.update(CACHE_META_KEY, undefined);
    Logger.info('Cache cleared');
  }

  getModel(id: string): ProcessedModel | undefined {
    return this.inMemoryModels.find((m) => m.id === id);
  }

  getBrands(): string[] {
    return [...new Set(this.inMemoryModels.map((m) => m.productFamily))].sort();
  }
}
