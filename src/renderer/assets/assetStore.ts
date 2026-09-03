import type { AssetMeta } from "../../shared/types/object.js";

/**
 * Renderer-side helper for the project-local asset store. Maintains a cache of
 * decoded image data URLs (loaded via the main process bridge). The binaries
 * themselves never live in the renderer or in project JSON — only metadata.
 */
export class AssetStore {
  private projectId: string | null = null;
  private urlCache = new Map<string, string>();

  setProjectId(id: string): void {
    this.projectId = id;
    this.urlCache.clear();
  }

  /** Open a native picker and import the selected file as an asset. */
  async pick(): Promise<AssetMeta | null> {
    if (!this.projectId) return null;
    const result = await window.spatia.pickAsset(this.projectId);
    return result.canceled ? null : result.asset;
  }

  /** Import a specific source path (used by OS drag-and-drop). */
  async importFromPath(sourcePath: string, sourceName?: string): Promise<AssetMeta | null> {
    if (!this.projectId) return null;
    const result = await window.spatia.importAssetFromPath(this.projectId, sourcePath, sourceName);
    return result.canceled ? null : result.asset;
  }

  /** Load (and cache) a data URL for an image asset. Null if unavailable. */
  async dataUrl(assetId: string): Promise<string | null> {
    if (this.urlCache.has(assetId)) return this.urlCache.get(assetId) ?? null;
    if (!this.projectId) return null;
    const url = await window.spatia.readAssetDataUrl(this.projectId, assetId);
    if (url) this.urlCache.set(assetId, url);
    return url;
  }
}
