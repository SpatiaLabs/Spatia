export type Listener<T = void> = (payload: T) => void;

/**
 * Minimal typed emitter used by state stores. Avoids pulling in a full event
 * library and keeps the dependency footprint to zero.
 */
export class Emitter<T = void> {
  private listeners = new Set<Listener<T>>();

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(payload: T): void {
    for (const listener of [...this.listeners]) {
      listener(payload);
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
