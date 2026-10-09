import { useEffect, useRef } from "react";
import { Check, MessageSquare, Plus, X } from "lucide-react";
import { deviceConnectionLabel } from "./destination";
import type { Chat, Device } from "./types";

export default function VoiceChatDrawer({ selected, chats, devices, connected, disabled, onSelect, onClose, onNewChat }: {
  selected: string; chats: Chat[]; devices: Device[]; connected: boolean; disabled: boolean;
  onSelect: (id: string) => void; onClose: () => void;
  onNewChat?: () => void;
}) {
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="voice-drawer-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="voice-chat-drawer" ref={drawer} role="dialog" aria-modal="true" aria-label="Choose a conversation"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        if (event.key === "Tab") {
          const focusable = [...(drawer.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
          const first = focusable[0], last = focusable.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <header><h2>Conversations</h2><button type="button" className="icon-button" aria-label="Close conversations" onClick={onClose}><X size={21} /></button></header>
      <nav aria-label="Voice conversations">
        <button type="button" aria-current={selected === "master" ? "page" : undefined} disabled={disabled} onClick={() => onSelect("master")}>
          <MessageSquare size={19} /><span>Superagent</span>{selected === "master" && <Check size={17} />}
        </button>
        {chats.map(chat => {
          const device = devices.find(value => value.id === chat.deviceId);
          return <button type="button" key={chat.id} aria-current={selected === chat.id ? "page" : undefined} disabled={disabled} onClick={() => onSelect(chat.id)}>
            <MessageSquare size={19} /><span>{chat.name}<small>{device?.name ?? "Unavailable computer"} · {deviceConnectionLabel(device, connected)}</small></span>{selected === chat.id && <Check size={17} />}
          </button>;
        })}
      </nav>
      {onNewChat && <footer className="voice-drawer-footer"><button type="button" className="button" disabled={disabled} onClick={onNewChat}>
        <Plus size={18} aria-hidden="true" /> New conversation
      </button></footer>}
    </aside>
  </div>;
}
