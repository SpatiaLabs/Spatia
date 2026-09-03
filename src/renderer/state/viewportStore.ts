import type { ViewportState } from "../../shared/types/project.js";
import { DEFAULT_ZOOM } from "../../shared/geometry/viewport.js";
import { Emitter } from "./emitter.js";

/**
 * Owns the camera/viewport state (world position + zoom). This is intentionally
 * separate from project/document state so that camera movement never triggers
 * application-wide re-renders — the canvas subscribes to this store directly.
 */
export class ViewportStore {
  private state: ViewportState = { x: 0, y: 0, zoom: DEFAULT_ZOOM };
  readonly changed = new Emitter<ViewportState>();

  get(): ViewportState {
    return { ...this.state };
  }

  getZoom(): number {
    return this.state.zoom;
  }

  set(next: ViewportState): void {
    this.state = { ...next };
    this.changed.emit(this.get());
  }

  reset(): void {
    this.state = { x: 0, y: 0, zoom: DEFAULT_ZOOM };
    this.changed.emit(this.get());
  }
}
