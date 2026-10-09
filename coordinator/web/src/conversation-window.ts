export const HISTORY_PAGE_SIZE = 20;
/** Render window only; routing and task status retain the complete source collection. */
export function conversationWindow<T extends { id: string }>(items: T[], oldestId?: string, focusId?: string) {
 const retained = oldestId ? items.findIndex(item => item.id === oldestId) : -1;
 let start = retained >= 0 ? retained : Math.max(0, items.length - HISTORY_PAGE_SIZE);
 const focused = focusId ? items.findIndex(item => item.id === focusId) : -1;
 if (focused >= 0) start = Math.min(start, focused);
 return { items: items.slice(start), start, olderCount: start, previousId: items[Math.max(0, start - HISTORY_PAGE_SIZE)]?.id };
}
export function restoredHistoryScroll(beforeHeight: number, beforeTop: number, afterHeight: number) {
 return Math.max(0, beforeTop + afterHeight - beforeHeight);
}
