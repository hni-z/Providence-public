import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const compiled = (name: string) => ts.transpileModule(readFileSync(new URL(`../web/src/${name}.ts`, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sources = { account: compiled("account"), refresh: compiled("account-refresh"), security: compiled("account-security"), theme: compiled("theme"), data: compiled("account-data") };
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" } as Record<string, string>)[name]!);
const device = (id = "fixture-computer") => ({ id, name: "Kitchen laptop", platform: "darwin", online: true, workerAccess: "full-access" });

// A small DOM fixture runs the real page, refresh helper and security helper.
// Fetch is fully synthetic; there are no passkeys, keys, timers or network calls.
function fixture(options: { devices?: unknown[]; keyConfigured?: boolean; platform?: string; search?: string; confirm?: boolean; clearResponse?: { ok: boolean; status?: number; body: unknown }; sessionResponse?: unknown; devicesResponse?: unknown; deletionResponse?: unknown; aiConsentResponse?: unknown; authError?: Error; hash?: string; authenticated?: boolean } = {}) {
  let focused: Element | undefined;
  class Element {
    children: Element[] = []; parent: Element | undefined; listeners = new Map<string, ((event: any) => void)[]>();
    attributes: Record<string, string>; text = ""; open = false; disabled = false; selectionStart = 0; selectionEnd = 0; selectionDirection = "none"; isContentEditable = false;
    constructor(public tagName = "DIV", attrs: Record<string, string> = {}) {
      this.attributes = attrs; this.open = "open" in attrs; this.disabled = "disabled" in attrs;
    }
    get id() { return this.attributes.id ?? ""; }
    get value() { return this.textContent; }
    get readOnly() { return "readonly" in this.attributes; }
    get hidden() { return "hidden" in this.attributes; }
    get dataset() { return Object.fromEntries(Object.entries(this.attributes).filter(([key]) => key.startsWith("data-")).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value])); }
    get textContent(): string { return this.text + this.children.map(child => child.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    matches(selector: string) { const attr = /^\[([^\]]+)\]$/.exec(selector); return attr ? attr[1]! in this.attributes : this.tagName.toLowerCase() === selector; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
    contains(element: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
    addEventListener(name: string, fn: (event: any) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]); }
    focus() { focused = this; }
    select() { this.focus(); this.selectionStart = 0; this.selectionEnd = this.value.length; }
    setSelectionRange(start: number, end: number, direction: string) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
    click() { this.focus(); if (!this.disabled) for (const fn of this.listeners.get("click") ?? []) fn({ currentTarget: this, preventDefault() {} }); }
  }
  class Textarea extends Element {}
  class Input extends Element {}
  class Select extends Element {}
  let html = "";
  const root = new Element("DIV", { id: "account-root" });
  Object.defineProperty(root, "innerHTML", { set(value: string) {
    html = value; root.children = []; root.text = "";
    const stack = [root];
    for (const token of value.match(/<[^>]+>|[^<]+/g) ?? []) {
      if (token.startsWith("</")) { stack.pop(); continue; }
      const tag = /^<([a-z][\w-]*)\b([^>]*)>/i.exec(token);
      if (!tag) { stack.at(-1)!.text += decode(token); continue; }
      const attrs = Object.fromEntries([...tag[2]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1]!, decode(match[2] ?? "")]));
      const Type = tag[1] === "textarea" ? Textarea : tag[1] === "input" ? Input : tag[1] === "select" ? Select : Element;
      const element = new Type(tag[1]!.toUpperCase(), attrs); element.parent = stack.at(-1)!; element.parent.children.push(element);
      if (!/^(input|img|br|hr|meta|link)$/.test(tag[1]!)) stack.push(element);
    }
  } });
  const find = (id: string): Element | null => id === root.id ? root : all(root).find(element => element.id === id) ?? null;
  function all(element: Element): Element[] { return element.children.flatMap(child => [child, ...all(child)]); }
  const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => null, visibilityState: "visible", get activeElement() { return focused; }, hasFocus: () => true, getSelection: () => null,
    getElementById: find, querySelectorAll: (selector: string) => root.querySelectorAll(selector), addEventListener() {}, removeEventListener() {} };
  const navigations: string[] = [];
  const confirmations: string[] = [];
  let confirmResult = options.confirm ?? true;
  const window = { location: { assign: (path: string) => navigations.push(path), reload: () => navigations.push("reload") }, scrollX: 0, scrollY: 240, scrollTo(x: number, y: number) { this.scrollX = x; this.scrollY = y; }, addEventListener() {}, removeEventListener() {}, confirm: (message: string) => { confirmations.push(message); return confirmResult; } };
  const calls: { path: string; method: string; body?: any; credentials?: string; headers?: Record<string, string> }[] = [], auth: any[] = [];
  let sessionOverride = options.sessionResponse;
  let authenticated = options.authenticated ?? true, listedDevices = options.devices ?? [], clipboardFailure = false, copied = "";
  const keyConfigured = options.keyConfigured ?? false;
  const timers: (() => void)[] = [];
  const removedStorage: string[] = [];
  const context = createContext({ document, window, location: { search: options.search ?? "", hash: options.hash ?? "" }, sessionStorage: { removeItem(key: string) { removedStorage.push(key); } },
    navigator: { platform: options.platform ?? "MacIntel", userAgent: "fixture", clipboard: { async writeText(text: string) { if (clipboardFailure) throw new Error("clipboard denied"); copied = text; } } },
    HTMLElement: Element, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLSelectElement: Select,
    URLSearchParams, AbortSignal, AbortController, setInterval: (fn: () => void) => { timers.push(fn); return fn; }, clearInterval() {},
    fetch: async (path: string, init: any = {}) => {
      const call = { path, method: init.method ?? "GET", credentials: init.credentials, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call);
      let value: unknown;
      if (path === "/auth/session") value = sessionOverride ?? { authenticated, name: "Alex", keyConfigured };
      else if (path === "/auth/devices") value = options.devicesResponse ?? { devices: listedDevices };
      else if (path === "/auth/security") value = { passkeys: [], sessions: [] };
      else if (path.startsWith("/auth/setup?")) value = { userCode: "ABCD-EFGH", status: "pending", expiresAt: new Date(Date.now() + 120_000).toISOString() };
      else if (path === "/auth/ai-consent") {
        value = options.aiConsentResponse ?? { accepted: true, version: "2026-10-02" };
        if ((value as any).accepted === true && sessionOverride && typeof sessionOverride === "object") sessionOverride = { ...sessionOverride, aiConsentRequired: false };
      }
      else if (path === "/auth/account/delete") value = options.deletionResponse ?? { deleted: true, accessRevoked: true, cleanupPending: false, externalApiKeyRevoked: false, localFilesDeleted: false };
      else if (path === "/auth/chats/clear") return { ok: options.clearResponse?.ok ?? true, status: options.clearResponse?.status ?? 200, json: async () => options.clearResponse?.body ?? { cleared: true } };
      else if (path === "/auth/login/options") value = { challenge: "synthetic-login" };
      else if (path === "/auth/login/verify") {
        authenticated = true;
        if (sessionOverride && typeof sessionOverride === "object") sessionOverride = { ...sessionOverride, authenticated: true };
        value = {};
      }
      else if (path === "/auth/logout") { authenticated = false; value = {}; }
      else if (path === "/auth/step-up/options") value = { challenge: "synthetic-only" };
      else if (path === "/auth/step-up/verify") value = { stepUpToken: "synthetic-proof" };
      else if (path === "/v1/clients/pair") value = { code: "SYNTHETIC-WATCH-CODE" };
      else if (path === "/auth/setup/approve") value = {};
      else throw new Error(`Unexpected fixture request: ${call.method} ${path}`);
      return { ok: true, json: async () => value };
    },
  });
  const load = (source: string) => runInContext(`(function(exports) { ${source}\nreturn exports; })({})`, context);
  const fixtureAuthError = options.authError;
  const modules: Record<string, any> = {
    "./account-data": load(sources.data), "./theme": load(sources.theme), "./account-refresh": load(sources.refresh), "./account-security": load(sources.security), "./account.css": {},
    "./activity": { startActivityReporting: () => () => {} },
    "@simplewebauthn/browser": { startAuthentication: async (options: unknown) => { auth.push(options); if (fixtureAuthError) throw fixtureAuthError; return { id: "synthetic-passkey" }; }, startRegistration: async () => { throw new Error("Not exercised"); } },
  };
  context.require = (name: string) => { assert.ok(name in modules, `Unknown account import ${name}`); return modules[name]; };
  load(sources.account);
  const settle = async () => { for (let attempt = 0; attempt < 40; attempt++) await Promise.resolve(); };
  const click = async (id: string) => { const element = find(id); assert.ok(element, `Missing #${id}`); element.click(); await settle(); };
  return { root, find, document, window, calls, auth, navigations, removedStorage, confirmations, confirm: (value: boolean) => { confirmResult = value; }, click, settle, html: () => html, copied: () => copied,
    clipboardFail: () => { clipboardFailure = true; }, devices: (value: unknown[]) => { listedDevices = value; },
    automaticRefresh: async () => { focused = undefined; for (const tick of timers) tick(); await settle(); },
  };
}

