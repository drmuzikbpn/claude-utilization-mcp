/**
 * Tiny typed in-process event bus shared by the sessions/pause subsystem (publisher)
 * and the SSE endpoint (consumer). Deliberately dependency-free and synchronous.
 */
export type BusEvents = {
  /** `/v1/limits` minus `raw` — structural so `LimitsSnapshotLite` fits without an import (§19). */
  limits: { fetchedAt: string | null; stale: boolean; error: unknown; limits: unknown[]; legacyWindows: unknown; extraUsage: unknown };
  spend: { today: unknown; delta: unknown };
  session: { type: 'start' | 'end' | 'update'; session: unknown };
  pause: { rules: unknown[]; affected: string[] };
  update: unknown;
};
export type BusEventName = keyof BusEvents;
type Listener<K extends BusEventName> = (payload: BusEvents[K], rev: number) => void;

export class EventBus {
  private listeners = new Map<BusEventName, Set<Listener<BusEventName>>>();
  private _rev = 0;
  /** Monotonic counter bumped on every publish; SSE uses it as the event id. */
  get rev(): number { return this._rev; }
  publish<K extends BusEventName>(name: K, payload: BusEvents[K]): number {
    const rev = ++this._rev;
    for (const l of this.listeners.get(name) ?? []) {
      try { (l as Listener<K>)(payload, rev); } catch { /* listeners must not break publishers */ }
    }
    return rev;
  }
  subscribe<K extends BusEventName>(name: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(name);
    if (!set) { set = new Set(); this.listeners.set(name, set); }
    set.add(listener as Listener<BusEventName>);
    return () => { set?.delete(listener as Listener<BusEventName>); };
  }
}
