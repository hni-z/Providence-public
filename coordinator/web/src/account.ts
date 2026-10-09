import { initializeTheme } from "./theme";
import { startRegistration, startAuthentication } from "@simplewebauthn/browser";
import type { Device } from "./types";
import { parseAccountSession, parseAccountDevices, type AccountState } from "./account-data";
import { startActivityReporting } from "./activity";
import { accountRefreshIdentity, accountViewIsInteractive, preserveAccountView, startAccountRefresh } from "./account-refresh";
import { parseAccountSecurity, verifiedAccountRequest, type AccountOperation, type AccountSecurity } from "./account-security";
import "./account.css";

initializeTheme();
const root = document.getElementById("account-root")!;
type SetupRequest = { userCode: string; status: string; expiresAt: string };
type Platform = "mac" | "windows" | "linux";
type AccountSection = "account" | "devices";
const sectionForHash = (hash = ""): AccountSection => ["#devices", "#computer-setup", "#uninstall", "#device-capabilities", "#watch-pairing"].includes(hash) ? "devices" : "account";
let section = sectionForHash(location.hash);
let revealedAnchor = "";
const AI_CONSENT_VERSION = "2026-10-02";
type AccountDevice = Device & { keepAwake?: { enabled: boolean; active: boolean; method?: string; reason?: string } };
let state: AccountState = { authenticated: false };
let setupRequest: SetupRequest | undefined;
let setupError = "";
let setupBusy = false;
let platform: Platform = /Win/i.test(navigator.platform) ? "windows" : /Linux/i.test(navigator.platform) && !/Android/i.test(navigator.userAgent) ? "linux" : "mac";
let configureKey = false;
let setupOpen: boolean | undefined;
let devices: AccountDevice[] = [];
let devicesError = "";
let security: AccountSecurity | undefined;
let securityError = "";
let stopActivity: (() => void) | undefined;
let interactiveActions = 0;
let interactionVersion = 0;
let loadPromise: Promise<void> | undefined;
let manualReloadRequested = false;
let lastSnapshotIdentity = "";
let sessionStateVersion = 0;
type AccountSnapshot = { state: AccountState; setupRequest?: SetupRequest; setupError: string; devices: AccountDevice[]; devicesError: string; security?: AccountSecurity; securityError: string };
const interacting = () => interactiveActions > 0 || setupBusy || accountViewIsInteractive(root, document);
const setupCode = new URLSearchParams(location.search).get("setup")?.trim().toUpperCase();
const returnToSpatial = !setupCode && new URLSearchParams(location.search).get("next") === "/meta";
const validSetupCode = !!setupCode && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(setupCode);
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function request(path: string, body?: unknown, method?: string, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"), credentials: "same-origin", mode: "same-origin", redirect: "error", referrerPolicy: "same-origin",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data: any;
  try { data = response.status === 204 ? {} : await response.json(); }
  catch { throw new Error("Providence could not read the response. Refresh and try again."); }
  if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : "The request could not be completed. Please try again.");
  return data;
}
function status(message: string) { const el = document.getElementById("status"); if (el) el.textContent = message; }
async function verifiedRequest(operation: AccountOperation, path: string, body: Record<string, unknown>, target?: string, method?: string) {
  status(operation === "remove_passkey" ? "Confirm with a different passkey on this account to remove the selected passkey." : "Confirm with a passkey already on this account to authorize this change.");
  return verifiedAccountRequest({ request, authenticate: optionsJSON => startAuthentication({ optionsJSON }) }, operation, path, body, target, method);
}
async function action(button: HTMLButtonElement, operation: () => Promise<void>) {
  interactiveActions++; interactionVersion++; button.disabled = true; status("");
  try { await operation(); }
  catch (error) { status(error instanceof Error ? error.message : "Something went wrong. Please try again."); }
  finally { interactiveActions--; button.disabled = false; }
}
async function readSnapshot(signal?: AbortSignal): Promise<AccountSnapshot> {
  const next: AccountSnapshot = { state: parseAccountSession(await request("/auth/session", undefined, undefined, signal)), setupError: "", devices: [], devicesError: "", securityError: "" };
  await Promise.all([
    (async () => {
      if (!next.state.authenticated || !setupCode) return;
      if (!validSetupCode) next.setupError = "This setup link is not valid. Run the install command again on your computer.";
      else {
        try { next.setupRequest = await request(`/auth/setup?code=${encodeURIComponent(setupCode)}`, undefined, undefined, signal); }
        catch (error) { next.setupError = error instanceof Error ? error.message : "This setup request is unavailable. Run the install command again."; }
      }
    })(),
    (async () => {
      if (!next.state.authenticated) return;
      try {
        const response = await request("/auth/devices", undefined, undefined, signal);
        next.devices = parseAccountDevices(response);
      } catch { next.devicesError = "Your computers could not be checked. Refresh to try again."; }
    })(),
    (async () => {
      if (!next.state.authenticated) return;
      try { next.security = parseAccountSecurity(await request("/auth/security", undefined, undefined, signal)); }
      catch { next.securityError = "Your sessions and passkeys could not be checked. Refresh to try again."; }
    })(),
  ]);
  signal?.throwIfAborted();
  return next;
}
function applySnapshot(next: AccountSnapshot, automatic: boolean) {
  const wasAuthenticated = state.authenticated;
  if (!next.state.authenticated) { setupOpen = undefined; configureKey = false; }
  else if (setupOpen === undefined && !next.devicesError) setupOpen = next.devices.length === 0 && !setupCode;
  state = next.state; setupRequest = next.setupRequest; setupError = next.setupError;
  devices = next.devices; devicesError = next.devicesError;
  security = next.security; securityError = next.securityError;
  if (state.authenticated && !stopActivity) {
    stopActivity = startActivityReporting({
      send: (body, keepalive) => fetch("/auth/activity", {
        method: "POST", credentials: "same-origin", keepalive,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    });
  } else if (!state.authenticated && stopActivity) {
    stopActivity(); stopActivity = undefined;
  }
  if (automatic || (wasAuthenticated && state.authenticated)) preserveAccountView(root, render, document, window);
  else render();
}
function load(options: { automatic?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  if (loadPromise) {
    if (!options.automatic) manualReloadRequested = true;
    return loadPromise;
  }
  const run = async () => {
    let current = options;
    do {
      manualReloadRequested = false;
      const beganAtInteraction = interactionVersion;
      const beganAtSession = sessionStateVersion;
      try {
        const next = await readSnapshot(current.signal);
        const identity = accountRefreshIdentity({ ...next,
          setupExpired: !!next.setupRequest && Date.parse(next.setupRequest.expiresAt) <= Date.now(),
        });
        if (beganAtSession === sessionStateVersion && (!current.automatic || (document.visibilityState === "visible" && !interacting() && beganAtInteraction === interactionVersion))) {
          if (!current.automatic || identity !== lastSnapshotIdentity) {
            applySnapshot(next, current.automatic === true);
            lastSnapshotIdentity = identity;
          }
        }
      } catch (error) {
        if (!current.automatic) throw error;
      }
      current = {};
    } while (manualReloadRequested);
  };
  loadPromise = run().finally(() => { loadPromise = undefined; });
  return loadPromise;
}
function clearSignedInView() {
  sessionStateVersion++;
  stopActivity?.(); stopActivity = undefined;
  for (const key of ["providence.session", "providence.pending", "providence.quest.session", "providence.quest.pending"]) {
    try { sessionStorage.removeItem(key); } catch { /* Blocked storage must not keep a signed-out view open. */ }
  }
  state = { authenticated: false }; setupRequest = undefined; setupError = "";
  devices = []; devicesError = ""; security = undefined; securityError = "";
  lastSnapshotIdentity = ""; setupOpen = undefined; configureKey = false;
  render();
}
function installCommand() {
  if (platform === "windows") {
    return `& ([scriptblock]::Create((irm -MaximumRedirection 0 https://providence.hani.so/install.ps1)))${configureKey ? " -ConfigureKey" : ""}`;
  }
  return `curl --proto '=https' --tlsv1.2 -fsS https://providence.hani.so/install.sh | sh${configureKey ? " -s -- --configure-key" : ""}`;
}
function uninstallCommand() {
  return platform === "windows" ? String.raw`& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -Command '$ErrorActionPreference=''Stop''; & ([scriptblock]::Create([IO.File]::ReadAllText((Join-Path ([Environment]::GetFolderPath(''UserProfile'')) ''.providence\companion\uninstall.ps1'')))); exit $LASTEXITCODE'` : '~/.providence/companion/uninstall';
}
function setupApproval() {
  if (setupError) return `<section class="panel setup-approval"><h2>Computer setup</h2><p>${escape(setupError)}</p></section>`;
  if (!setupRequest) return "";
  const expiresAt = Date.parse(setupRequest.expiresAt);
  const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
  if (setupRequest.status === "approved") return '<section class="panel setup-approval"><h2>Terminal approved</h2><p>Return to your terminal to finish setup. The browser does not need your API key.</p></section>';
  if (setupRequest.status === "denied") return '<section class="panel setup-approval"><h2>Setup declined</h2><p>This terminal has not been authorized. You can start a new setup from a computer you own.</p></section>';
  if (setupRequest.status !== "pending" || expired) return '<section class="panel setup-approval"><h2>Setup request expired</h2><p>Run the install command again on your computer for a new request.</p></section>';
  return `<section class="panel setup-approval"><h2>Does this code match your terminal?</h2><output class="code comparison-code">${escape(setupRequest.userCode)}</output><p>Only continue if you started setup and this exact code appears in your terminal. You are allowing that terminal to connect a computer to <strong>${escape(state.name ?? "your account")}</strong> and, if needed, configure its hosted API key.</p><p class="small">${Number.isFinite(expiresAt) ? `This request expires at ${escape(new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}. ` : ""}Never approve a code someone else sent you.</p><div class="approval-actions"><button id="approve-setup" class="primary">Code matches · Allow this terminal</button><button id="deny-setup" class="quiet">Decline</button></div></section>`;
}
function platformPicker(context: string) {
  return `<div class="platform-picker" role="group" aria-label="Computer platform">${([ ["mac", "Mac"], ["windows", "Windows"], ["linux", "Linux"] ] as const).map(([value, label]) => `<button id="${context}-platform-${value}" data-platform="${value}" class="quiet" aria-pressed="${platform === value}">${label}</button>`).join("")}</div>`;
}
function commandPanel() {
  return `<section class="install-panel" id="computer-setup" ${setupOpen ? "" : "hidden"} aria-labelledby="setup-heading">
    <div class="panel-heading"><h2 id="setup-heading">${configureKey ? "Update your API key" : "Add a computer"}</h2><button id="close-setup" class="quiet">Close</button></div>
    <p>${configureKey ? "Run this on a connected computer to enter a replacement key privately." : `On the computer you want to add, open ${platform === "windows" ? "PowerShell" : "Terminal"} and paste this command.`}</p>
    ${platformPicker("install")}
    <label for="install-command">${platform === "windows" ? "PowerShell" : "Terminal"} command</label>
    <textarea id="install-command" class="install-command" rows="3" readonly spellcheck="false" aria-describedby="command-help">${escape(installCommand())}</textarea>
    <button id="copy-command" class="secondary">Copy command</button>
    <p id="command-help" class="small">${configureKey ? "Approve the matching browser code, then enter the key in your terminal." : "The installer guides you through sign-in and asks before setting up background startup."} You can also select and copy the command above.</p>
    <ol class="setup-instructions">
      ${configureKey ? '<li>Confirm the account and matching code in your browser.</li><li>Return to the terminal and enter your replacement API key.</li>' : `
        <li>Sign in to Codex and name this computer, for example <strong>Kitchen laptop</strong>.</li>
        <li>Sign in to Providence and approve the matching code. If asked, enter your OpenAI API key <strong>in the terminal</strong>.</li>
        <li>Finish the terminal prompts, then wait for <strong>Online</strong> above. New computers use full access after your local confirmation.</li>`}
    </ol>
    ${configureKey ? '<button id="show-install" class="quiet">Back to adding a computer</button>' : '<p class="small">Adding a second computer? Repeat the same steps there with the same Providence account and a different name. Your account needs only one API key.</p><p class="small">The key is sent over HTTPS and stored encrypted on Providence’s server for coordination and voice. <a href="#account-key" data-open-details="account-key">Key storage and billing</a></p>'}
  </section>`;
}
function uninstallPanel() {
  return `<details class="uninstall-details" id="uninstall"><summary>Uninstall Providence</summary><p class="small">Run this on the computer you want to remove. It asks before uninstalling; your documents and existing Codex sign-in stay.</p>${platformPicker("uninstall")}<label for="uninstall-command">${platform === "windows" ? "PowerShell" : "Terminal"} command</label><textarea id="uninstall-command" rows="2" readonly spellcheck="false">${escape(uninstallCommand())}</textarea><button id="copy-uninstall" class="secondary">Copy uninstall command</button><p class="small">Use <strong>Remove access</strong> above to block new work immediately. To reconnect a removed computer, uninstall it locally and run setup again. Your account's shared API key stays.</p></details>`;
}
function computerPanel() {
  const platformName = (value?: string) => ({ darwin: "macOS", win32: "Windows", linux: "Linux" }[value ?? ""] ?? value ?? "Computer");
  const guidance: Record<string, string> = {
    authentication_required: "Sign in to Codex on this computer, then start Providence again.",
    configuration_required: "Run the setup command on this computer and review its configuration.",
    protocol_error: "Run the setup command on this computer to check its installed version.",
    disconnected_by_owner: "This computer's access was removed. Uninstall it locally, then run setup again to reconnect.",
    runtime_stopped: "Start Providence on this computer again to reconnect.",
    ready_timeout: "The helper connected but its Codex runtime is not ready. Check the computer locally.",
  };
  const rows = devices.map(device => {
    const connection = device.connectionStatus;
    const label = device.online ? "Online" : connection?.state === "connecting" ? "Connecting" : connection?.state === "action_required" ? "Needs attention" : "Offline";
    const access = device.workerAccess === "full-access" ? "Files & terminal: full access" : device.workerAccess === "workspace" ? "Files & terminal: workspace only" : "File access not reported yet";
    const detail = device.online ? "Connected for file and terminal requests. Controlling apps needs separate tools and permissions on this computer."
      : guidance[connection?.reasonCode ?? ""] ?? "Keep this computer awake, signed in and online with Providence running.";
    const keepAwake = device.keepAwake;
    const awakeLabel = !keepAwake ? "Sleep status not reported yet"
      : keepAwake.reason === "stop_unconfirmed" ? "Sleep release not confirmed"
      : !keepAwake.enabled ? "Normal sleep settings"
      : keepAwake.active === true ? "Keep awake on" : ["waiting_for_activity", "lease_expired"].includes(keepAwake.reason ?? "") ? "Keep awake idle" : "Keep awake unavailable";
    const awakeReason: Record<string, string> = {
      idle_sleep_inhibited: "Keep-awake activation is not currently confirmed.",
      unsupported_platform: "This platform does not support the keep-awake helper.",
      invalid_parent: "Keep awake could not attach to the companion process.",
      helper_unavailable: "The keep-awake helper is unavailable on this computer.",
      assertion_unavailable: "The operating system did not confirm the keep-awake request.",
      startup_unconfirmed: "The keep-awake helper has not confirmed startup.",
      helper_exited: "The keep-awake helper stopped. Check this computer locally.",
      stopped: "The keep-awake helper is stopped.",
      stop_unconfirmed: "The helper could not confirm that it stopped. Check it locally.",
      disabled: "Keep awake is disabled on this computer.",
      disconnected: "This computer is offline; keep awake is not confirmed.",
      waiting_for_activity: "Normal sleep is allowed until you use Providence or a task runs.",
      lease_expired: "The activity signal expired; normal sleep is allowed.",
    };
    const awakeDetail = keepAwake?.reason === "stop_unconfirmed" ? awakeReason.stop_unconfirmed
      : keepAwake?.enabled && keepAwake.active !== true
      ? awakeReason[keepAwake.reason ?? ""] ?? "Check the keep-awake helper on this computer."
      : keepAwake?.enabled && keepAwake.active === true && keepAwake.method === "logind-idle"
        ? "Blocks Linux automatic idle sleep. Desktop power settings may still suspend this computer." : "";
    const evidence = (tool: "browser" | "desktop") => {
      const check = device.capabilityEvidence?.[tool];
      return check?.status === "verified_scoped"
        ? `Verified for ${escape(check.scope?.trim().slice(0, 240) || "a prior scoped check")}. Other actions still need their own permissions.`
        : "Not verified. Check the tool and its permissions on this computer.";
    };
    const appControl = device.online && device.capabilityEvidence?.desktop?.status === "verified_scoped" ? "App control: verified for a recorded task" : "App control: not verified";
    return `<li class="computer-row" data-device-id="${escape(device.id)}"><div class="computer-heading"><strong title="${escape(device.id)}">${escape(device.name)}</strong><span class="connection-label ${device.online ? "connected" : ""}">${label}</span></div><p class="computer-meta">${escape(platformName(device.platform))} · ${access}</p>${device.online ? "" : `<p class="small">${detail}</p>`}<details class="tool-checks"><summary>App control and sleep details</summary><p class="small">${appControl}. <a href="#device-capabilities" data-open-details="device-capabilities">Set up app control</a></p><p class="small"><strong>Browser:</strong> ${evidence("browser")}</p><p class="small"><strong>Desktop:</strong> ${evidence("desktop")}</p><p class="small">${awakeLabel}.${awakeDetail ? ` ${awakeDetail}` : ""}</p></details><button class="quiet remove-device" data-remove-device="${escape(device.id)}">Remove access</button></li>`;
  }).join("");
  return `<section class="panel computers-panel"><div class="panel-heading computer-actions"><div><h1 id="devices-heading" tabindex="-1">Your computers</h1><p class="page-description">Add a computer, check its connection or remove access.</p></div><div class="computer-buttons"><button id="refresh-devices" class="quiet" aria-label="Refresh computer status">Refresh</button><button id="add-computer" class="primary" aria-expanded="${!!setupOpen}" aria-controls="computer-setup">Add computer</button></div></div><div aria-live="polite">${devicesError ? `<p>${escape(devicesError)}</p>` : devices.length ? `<ul class="computer-list">${rows}</ul>` : `<div class="empty-computers"><span class="empty-device-icon" aria-hidden="true">${navigationIcon("devices")}</span><h2>Add your first computer</h2><p>Connect a Mac, Windows PC or Linux computer. Then reach it from Providence on any of your devices.</p></div>`}</div>${devices.length ? '<p class="small">Status updates automatically. Online means the helper and Codex runtime are ready; app control needs its own tools and permissions.</p>' : ''}${state.keyConfigured ? '<a class="primary workspace-link" href="/">Open your workspace ↗</a><p class="small workspace-hint">Try: <code>Which computers are online?</code></p>' : ''}${commandPanel()}<div class="computer-help"><details id="computer-access"><summary>What does Remove access do?</summary><p class="small">It blocks new work on that computer and invalidates its credential. Work already sent may need checking. Your files, history, other computers and shared API key stay. A fresh setup can grant access again.</p></details>${uninstallPanel()}</div></section>`;
}
function controlSetupPanel() {
  const guide = platform === "windows" ? `<h3>Windows</h3><ol><li>In ChatGPT on this PC, enable the <strong>Computer Use</strong> plugin, server and skill.</li><li>Review <strong>Settings → Computer Use</strong> permissions. Keep ChatGPT running and the desktop signed in and unlocked.</li><li>Try opening Calculator with Computer Use in ChatGPT, then try a harmless app request from Providence.</li></ol><p class="small">A Chrome connection cannot control native apps. If ChatGPT reports “native pipe is unavailable”, fully quit and reopen it, then check Calculator again.</p>`
    : platform === "mac" ? `<h3>Mac</h3><ol><li>In ChatGPT on this Mac, enable the <strong>Computer Use</strong> plugin, server and skill.</li><li>Follow its macOS <strong>Accessibility</strong> and <strong>Screen Recording</strong> prompts. Review app permissions in <strong>ChatGPT → Settings → Computer Use</strong>.</li><li>Keep ChatGPT running. Try Calculator in ChatGPT first, then a harmless app request from Providence.</li></ol>`
    : '<h3>Linux and Raspberry Pi</h3><p>File and terminal work use the local runtime and chosen access. Desktop control also needs a graphical session and compatible tools.</p>';
  return `<details class="panel capabilities" id="device-capabilities"><summary>App control and device help</summary>
    <p>Full access covers files and terminal commands. Desktop apps need their own tools and operating-system permissions.</p>
    ${platformPicker("guide")}${guide}
    ${platform === "linux" ? "" : '<p class="small">A successful ChatGPT check proves that route only. If Providence cannot see those tools, its app-control integration is not ready.</p>'}
    <details id="remote-help"><summary>Using ChatGPT Remote too?</summary><p>ChatGPT Remote and Providence are separate connections. Providence’s helper does not require ChatGPT Remote pairing, and enabling Remote does not automatically attach Providence to ChatGPT’s app tools.</p><p class="small">Follow the <a href="https://learn.chatgpt.com/docs/remote-connections" target="_blank" rel="noopener noreferrer">Remote connections instructions</a> on each computer you intend to control.</p></details>
    <details id="mobile-help"><summary>iPhone, iPad, Apple Watch and Quest</summary><p>These control your computers; they do not run unrestricted mobile tasks. Use Safari on iPhone for hosted sign-in while native passkey support awaits a signed update. The Watch needs a separate Xcode installation.</p></details>
    <details id="sleep-help"><summary>Background startup and sleep</summary><p>Choose background startup during setup to close the terminal and start Providence when you sign in. Keep awake is optional and works during active use or tasks, then releases when idle. It does not wake or unlock computers, or override manual sleep, closing the lid or low-battery sleep. ChatGPT’s app tools still need ChatGPT running.</p><p class="small">On Linux, keep awake blocks logind automatic idle sleep; a desktop power manager may still suspend the computer.</p></details>
    <p class="small"><a href="https://learn.chatgpt.com/docs/computer-use" target="_blank" rel="noopener noreferrer">Official Computer Use instructions ↗</a></p>
  </details>`;
}
function securityPanel() {
  const date = (value: string | null) => value === null ? "Date unavailable" : new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const canRemovePasskey = (security?.passkeys.length ?? 0) > 1;
  const sessionRows = security?.sessions.map(session => `<li class="security-row"><div><strong>${session.current ? "This session" : session.scope === "owner" ? "Account session" : "Controller session"}</strong><span class="security-reference">${escape(session.id.slice(0, 8))}</span><p class="small">Signed in: ${escape(date(session.createdAt))}<br>Expires: ${escape(date(session.expiresAt))}</p></div><button class="quiet" id="remove-session-${escape(session.id)}" data-remove-session="${escape(session.id)}">${session.current ? "Sign out here" : "Sign out"}</button></li>`).join("");
  const passkeyRows = security?.passkeys.map(passkey => `<li class="security-row"><div><strong>Passkey ${escape(passkey.id.slice(0, 8))}</strong><p class="small">Added: ${escape(date(passkey.createdAt))}</p></div><button class="quiet" id="remove-passkey-${escape(passkey.id)}" data-remove-passkey="${escape(passkey.id)}" ${!canRemovePasskey ? 'disabled title="Add another passkey before removing this one"' : ""}>Remove</button></li>`).join("");
  return `<details class="panel security-panel" id="account-security"><summary>Account security</summary><button id="refresh-security" class="quiet mode-toggle">Refresh sessions and passkeys</button><p>Use an existing passkey to approve new credentials, computers and controllers. This protects account changes without adding prompts to individual tasks.</p>
    ${securityError ? `<p class="security-error">${escape(securityError)}</p>` : security ? `<h3>Your passkeys</h3><ul class="security-list">${passkeyRows || '<li class="small">No passkeys were reported. Refresh before changing account access.</li>'}</ul><p class="small">Removing a passkey requires a different passkey and signs out your other Providence sessions. Keep at least one passkey. The labels identify credentials, not their device names.</p>` : '<p class="small">Account security details are unavailable. Refresh to try again.</p>'}
    <button id="add-passkey" class="secondary">Add another passkey</button>
    ${security ? `<h3>Signed-in sessions</h3><ul class="security-list">${sessionRows || '<li class="small">No active sessions were reported. Refresh to check your account.</li>'}</ul><p class="small">Sessions belong to Providence. Device names and locations are not recorded here. Signing out one session prevents it from sending new requests; work already sent may continue.</p>` : ""}
    <button id="signout-everywhere" class="quiet mode-toggle">Sign out everywhere and stop work</button><p class="small">This signs out Providence sessions, including this one, and begins stopping account work. It keeps computer registrations, passkeys, history and the saved API key. Check any work already sent to a computer.</p><p class="small">Codex sign-in and Providence access are separate. These controls do not sign you out of OpenAI.</p></details>`;
}
function aiProcessingPanel() {
  if (state.aiConsentRequired === undefined) return "";
  if (!state.aiConsentRequired) return '<section class="panel" id="ai-processing"><h2>AI processing</h2><p>OpenAI processing is allowed for this account.</p><a href="/privacy">Privacy and data use ↗</a></section>';
  const supported = state.aiConsentVersion === AI_CONSENT_VERSION;
  return `<section class="panel ai-processing-panel" id="ai-processing" aria-labelledby="ai-processing-heading"><h2 id="ai-processing-heading">Before you use AI</h2><p>Your messages, voice audio, task context and tool results are sent to OpenAI to respond and carry out requests. Your OpenAI API usage is billed separately.</p><p class="small">This choice applies to future requests on this account. <a href="/privacy">Read how Providence uses your data.</a></p>${supported ? '<button id="allow-ai-processing" type="button" class="primary">Allow OpenAI processing</button>' : '<p class="small">The privacy notice has changed. Reload Account to review the current version before continuing.</p>'}</section>`;
}
function revealAccountAnchor() {
  const hash = location.hash ?? "";
  if (hash === revealedAnchor) return;
  if (["#account-key", "#account-security", "#device-capabilities", "#watch-pairing", "#uninstall"].includes(hash)) {
    const details = document.getElementById(hash.slice(1)) as HTMLDetailsElement | null;
    if (!details) return;
    details.open = true;
  }
  revealedAnchor = hash;
}
function deleteAccountPanel() {
  if (!state.accountDeletionAvailable || !state.accountId) return "";
  return `<section class="panel delete-account-panel" aria-labelledby="delete-account-heading"><h2 id="delete-account-heading">Delete account</h2><p id="delete-account-description">Permanently delete this Providence account, its chats and hosted file copies. Connected devices lose Providence access, and ongoing work is stopped.</p><p class="small">Files on your computers and your Codex sign-in stay. This does not revoke your API key at OpenAI or remove existing operational backups.</p><button id="delete-account" type="button" class="quiet" aria-describedby="delete-account-description">Delete my account</button></section>`;
}
function accountHref(next: AccountSection) {
  return `/account${setupCode ? `?setup=${encodeURIComponent(setupCode)}` : returnToSpatial ? "?next=%2Fmeta" : ""}${next === "devices" ? "#devices" : ""}`;
}
function navigationIcon(name: "chat" | "devices" | "spatial" | "account" | "logout") {
  const shapes = {
    chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"></path>',
    devices: '<rect x="4" y="3" width="16" height="13" rx="2"></rect><path d="M8 21h8M12 16v5"></path>',
    spatial: '<path d="m12 3 9 5v8l-9 5-9-5V8zM3 8l9 5 9-5M12 13v8"></path>',
    account: '<circle cx="12" cy="8" r="4"></circle><path d="M5 21v-2a7 7 0 0 1 14 0v2"></path>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"></path>',
  };
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shapes[name]}</svg>`;
}
function sidebar() {
  return `<aside class="account-sidebar"><a class="brand" href="/"><img src="/favicon.svg?v=3" alt=""><span>Providence</span></a>
    <nav class="account-navigation" aria-label="Main navigation">
      <a class="sidebar-link" href="/">${navigationIcon("chat")}<span>Chat</span></a>
      <a id="nav-devices" class="sidebar-link" href="${escape(accountHref("devices"))}" data-account-section="devices" ${section === "devices" ? 'aria-current="page"' : ''}>${navigationIcon("devices")}<span>Devices</span></a>
      <a class="sidebar-link spatial-link" href="/meta">${navigationIcon("spatial")}<span>Spatial view</span><small class="nav-preview">Preview</small></a>
      <a id="nav-account" class="sidebar-link" href="${escape(accountHref("account"))}" data-account-section="account" ${section === "account" ? 'aria-current="page"' : ''}>${navigationIcon("account")}<span>Account</span></a>
    </nav>
    ${state.authenticated ? `<div class="sidebar-footer"><p class="sidebar-account"><span>Signed in as</span><strong>${escape(state.name ?? "Your account")}</strong></p><button id="logout" class="sidebar-link signout-button" type="button">${navigationIcon("logout")}<span>Sign out</span></button></div>` : ''}
  </aside>`;
}
function selectSection(next: AccountSection, focusTarget = `${next}-heading`) {
  if (section !== next) window.history?.pushState(null, "", accountHref(next));
  section = next;
  preserveAccountView(root, render, document, window);
  document.getElementById(focusTarget)?.focus();
}
function render() {
  root.innerHTML = `<div class="account-shell">${sidebar()}
    <main class="${state.authenticated ? 'account-main' : 'signin-main'}">${!state.authenticated ? `
      <section class="panel signin-panel"><div class="signin-mark"><img src="/favicon.svg?v=3" alt=""></div><h1>${setupCode ? "Connect your computer" : "Welcome to Providence"}</h1><p>Sign in with Face ID, Touch ID or your device PIN.${setupCode ? " Then compare the code with your terminal." : " Your passkey keeps sign-in simple."}</p><button id="signin" class="primary">Sign in with a passkey <span aria-hidden="true">↗</span></button><div class="divider">New here?</div><form id="register"><label for="name">Your name</label><input id="name" name="name" autocomplete="nickname" maxlength="80" placeholder="What should we call you?" required><button type="submit" class="secondary">Create your account</button></form><p class="small signin-note">Keep your passkey in your password manager or available on another device so you can sign in again. <a href="/privacy">Privacy and data use</a></p></section>` : `
      ${setupApproval()}
      <section id="devices-view" class="account-view" aria-labelledby="devices-heading" ${section === "devices" ? "" : "hidden"}>
        ${computerPanel()}
        <div class="device-extras"><details class="panel" id="watch-pairing"><summary>Apple Watch</summary><p>Open Providence on your Watch, then enter a pairing code from this account.</p><button id="watch" class="secondary" ${!state.keyConfigured ? 'disabled' : ''}>Pair an Apple Watch</button><output id="watch-code" class="code" aria-live="polite"></output><p class="small">${!state.keyConfigured ? 'Finish computer setup to connect your account’s API key first. ' : ''}The Watch app currently needs an Xcode installation, separate from the computer command. Your existing iPhone app can stay installed.</p></details>
        ${controlSetupPanel()}</div>
      </section>
      <section id="account-view" class="account-view" aria-labelledby="account-heading" ${section === "account" ? "" : "hidden"}>
        <div class="page-heading"><h1 id="account-heading" tabindex="-1">Account</h1><p>Your sign-in, API key and security settings.</p></div>
        <section class="panel profile-panel"><div class="profile-identity"><span class="profile-avatar" aria-hidden="true">${escape((state.name ?? "P").trim().slice(0, 1).toUpperCase())}</span><div><p class="profile-label">Your account</p><h2>${escape(state.name ?? "Providence account")}</h2><p class="small">Signed in with a passkey</p></div></div><a id="profile-devices" class="secondary profile-device-link" href="${escape(accountHref("devices"))}" data-account-section="devices">${devices.length || devicesError ? "Manage your devices" : "Connect your first computer"}<span aria-hidden="true">↗</span></a></section>
        <div class="account-panels">${aiProcessingPanel()}<details class="panel" id="account-key"><summary>API key and billing <span class="summary-note">${state.keyConfigured ? 'Key saved' : 'Needed for setup'}</span></summary><p>One API key covers hosted coordination and voice for this account. Each computer keeps its own Codex sign-in.</p><p class="small">Enter it privately in the terminal. It is sent over HTTPS and stored encrypted on Providence’s server, which uses it for your requests. It is never returned to this browser.</p><p class="small">OpenAI bills API usage separately from your Codex subscription. Removing the saved key stops hosted coordination and voice; it does not revoke the key at OpenAI or erase encrypted copies in existing private backups.</p>${state.keyConfigured ? '<button id="configure-key" class="secondary">Update key from a terminal</button><button id="remove-key" class="quiet mode-toggle">Stop work and remove saved key</button>' : '<p class="small">The setup command asks for a key when your account needs one.</p>'}<button id="refresh-account" class="quiet mode-toggle">Refresh account status</button><a class="key-link" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Manage OpenAI API keys ↗</a><p class="small">If a key may have leaked, revoke it at OpenAI too.</p></details>
        ${securityPanel()}
        <section class="panel clear-chats-panel" aria-labelledby="clear-chats-heading"><h2 id="clear-chats-heading">Clear all chats</h2><p id="clear-chats-description">Remove all Providence conversations and chat history. Your devices, saved API key and settings stay.</p><div class="clear-chats-actions"><button id="clear-chats" type="button" class="quiet" aria-describedby="clear-chats-description">Clear all chats</button><a href="/">Open Chat ↗</a></div></section>
        ${deleteAccountPanel()}</div>
        <p class="account-note">You can sign in to this account from any of your devices. <a href="/privacy">Privacy and data use</a></p>
      </section>`}
      <p id="status" role="status" aria-live="polite"></p></main></div>`;
  revealAccountAnchor();
  const bind = (id: string, fn: (button: HTMLButtonElement) => Promise<void>) => {
    document.getElementById(id)?.addEventListener("click", e => { const button = e.currentTarget as HTMLButtonElement; void action(button, () => fn(button)); });
  };
  const finishSignIn = async () => {
    await load();
    if (returnToSpatial && state.authenticated && state.keyConfigured && state.aiConsentRequired !== true)
      window.location.assign("/meta");
  };
  const register = async (name: string) => {
    const addingPasskey = state.authenticated;
    const optionsJSON = state.authenticated
      ? await verifiedRequest("add_passkey", "/auth/registration/options", { name })
      : await request("/auth/registration/options", { name });
    const credential = await startRegistration({ optionsJSON });
    await request("/auth/registration/verify", credential);
    if (addingPasskey) await load(); else await finishSignIn();
  };
  bind("signin", async () => { const optionsJSON = await request("/auth/login/options", {}); const result = await startAuthentication({ optionsJSON }); await request("/auth/login/verify", result); await finishSignIn(); });
  bind("logout", async () => { await request("/auth/logout", {}); clearSignedInView(); });
  bind("add-passkey", async () => { await register(state.name ?? "Providence account"); status("Your additional passkey is ready."); });
  bind("allow-ai-processing", async () => {
    if (state.aiConsentRequired !== true || state.aiConsentVersion !== AI_CONSENT_VERSION)
      throw new Error("Reload Account to review the current privacy notice.");
    const result = await request("/auth/ai-consent", { allow: true, version: AI_CONSENT_VERSION });
    if (result?.accepted !== true || result.version !== AI_CONSENT_VERSION) throw new Error("Your choice could not be confirmed. Refresh Account before trying again.");
    await load();
    status("OpenAI processing is allowed. Open Chat when you are ready to send a request.");
  });
  bind("delete-account", async () => {
    const accountId = state.accountId;
    if (!state.accountDeletionAvailable || !accountId) throw new Error("Refresh Account before deleting it.");
    if (!window.confirm(`Permanently delete the Providence account “${state.name ?? "your account"}”? Its chats and hosted file copies will be deleted, connected devices will lose Providence access, and ongoing work will stop. This cannot be undone. Local files, your Codex sign-in and your OpenAI-issued API key stay.`)) return;
    const result = await verifiedRequest("delete_account", "/auth/account/delete", {}, accountId);
    if (result?.accessRevoked !== true || result.externalApiKeyRevoked !== false || result.localFilesDeleted !== false ||
        !((result.deleted === true && result.cleanupPending === false) || (result.deleted === false && result.cleanupPending === true)))
      throw new Error("Account deletion could not be confirmed. Refresh before trying again.");
    clearSignedInView();
    status(result.cleanupPending
      ? "Account access has been revoked and you are signed out. Hosted data cleanup is still pending; it is not yet confirmed deleted."
      : "Your Providence account and its active hosted data were deleted. Local files and your OpenAI-issued API key are unchanged; existing operational backups are not covered by this deletion.");
  });
  bind("clear-chats", async () => {
    if (!window.confirm("Clear all Providence conversations and chat history? This cannot be undone. Your devices, saved API key and settings will stay.")) return;
    const result = await request("/auth/chats/clear", {});
    if (result.cleared !== true) throw new Error("Clearing chats could not be confirmed. Refresh before trying again.");
    status("Chats cleared. Your devices, saved API key and settings are unchanged. Open Chat to start again.");
  });
  bind("refresh-security", async button => { await load(); document.getElementById(button.id)?.focus({ preventScroll: true }); status(securityError || "Sessions and passkeys refreshed."); });
  bind("signout-everywhere", async () => {
    if (!window.confirm("Sign out every Providence session, including this one, and begin stopping account work? Computer registrations, passkeys, history and your saved API key stay. Tasks already sent may need checking on each computer. You can sign in again with your passkey.")) return;
    const result = await request("/auth/sessions/revoke-all", {});
    if (result.signedOutEverywhere !== true || result.workStopping !== true) throw new Error("Signing out everywhere could not be confirmed. Refresh your account and check each computer before relying on work having stopped.");
    clearSignedInView();
    status("You are signed out everywhere in Providence, and account work is stopping. This does not confirm every running task has stopped; check work already sent on each computer.");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-remove-session]").forEach(button => {
    button.addEventListener("click", () => { void action(button, async () => {
      const session = security?.sessions.find(value => value.id === button.dataset.removeSession);
      if (!session) throw new Error("Refresh your sessions before removing access.");
      if (!window.confirm(`${session.current ? "Sign out of this Providence session?" : `Sign out Providence session ${session.id.slice(0, 8)}?`} It will not be able to send new requests. Work already sent may continue.`)) return;
      const result = await request(`/auth/sessions/${encodeURIComponent(session.id)}`, undefined, "DELETE");
      if (result.revoked !== true || typeof result.current !== "boolean") throw new Error("Session removal could not be confirmed. Refresh to check its status.");
      if (result.current) { clearSignedInView(); status("This Providence session is signed out. Work already sent may continue."); }
      else { await load(); status("The session was signed out. Work already sent may continue."); }
    }); });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-remove-passkey]").forEach(button => {
    button.addEventListener("click", () => { void action(button, async () => {
      const passkey = security?.passkeys.find(value => value.id === button.dataset.removePasskey);
      if (!passkey || !security) throw new Error("Refresh your passkeys before removing one.");
      if (security.passkeys.length <= 1) throw new Error("Add another passkey before removing this one.");
      if (!window.confirm(`Remove passkey ${passkey.id.slice(0, 8)}? Confirm using a DIFFERENT passkey. This signs out other Providence sessions; this session remains signed in. Computer registrations, history and your API key stay.`)) return;
      const result = await verifiedRequest("remove_passkey", `/auth/passkeys/${encodeURIComponent(passkey.id)}`, {}, passkey.id, "DELETE");
      if (result.removed !== true || result.otherSessionsRevoked !== true) throw new Error("Passkey removal could not be confirmed. Refresh to check your account.");
      await load(); status("The passkey was removed and your other Providence sessions were signed out. This session remains signed in; work already sent may continue.");
    }); });
  });
  bind("remove-key", async () => {
    if (!window.confirm("Stop Providence work for this account and remove its saved API key? Hosted coordination and voice stop, and active work is interrupted. Computer registrations and history stay. This does not revoke the key at OpenAI or erase existing encrypted backups.")) return;
    await request("/auth/api-key", undefined, "DELETE"); await load();
    status("The saved key was removed and Providence work is stopping. Changes already made cannot be undone; check work already sent to your computers. If the key may be compromised, revoke it at OpenAI too.");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-remove-device]").forEach(button => {
    button.addEventListener("click", () => { void action(button, async () => {
      const device = devices.find(value => value.id === button.dataset.removeDevice);
      if (!device) throw new Error("Refresh your computers before removing access.");
      if (!window.confirm(`Remove ${device.name} from Providence? New work is blocked immediately and its companion is asked to stop. Work already sent may still need checking on that computer. Files, history, your other computers and the shared API key stay.`)) return;
      await request(`/auth/devices/${encodeURIComponent(device.id)}`, undefined, "DELETE");
      await load(); status(`${device.name} access was removed. Its old credential cannot reconnect. Check any work already sent on that computer; a fresh setup is needed to grant access again.`);
    }); });
  });
  bind("watch", async () => {
    const name = "Apple Watch";
    const code = await verifiedRequest("pair_client", "/v1/clients/pair", { name }, name);
    document.getElementById("watch-code")!.textContent = code.code;
    status("Controller pairing approved. Enter this code only on your own Watch.");
  });
  root.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach(button => {
    button.addEventListener("click", () => { void action(button, async () => {
      platform = button.dataset.platform as Platform;
      preserveAccountView(root, render, document, window);
      document.getElementById(button.id)?.focus({ preventScroll: true });
    }); });
  });
  root.querySelectorAll<HTMLAnchorElement>("[data-account-section]").forEach(link => {
    link.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault(); interactionVersion++;
      selectSection(link.dataset.accountSection === "devices" ? "devices" : "account");
    });
  });
  root.querySelectorAll<HTMLAnchorElement>("[data-open-details]").forEach(link => {
    link.addEventListener("click", event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault(); interactionVersion++;
      const id = link.dataset.openDetails ?? "";
      const next = sectionForHash(`#${id}`);
      if (section !== next) selectSection(next);
      const details = document.getElementById(id) as HTMLDetailsElement | null;
      if (details) { details.open = true; details.querySelector("summary")?.focus(); }
    });
  });
  const showSetup = (key: boolean) => {
    configureKey = key; setupOpen = true;
    selectSection("devices", "install-command");
  };
  bind("add-computer", async () => showSetup(false));
  bind("configure-key", async () => showSetup(true));
  bind("show-install", async () => showSetup(false));
  bind("close-setup", async () => {
    setupOpen = false;
    preserveAccountView(root, render, document, window);
    document.getElementById("add-computer")?.focus();
  });
  bind("refresh-account", async button => { await load(); document.getElementById(button.id)?.focus({ preventScroll: true }); status("Your account status is up to date."); });
  bind("refresh-devices", async button => { await load(); document.getElementById(button.id)?.focus({ preventScroll: true }); status(devicesError || "Computer connections refreshed."); });
  bind("copy-command", async (button) => {
    const input = document.getElementById("install-command") as HTMLTextAreaElement;
    try { await navigator.clipboard.writeText(installCommand()); button.textContent = "Copied"; status("Command copied. Paste it into your computer’s terminal."); }
    catch { input.focus(); input.select(); status("The command is selected. Copy it with Command+C on Mac or Ctrl+C on Windows and Linux."); }
  });
  bind("copy-uninstall", async (button) => {
    const input = document.getElementById("uninstall-command") as HTMLTextAreaElement;
    try { await navigator.clipboard.writeText(uninstallCommand()); button.textContent = "Copied"; }
    catch { input.focus(); input.select(); status("The uninstall command is selected. Copy it, then paste it into the terminal on the computer you want to remove."); }
  });
  document.getElementById("install-command")?.addEventListener("click", e => (e.currentTarget as HTMLTextAreaElement).select());
  const decideSetup = async (decision: "approve" | "deny") => {
    if (setupBusy || !setupRequest || setupRequest.status !== "pending") return;
    setupBusy = true;
    for (const id of ["approve-setup", "deny-setup"]) { const button = document.getElementById(id) as HTMLButtonElement | null; if (button) button.disabled = true; }
    try {
      const code = setupRequest.userCode;
      if (decision === "approve") await verifiedRequest("approve_setup", "/auth/setup/approve", { code }, code);
      else await request("/auth/setup/deny", { code });
      setupRequest = { ...setupRequest, status: decision === "approve" ? "approved" : "denied" };
      render();
    } finally {
      setupBusy = false;
      for (const id of ["approve-setup", "deny-setup"]) { const button = document.getElementById(id) as HTMLButtonElement | null; if (button) button.disabled = false; }
    }
  };
  bind("approve-setup", async () => decideSetup("approve"));
  bind("deny-setup", async () => decideSetup("deny"));
  document.getElementById("register")?.addEventListener("submit", e => { e.preventDefault(); const button = (e.currentTarget as HTMLFormElement).querySelector("button")!; void action(button, () => register((document.getElementById("name") as HTMLInputElement).value)); });
}
let accountRefresh: ReturnType<typeof startAccountRefresh> | undefined;
function enableAccountRefresh() {
  if (accountRefresh) return;
  accountRefresh = startAccountRefresh({
    authenticated: () => state.authenticated,
    busy: () => interacting() || !!loadPromise,
    refresh: signal => load({ automatic: true, signal }),
    onDispose: () => { accountRefresh = undefined; },
  });
}
window.addEventListener("hashchange", () => {
  const next = sectionForHash(location.hash);
  if (next === section) { revealedAnchor = ""; revealAccountAnchor(); return; }
  section = next; interactionVersion++;
  preserveAccountView(root, render, document, window);
  document.getElementById(`${section}-heading`)?.focus({ preventScroll: true });
});
window.addEventListener("pageshow", () => { enableAccountRefresh(); accountRefresh?.request(); });
enableAccountRefresh();
void load().catch(() => {
  root.innerHTML = `<div class="account-shell">${sidebar()}<main class="signin-main"><section class="panel signin-panel"><h1>Account is unavailable</h1><p>Providence could not read your account details. Your account has not been changed.</p><button id="reload-account" class="primary" type="button">Reload Account</button></section></main></div>`;
  document.getElementById("reload-account")?.addEventListener("click", () => window.location.reload());
});
