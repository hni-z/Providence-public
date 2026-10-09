export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "providence.theme";
export const THEME_CHANGE_EVENT = "providence-theme-change";
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

export function resolveTheme(preference: unknown, prefersDark: boolean): Theme {
  return preference === "light" || preference === "dark" ? preference : prefersDark ? "dark" : "light";
}
export function readThemePreference(storage?: Pick<ThemeStorage, "getItem">): Theme | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}
export function persistThemePreference(storage: Pick<ThemeStorage, "setItem"> | undefined, theme: Theme): boolean {
  try { if (!storage) return false; storage.setItem(THEME_STORAGE_KEY, theme); return true; }
  catch { return false; }
}
export function browserThemePreference(): Theme | null {
  try { return typeof window === "undefined" ? null : readThemePreference(window.localStorage); }
  catch { return null; }
}
export function preferredTheme(): Theme {
  const prefersDark = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveTheme(browserThemePreference(), prefersDark);
}
/** Browser chrome tint per theme, matching the page canvas behind it. */
export const THEME_COLORS: Record<Theme, string> = {
  light: "#ffffff",
  dark: "#0b0b0b",
};
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  // The toggle overrides the system preference, so a media-scoped meta in the
  // document would leave the address bar on the wrong colour.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
}
/** Optional pre-render bootstrap. Reads only the nonsecret theme preference. */
export function initializeTheme(): Theme {
  const theme = preferredTheme();
  applyTheme(theme);
  return theme;
}