test("first computer setup is open, terminal-only and uses the selected platform", async () => {
  const page = fixture(); await page.settle();
  assert.equal(page.find("computer-setup")?.hidden, false);
  assert.equal(page.find("add-computer")?.getAttribute("aria-expanded"), "true");
  assert.ok(page.html().indexOf("Your computers") < page.html().indexOf("Add a computer"));
  assert.equal(page.root.querySelectorAll("input").length, 0, "account page must not ask for a browser API key");
  assert.match(page.find("install-command")!.value, /curl --proto '=https' --tlsv1.2 -fsS .*install\.sh \| sh$/);
  assert.equal(page.find("account-key")?.open, false);
  assert.equal(page.find("account-security")?.open, false);
  assert.match(page.find("device-capabilities")!.textContent, /Accessibility/);
  assert.doesNotMatch(page.find("device-capabilities")!.textContent, /native pipe/);
  await page.click("install-platform-windows");
  assert.match(page.find("install-command")!.value, /irm -MaximumRedirection 0 .*install\.ps1/);
  assert.match(page.find("device-capabilities")!.textContent, /native pipe/);
  assert.doesNotMatch(page.find("device-capabilities")!.textContent, /Accessibility/);
  await page.click("copy-command"); assert.equal(page.copied(), page.find("install-command")!.value);
  page.clipboardFail(); await page.click("copy-command");
  assert.equal(page.document.activeElement, page.find("install-command"));
  assert.equal(page.find("install-command")!.selectionEnd, page.find("install-command")!.value.length);
  assert.equal(page.calls.filter(call => call.method !== "GET").length, 0);
});

