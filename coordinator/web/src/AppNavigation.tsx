import { useEffect, useRef, useState } from "react";
import { Box, History, LogOut, MessageSquare, Monitor, Plus, Search, UserRound, X } from "lucide-react";
import type { Chat } from "./types";

export default function AppNavigation(props: {
  open: boolean; close: () => void; selected: string; chats: Chat[];
  select: (id: string) => void; newChat: () => void; devices: () => void; activity: () => void;
  deviceName: (id: string) => string; hosted: boolean; online: number;
  logout: () => void; signingOut: boolean;
}) {
  const [query, setQuery] = useState("");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!props.open || !window.matchMedia("(max-width: 800px)").matches) return;
    const previous = document.activeElement as HTMLElement | null;
    const links = () => Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input") ?? []);
    const focusFrame = requestAnimationFrame(() => links()[0]?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.close();
      if (event.key !== "Tab") return;
      const items = links(), first = items[0], last = items.at(-1);
      if (!root.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { cancelAnimationFrame(focusFrame); document.removeEventListener("keydown", key); previous?.focus(); };
  }, [props.open]);
  const select = (id: string) => { props.select(id); props.close(); };
  return <>
    {props.open && <button className="navigation-scrim" aria-label="Close navigation" onClick={props.close} tabIndex={-1} />}
    <aside ref={root} className={`app-navigation${props.open ? " is-open" : ""}`} aria-label="Providence navigation" id="app-navigation">
      <div className="navigation-brand"><a href="/" aria-label="Providence home"><img src="/favicon.svg?v=3" alt="" />Providence</a>
        <button className="icon-button navigation-close" onClick={props.close} aria-label="Close navigation"><X size={20} /></button></div>
      <button className="navigation-new" onClick={() => { props.newChat(); props.close(); }}><Plus size={18} />New chat</button>
      <nav className="navigation-primary" aria-label="Main">
        <button className={props.selected === "master" ? "selected" : ""} onClick={() => select("master")}><MessageSquare size={18} />Chat</button>
        <button onClick={() => { props.devices(); props.close(); }}><Monitor size={18} />Devices<span className="navigation-count">{props.online}</span></button>
        {props.hosted && <a href="/meta"><Box size={18} />Spatial view<span className="navigation-beta">Preview</span></a>}
      </nav>
      <div className="navigation-recent"><div className="navigation-section-title">Your chats</div>
        {props.chats.length > 6 && <label className="navigation-search"><Search size={15} /><input aria-label="Search chats" placeholder="Find a chat" value={query} onChange={e => setQuery(e.target.value)} /></label>}
        <nav aria-label="Your chats">{props.chats.filter(chat => chat.name.toLowerCase().includes(query.toLowerCase())).map(chat =>
          <button key={chat.id} className={props.selected === chat.id ? "selected" : ""} onClick={() => select(chat.id)} title={chat.name}>
            <span>{chat.name}<small>{props.deviceName(chat.deviceId)}</small></span>
          </button>)}
          {!props.chats.length && <p className="navigation-empty">Your conversations will appear here.</p>}
        </nav>
      </div>
      <div className="navigation-account">
        <button onClick={() => { props.activity(); props.close(); }}><History size={18} />Activity</button>
        {props.hosted && <a href="/account"><UserRound size={18} /><span>Account<small>Profile & settings</small></span></a>}
        <button onClick={props.logout} disabled={props.signingOut}><LogOut size={17} />{props.signingOut ? "Signing out…" : props.hosted ? "Sign out" : "Lock workspace"}</button>
      </div>
    </aside>
  </>;
}
