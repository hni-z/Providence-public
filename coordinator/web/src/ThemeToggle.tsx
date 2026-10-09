import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Moon, Sun } from "lucide-react";
import {
  applyTheme, browserThemePreference, persistThemePreference, preferredTheme,
  THEME_CHANGE_EVENT, THEME_STORAGE_KEY, type Theme,
} from "./theme.js";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function ThemeToggleButton({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return <button type="button" className="theme-toggle" aria-label="Dark theme" aria-pressed={theme === "dark"}
    title={theme === "dark" ? "Use light theme" : "Use dark theme"} onClick={onToggle}>
    {theme === "dark" ? <Moon size={15} aria-hidden="true"/> : <Sun size={15} aria-hidden="true"/>}
    <span>{theme === "dark" ? "Dark" : "Light"}</span>
  </button>;
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const explicit = useRef(browserThemePreference() !== null);
  useBrowserLayoutEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const systemChanged = () => { if (!explicit.current) setTheme(preferredTheme()); };
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      explicit.current = browserThemePreference() !== null;
      setTheme(preferredTheme());
    };
    const localChanged = (event: Event) => {
      const value = (event as CustomEvent<unknown>).detail;
      if (value === "light" || value === "dark") { explicit.current = true; setTheme(value); }
    };
    media?.addEventListener("change", systemChanged);
    window.addEventListener("storage", storageChanged);
    window.addEventListener(THEME_CHANGE_EVENT, localChanged);
    return () => {
      media?.removeEventListener("change", systemChanged);
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener(THEME_CHANGE_EVENT, localChanged);
    };
  }, []);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    explicit.current = true;
    try { persistThemePreference(window.localStorage, next); } catch { /* Preference still applies for this page. */ }
    setTheme(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }
  return <ThemeToggleButton theme={theme} onToggle={toggle}/>;
}