test("returning account opens setup on demand and keeps reading position across refresh", async () => {
  const page = fixture({ devices: [device()], keyConfigured: true }); await page.settle();
  assert.equal(page.find("computer-setup")?.hidden, true);
  assert.match(page.root.textContent, /Open your workspace/);
  assert.equal(page.root.querySelectorAll("[data-remove-device]").length, 1);
  assert.ok(page.find("uninstall"), "uninstall stays reachable without opening Add computer");
  await page.click("add-computer");
  assert.equal(page.find("computer-setup")?.hidden, false);
  assert.equal(page.document.activeElement, page.find("install-command"));
  page.find("uninstall")!.open = true;
  await page.click("install-platform-linux");
  assert.equal(page.find("uninstall")?.open, true);
  assert.match(page.find("device-capabilities")!.textContent, /graphical session and compatible tools/);
  assert.doesNotMatch(page.find("device-capabilities")!.textContent, /Accessibility|native pipe/);
  await page.click("refresh-devices");
  assert.equal(page.find("uninstall")?.open, true);
  assert.equal(page.document.activeElement, page.find("refresh-devices"));
  assert.equal(page.window.scrollY, 240);
  await page.click("close-setup");
  assert.equal(page.find("computer-setup")?.hidden, true);
  assert.equal(page.document.activeElement, page.find("add-computer"));
  await page.automaticRefresh();
  assert.equal(page.find("computer-setup")?.hidden, true);
});

