export type HistoryScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };
/** Marker top is relative to the viewport's top, not the document or scroll content. */
export type HistoryMarker = { id: string; top: number; bottom: number };
export type HistoryAnchor = { scrollTop: number; markers: Array<{ id: string; top: number }> };
export type HistoryScrollIntent = { kind: "none" } | { kind: "bottom"; behavior: ScrollBehavior } | { kind: "anchor"; anchor: HistoryAnchor };
export type HistoryWindow = {
  start: number; end: number; ids: string[]; visibleCount: number; availableCount: number;
  canLoadOlder: boolean; olderCount: number; newerCount: number; following: boolean;
};

export function captureHistoryAnchor(metrics: HistoryScrollMetrics, markers: readonly HistoryMarker[]): HistoryAnchor {
  return {
    scrollTop: Math.max(0, metrics.scrollTop),
    markers: markers.filter(marker => marker.bottom > 0 && marker.top < metrics.clientHeight)
      .slice(0, 5).map(({ id, top }) => ({ id, top })),
  };
}
export function restoreHistoryAnchor(anchor: HistoryAnchor, metrics: HistoryScrollMetrics, markers: readonly HistoryMarker[]): number {
  for (const previous of anchor.markers) {
    const current = markers.find(marker => marker.id === previous.id);
    if (current) return clampScroll(metrics.scrollTop + current.top - previous.top, metrics);
  }
  // Height deltas include concurrent appends and cannot safely identify a prepend.
  return clampScroll(anchor.scrollTop, metrics);
}
function clampScroll(value: number, metrics: HistoryScrollMetrics) {
  return Math.min(Math.max(0, value), Math.max(0, metrics.scrollHeight - metrics.clientHeight));
}

/** A client render window over already available, chronological task IDs.
 * It never fetches data, creates a backend cursor, or scrolls during render.
 */
export class HistoryViewport {
  private context?: string;
  private capacity: number;
  private following = true;
  private endId?: string;
  private initialized = false;
  private pending: HistoryScrollIntent = { kind: "none" };
  private last: HistoryWindow = { start: 0, end: 0, ids: [], visibleCount: 0, availableCount: 0,
    canLoadOlder: false, olderCount: 0, newerCount: 0, following: true };
  constructor(readonly pageSize = 30, readonly bottomThreshold = 80) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 || !Number.isFinite(bottomThreshold) || bottomThreshold < 0)
      throw new Error("Invalid history viewport limits.");
    this.capacity = pageSize;
  }

  window(context: string, orderedIds: readonly string[]): HistoryWindow {
    if (context !== this.context) {
      this.context = context; this.capacity = this.pageSize; this.following = true;
      this.endId = undefined; this.initialized = false; this.pending = { kind: "none" };
      this.last = { ...this.last, ids: [] };
    }
    if (!orderedIds.length) {
      this.endId = undefined; this.initialized = false;
      this.last = { start: 0, end: 0, ids: [], visibleCount: 0, availableCount: 0,
        canLoadOlder: false, olderCount: 0, newerCount: 0, following: this.following };
      return this.last;
    }
    if (!this.initialized) {
      this.initialized = true; this.following = true;
      this.pending = { kind: "bottom", behavior: "auto" };
    }
    let end = orderedIds.length;
    if (!this.following && this.endId) {
      const index = orderedIds.indexOf(this.endId);
      if (index >= 0) end = index + 1;
      else {
        const surviving = this.last.ids.map(id => orderedIds.indexOf(id)).filter(index => index >= 0);
        if (surviving.length) end = Math.max(...surviving) + 1;
      }
    }
    const start = Math.max(0, end - this.capacity), ids = orderedIds.slice(start, end);
    this.endId = ids.at(-1);
    this.last = { start, end, ids, visibleCount: ids.length, availableCount: orderedIds.length,
      canLoadOlder: start > 0, olderCount: start, newerCount: orderedIds.length - end, following: this.following };
    return this.last;
  }

  /** Return true when the caller should rerender to reveal or freeze the window. */
  observeScroll(metrics: HistoryScrollMetrics): boolean {
    const next = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= this.bottomThreshold;
    if (next === this.following) return false;
    this.following = next;
    if (next) { this.endId = undefined; this.pending = { kind: "bottom", behavior: "auto" }; }
    else if (this.pending.kind === "bottom") this.pending = { kind: "none" };
    return true;
  }
  pauseFollowing(): void {
    this.following = false;
    if (this.pending.kind === "bottom") this.pending = { kind: "none" };
  }
  /** Expands only over data the caller already has, preserving the current end boundary. */
  loadOlder(anchor: HistoryAnchor): boolean {
    if (!this.last.canLoadOlder) return false;
    this.capacity += Math.min(this.pageSize, this.last.olderCount);
    this.following = false;
    this.pending = { kind: "anchor", anchor };
    return true;
  }
  jumpToLatest(smooth = false): void {
    this.following = true; this.endId = undefined;
    this.pending = { kind: "bottom", behavior: smooth ? "smooth" : "auto" };
  }
  /** Call for content/size changes and when a hidden workspace becomes visible. */
  layoutChanged(): void {
    if (this.initialized && this.following && this.pending.kind === "none")
      this.pending = { kind: "bottom", behavior: "auto" };
  }
  /** Consume in a layout effect, never during render. Hidden panes retain their intent. */
  takeScrollIntent(visible = true, reducedMotion = false): HistoryScrollIntent {
    if (!visible) return { kind: "none" };
    const intent = this.pending; this.pending = { kind: "none" };
    return intent.kind === "bottom" && reducedMotion ? { kind: "bottom", behavior: "auto" } : intent;
  }
}

function metricsFor(element: HTMLElement): HistoryScrollMetrics {
  return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
}
function markersFor(element: HTMLElement): HistoryMarker[] {
  const top = element.getBoundingClientRect().top;
  return [...element.querySelectorAll<HTMLElement>('[id^="turn-"]')].map(node => {
    const bounds = node.getBoundingClientRect();
    return { id: node.id, top: bounds.top - top, bottom: bounds.bottom - top };
  });
}
export function captureHistoryElementAnchor(element: HTMLElement): HistoryAnchor {
  return captureHistoryAnchor(metricsFor(element), markersFor(element));
}
export function applyHistoryScrollIntent(element: HTMLElement, intent: HistoryScrollIntent): void {
  if (intent.kind === "bottom") element.scrollTo({ top: element.scrollHeight, behavior: intent.behavior });
  else if (intent.kind === "anchor") element.scrollTo({ top: restoreHistoryAnchor(intent.anchor, metricsFor(element), markersFor(element)), behavior: "auto" });
}
