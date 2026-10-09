import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { persistThemePreference, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from "../web/src/theme.js";

test("theme preference overrides system appearance and rejects unrelated stored values", () => {
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme("not-a-theme", false), "light");
  assert.equal(readThemePreference({ getItem: () => "system" }), null);
});

test("only the nonsecret theme key is read or persisted; blocked storage degrades gracefully", () => {
  const calls: unknown[] = [];
  const storage = {
    getItem: (key: string) => { calls.push(["read", key]); return "dark"; },
    setItem: (key: string, value: string) => { calls.push(["write", key, value]); },
  };
  assert.equal(readThemePreference(storage), "dark");
  assert.equal(persistThemePreference(storage, "light"), true);
  assert.deepEqual(calls, [["read", THEME_STORAGE_KEY], ["write", THEME_STORAGE_KEY, "light"]]);
  assert.equal(readThemePreference({ getItem: () => { throw new Error("Unavailable"); } }), null);
  assert.equal(persistThemePreference({ setItem: () => { throw new Error("Unavailable"); } }, "dark"), false);
});

test("theme switch is a visible native keyboard button with an announced state in either theme", async () => {
  const require = createRequire(new URL("../web/package.json", import.meta.url));
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { ThemeToggleButton } = await tsImport("../web/src/ThemeToggle.tsx", { parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../web/tsconfig.json", import.meta.url)) });
  for (const theme of ["light", "dark"]) {
    const html = renderToStaticMarkup(React.createElement(ThemeToggleButton, { theme, onToggle: () => {} }));
    assert.match(html, /<button type="button"/);
    assert.match(html, /aria-label="Dark theme"/);
    assert.ok(html.includes(`aria-pressed="${theme === "dark"}"`));
    assert.ok(html.includes(theme === "dark" ? ">Dark<" : ">Light<"));
    assert.equal(html.includes("providence.session"), false);
  }
});
