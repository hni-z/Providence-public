import { ArrowUp } from "lucide-react";

/** This describes the bounded client view, not server-side pagination. */
export default function HistoryWindowBar({ shown, available, canLoadOlder, onLoadOlder }: {
  shown: number; available: number; canLoadOlder: boolean; onLoadOlder: () => void;
}) {
  if (!available) return null;
  return <div className="history-window-bar">
    <div>
      <span className="history-window-eyebrow">Conversation history</span>
      <p>{shown} of {available} available {available === 1 ? "request" : "requests"}</p>
    </div>
    {canLoadOlder && <button type="button" className="button history-load-older" onClick={onLoadOlder}>
      <ArrowUp size={14} aria-hidden="true" /> Load older
    </button>}
    <span className="history-window-scope">Earlier requests may not be included.</span>
  </div>;
}