test("automatic readiness updates keep open setup and never carry an old Watch code", async () => {
  const page = fixture({ keyConfigured: true }); await page.settle();
  page.find("watch-pairing")!.open = true;
  await page.click("watch");
  assert.equal(page.find("watch-code")!.textContent, "SYNTHETIC-WATCH-CODE");
  assert.equal(page.auth.length, 1);
  assert.deepEqual(page.calls.filter(call => call.method === "POST").map(call => call.path), ["/auth/step-up/options", "/auth/step-up/verify", "/v1/clients/pair"]);
  assert.equal(page.calls.at(-1)!.body.stepUpToken, "synthetic-proof");
  page.devices([device()]); await page.automaticRefresh();
  assert.equal(page.find("computer-setup")?.hidden, false);
  assert.equal(page.find("watch-pairing")?.open, true);
  assert.equal(page.find("watch-code")!.textContent, "");
  assert.equal(page.find("status")!.textContent, "");
  assert.match(page.root.textContent, /Online/);
});

test("terminal approval stays explicit and code-bound, before secondary setup", async () => {
  const page = fixture({ search: "?setup=ABCD-EFGH" }); await page.settle();
  assert.equal(page.find("computer-setup")?.hidden, true);
  assert.ok(page.html().indexOf("Does this code match") < page.html().indexOf("Your computers"));
  assert.equal(page.calls.filter(call => call.method === "POST").length, 0);
  await page.click("approve-setup");
  assert.equal(page.auth.length, 1);
  const options = page.calls.find(call => call.path === "/auth/step-up/options")!;
  assert.deepEqual(options.body, { action: "approve_setup", target: "ABCD-EFGH" });
  const approval = page.calls.find(call => call.path === "/auth/setup/approve")!;
  assert.deepEqual(approval.body, { code: "ABCD-EFGH", stepUpToken: "synthetic-proof" });
  assert.match(page.root.textContent, /Return to your terminal to finish setup/);
});

test("key replacement uses its terminal mode and sign-out removes account controls", async () => {
  const page = fixture({ devices: [device()], keyConfigured: true, platform: "Win32" }); await page.settle();
  await page.click("configure-key");
  assert.equal(page.find("computer-setup")?.hidden, false);
  assert.match(page.find("install-command")!.value, / -ConfigureKey$/);
  await page.click("show-install");
  assert.doesNotMatch(page.find("install-command")!.value, /ConfigureKey/);
  await page.click("logout");
  assert.equal(page.find("computer-setup"), null);
  assert.equal(page.find("watch"), null);
  assert.ok(page.find("signin"));
});


