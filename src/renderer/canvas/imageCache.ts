/**
 * Caches decoded HTMLImageElement objects for the renderer. Rendering an image
 * (dragging it onto the canvas) fetches a data URL from the main process and
 * decodes it once; subsequent frames reuse the cached element.
 */
export class ImageCache {
  private cache = new Map<string, HTMLImageElement | null>();

  clear(): void {
    this.cache.clear();
  }

  has(assetId: string): boolean {
    return this.cache.has(assetId);
  }

  get(assetId: string): HTMLImageElement | null {
    return this.cache.get(assetId) ?? null;
  }

  /** Provide a HTMLImageElement now (on the fly). */
  provide(assetId: string, img: HTMLImageElement | null): void {
    this.cache.set(assetId, img);
  }

  /** Decode a data URL to an element and cache it. Returns a promise. */
  load(assetId: string, dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.cache.set(assetId, img);
        resolve(img);
      };
      img.onerror = () => {
        this.cache.set(assetId, null);
        reject(new Error("Failed to decode image asset"));
      };
      img.src = dataUrl;
    });
  }

  /** Remove a cached entry so the next `load` re-decodes the source. */
  invalidate(assetId: string): void {
    this.cache.delete(assetId);
  }
}