test("Windows uninstall copies the in-memory child PowerShell entry with interactive defaults", async () => {
  const page = fixture({ devices: [device()], keyConfigured: true, platform: "Win32" }); await page.settle();
  const expected = String.raw`& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command '$ErrorActionPreference=''Stop''; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.providence\companion\uninstall.ps1'')))); exit $LASTEXITCODE'`;
  const input = page.find("uninstall-command")!;
  assert.equal(input.value, expected);
  assert.doesNotMatch(expected, /uninstall\.cmd|ExecutionPolicy|Start-Process|-Yes|-AllowOffline/);
  assert.equal((expected.match(/"/g) ?? []).length, 2, "only the executable path uses double quotes; the child program avoids native marshalling of them");
  assert.match(expected, /-Command '\$ErrorActionPreference=''Stop'';/);
  assert.match(expected, /ReadAllText/);
  assert.match(expected, /exit \$LASTEXITCODE'$/);
  await page.click("copy-uninstall");
  assert.equal(page.copied(), expected);
  page.clipboardFail(); await page.click("copy-uninstall");
  assert.equal(page.document.activeElement, input);
  assert.equal(input.selectionEnd, expected.length);
  assert.equal(page.calls.filter(call => call.method !== "GET").length, 0);
  for (const guide of ["FIRST_RUN", "WINDOWS_SETUP", "HOSTED_ACCOUNTS"]) {
    const markdown = readFileSync(new URL(`../docs/${guide}.md`, import.meta.url), "utf8");
    assert.ok(markdown.includes("```powershell\n" + expected + "\n```"), `${guide} must use the exact displayed command`);
    assert.doesNotMatch(markdown, /uninstall\.cmd/);
  }
  await page.click("uninstall-platform-mac");
  assert.equal(page.find("uninstall-command")!.value, "~/.providence/companion/uninstall");
});


test("clearing chats stays in Account and requires explicit confirmation before its cookie-authenticated POST", async () => {
  const page = fixture({ devices: [device()], keyConfigured: true, confirm: false }); await page.settle();
  const button = page.find("clear-chats")!;
  assert.ok(page.find("account-view")!.contains(button));
  assert.equal(page.find("devices-view")!.contains(button), false);
  assert.equal(page.calls.filter(call => call.method !== "GET").length, 0);
  await page.click("clear-chats");
  assert.equal(page.confirmations.length, 1);
  assert.match(page.confirmations[0], /cannot be undone/);
  assert.match(page.confirmations[0], /devices, saved API key and settings will stay/);
  assert.equal(page.calls.filter(call => call.method !== "GET").length, 0, "cancel must send no write request");
  page.confirm(true); await page.click("clear-chats");
  const writes = page.calls.filter(call => call.method !== "GET");
  assert.equal(writes.length, 1); assert.equal(writes[0].path, "/auth/chats/clear");
  assert.equal(writes[0].method, "POST"); assert.deepEqual(writes[0].body, {});
  assert.equal(writes[0].credentials, "same-origin");
  assert.equal(writes[0].headers?.Authorization, undefined);
  assert.equal(page.auth.length, 0, "chat cleanup uses the normal owner session, without enrollment step-up");
  assert.match(page.find("status")!.textContent, /^Chats cleared/);
  assert.ok(page.find("clear-chats"), "success stays in Account instead of navigating automatically");
  assert.ok(page.root.querySelectorAll("a").some(link => link.getAttribute("href") === "/" && link.textContent.includes("Open Chat")));
  assert.equal(page.root.querySelectorAll("[data-remove-device]").length, 1);
});

test("active-work rejection and unconfirmed cleanup do not display success or retry deletion", async () => {
  for (const response of [
    { ok: false, status: 409, body: { error: "Wait for active work to finish before clearing chats." } },
    { ok: true, body: { cleared: false } },
  ]) {
    const page = fixture({ clearResponse: response }); await page.settle();
    await page.click("clear-chats");
    assert.equal(page.calls.filter(call => call.path === "/auth/chats/clear").length, 1);
    assert.doesNotMatch(page.find("status")!.textContent, /^Chats cleared/);
    assert.match(page.find("status")!.textContent, /active work|could not be confirmed/);
    assert.equal(page.find("clear-chats")!.disabled, false);
  }
});


test("malformed account and device snapshots cannot masquerade as signed-out or empty accounts", async () => {
  const badAccount = fixture({ sessionResponse: {} }); await badAccount.settle();
  assert.ok(badAccount.find("reload-account")); assert.equal(badAccount.find("signin"), null);
  const badDevices = fixture({ devicesResponse: {} }); await badDevices.settle();
  assert.match(badDevices.find("devices-view")!.textContent, /could not be checked/);
  assert.doesNotMatch(badDevices.find("devices-view")!.textContent, /Add your first computer/);
});

test("account deletion is advertised explicitly, confirmed, and bound to a fresh passkey for this account", async () => {
  const accountId = "00000000-0000-4000-8000-000000000001";
  const sessionResponse = { authenticated: true, name: "Alex", keyConfigured: false, accountId, accountDeletionAvailable: true };
  const older = fixture(); await older.settle(); assert.equal(older.find("delete-account"), null);
  const page = fixture({ sessionResponse, confirm: false }); await page.settle();
  assert.ok(page.find("account-view")!.contains(page.find("delete-account")!));
  await page.click("delete-account"); assert.equal(page.calls.filter(call => call.method === "POST").length, 0);
  page.confirm(true); await page.click("delete-account");
  assert.match(page.confirmations.at(-1)!, /cannot be undone/);
  assert.deepEqual(page.calls.filter(call => call.method === "POST").map(call => call.path), ["/auth/step-up/options", "/auth/step-up/verify", "/auth/account/delete"]);
  assert.deepEqual(page.calls.find(call => call.path === "/auth/step-up/options")!.body, { action: "delete_account", target: accountId });
  assert.deepEqual(page.calls.find(call => call.path === "/auth/account/delete")!.body, { stepUpToken: "synthetic-proof" });
  assert.ok(page.find("signin")); assert.equal(page.find("delete-account"), null);
  assert.match(page.find("status")!.textContent, /active hosted data were deleted/);
  assert.deepEqual(page.removedStorage, ["providence.session", "providence.pending", "providence.quest.session", "providence.quest.pending"]);
});

test("account deletion cancellation, pending cleanup and malformed results never falsely claim deletion", async () => {
  const sessionResponse = { authenticated: true, name: "Alex", keyConfigured: true, accountId: "00000000-0000-4000-8000-000000000001", accountDeletionAvailable: true };
  const cancelled = fixture({ sessionResponse, authError: new DOMException("Cancelled", "NotAllowedError") }); await cancelled.settle();
  await cancelled.click("delete-account"); assert.equal(cancelled.calls.some(call => call.path === "/auth/account/delete"), false);
  assert.ok(cancelled.find("delete-account"));
  const pending = fixture({ sessionResponse, deletionResponse: { deleted: false, accessRevoked: true, cleanupPending: true, externalApiKeyRevoked: false, localFilesDeleted: false } }); await pending.settle();
  await pending.click("delete-account"); assert.ok(pending.find("signin"));
  assert.match(pending.find("status")!.textContent, /not yet confirmed deleted/);
  const malformed = fixture({ sessionResponse, deletionResponse: { deleted: true } }); await malformed.settle();
  await malformed.click("delete-account"); assert.match(malformed.find("status")!.textContent, /could not be confirmed/);
  assert.ok(malformed.find("delete-account"));
});


test("AI processing consent is explicit and version-bound, with no consent request on page load", async () => {
  const page = fixture({ sessionResponse: { authenticated: true, name: "Alex", keyConfigured: true, aiConsentRequired: true, aiConsentVersion: "2026-10-02" } }); await page.settle();
  assert.ok(page.find("allow-ai-processing"));
  assert.equal(page.calls.some(call => call.path === "/auth/ai-consent"), false);
  assert.match(page.find("ai-processing")!.textContent, /messages, voice audio, task context and tool results/);
  await page.click("allow-ai-processing");
  const consent = page.calls.filter(call => call.path === "/auth/ai-consent");
  assert.equal(consent.length, 1); assert.equal(consent[0].method, "POST"); assert.equal(consent[0].credentials, "same-origin");
  assert.deepEqual(consent[0].body, { allow: true, version: "2026-10-02" });
  assert.equal(page.find("allow-ai-processing"), null);
  assert.match(page.find("ai-processing")!.textContent, /processing is allowed/);
  assert.equal(page.auth.length, 0);
  const future = fixture({ sessionResponse: { authenticated: true, name: "Alex", keyConfigured: true, aiConsentRequired: true, aiConsentVersion: "future-version" } }); await future.settle();
  assert.equal(future.find("allow-ai-processing"), null); assert.match(future.find("ai-processing")!.textContent, /Reload Account/);
});

test("billing deep links reveal the relevant details without reopening them on normal refresh", async () => {
  const page = fixture({ hash: "#account-key" }); await page.settle();
  assert.equal(page.find("account-key")!.open, true);
  page.find("account-key")!.open = false;
  await page.click("refresh-account");
  assert.equal(page.find("account-key")!.open, false);
});


test("spatial sign-in returns only to the allowlisted view after key setup and consent", async () => {
  for (const ready of [false, true]) {
    const page = fixture({ authenticated: false, keyConfigured: ready, search: "?next=%2Fmeta" }); await page.settle();
    await page.click("signin");
    assert.deepEqual(page.navigations, ready ? ["/meta"] : []);
  }
  const consent = fixture({ authenticated: false, search: "?next=%2Fmeta", sessionResponse: { authenticated: false, name: "Alex", keyConfigured: true, aiConsentRequired: true, aiConsentVersion: "2026-10-02" } }); await consent.settle();
  await consent.click("signin"); assert.deepEqual(consent.navigations, []); assert.ok(consent.find("allow-ai-processing"));
  const external = fixture({ authenticated: false, keyConfigured: true, search: "?next=https%3A%2F%2Funtrusted.example" }); await external.settle();
  await external.click("signin"); assert.deepEqual(external.navigations, []);
});
