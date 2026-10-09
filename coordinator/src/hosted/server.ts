import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { Accounts, AIConsentError, AI_CONSENT_VERSION, digest } from "./accounts.js";
import { StepUpError, stepUpIntent } from "./step-up.js";
import { Workspaces, ClearChatsError } from "./workspaces.js";
import { LiveConversationManager, LiveConversationError } from "./live-conversation.js";
import { AccountDeletion, AccountDeletionError } from "./account-deletion.js";
import { TerminalSetup, SetupError } from "./terminal-setup.js";
import { DeviceAccess, DeviceAccessError } from "./device-access.js";
import { appleAppIdsFromEnvironment, appleAssociationDocument } from "./associated-domains.js";
import { readBody, assetFile } from "../server.js";

export function createHostedServer(settings: { directory: string; origin: string; encryptionKey: Buffer; webRoot?: string; model?: string; appleAppIds?: readonly string[]; validateApiKey?: (key: string) => Promise<boolean> }) {
  const origin = new URL(settings.origin).origin;
  const url = new URL(origin), secure = url.protocol === "https:";
  if (!secure && url.hostname !== "localhost") throw new Error("Hosted accounts require HTTPS");
  const appleAssociation = appleAssociationDocument(settings.appleAppIds);
  const cookieName = secure ? "__Host-providence" : "providence";
  mkdirSync(settings.directory, { recursive: true, mode: 0o700 });
  const accounts = new Accounts(resolve(settings.directory, "accounts.sqlite"), settings.encryptionKey);
  const workspaces = new Workspaces(settings.directory, origin, accounts, settings.model);
  const deviceAccess = new DeviceAccess(accounts, workspaces);
  const liveVoice = new LiveConversationManager(accounts, workspaces);
  const webRoot = settings.webRoot ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  const setup = new TerminalSetup(accounts, workspaces, origin, settings.encryptionKey, settings.validateApiKey ?? (async key => {
    const response = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: "error" });
    await response.body?.cancel(); return response.ok;
  }));
  const rates = new Map<string, { n: number; expires: number }>();
  const sessionConnections = new Map<string, Set<{ destroy(): unknown }>>();
  const trackSession = (raw: string, connection: { destroy(): unknown; once(event: "close", listener: () => void): unknown }) => {
    const hash = digest(raw), connections = sessionConnections.get(hash) ?? new Set();
    connections.add(connection); sessionConnections.set(hash, connections);
    connection.once("close", () => { connections.delete(connection); if (!connections.size) sessionConnections.delete(hash); });
  };
  const closeSessions = (hashes: string[]) => {
    void liveVoice.revokeSessions(hashes).catch(() => console.error("A live voice session did not confirm closure."));
    for (const hash of hashes) {
    for (const connection of sessionConnections.get(hash) ?? []) connection.destroy();
    sessionConnections.delete(hash);
  } };
  const accountDeletion = new AccountDeletion(accounts, workspaces, async (account, hashes) => {
    closeSessions(hashes);
    await liveVoice.revokeAccount(account);
  });
  void accountDeletion.retryPending();
  const passkeyAttemptRoutes = new Set([
    "/auth/login/options", "/auth/login/verify",
    "/auth/registration/options", "/auth/registration/verify",
    "/auth/step-up/options", "/auth/step-up/verify",
  ]);
  const cookie = (name: string, value: string, seconds: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`;
  const cookies = (req: IncomingMessage) => Object.fromEntries((req.headers.cookie ?? "").split(";").map(s => s.trim().split("=")).filter(pair => pair.length === 2));
  const auth = (req: IncomingMessage) => {
    const value = req.headers.authorization;
    const raw = value && value !== "Bearer providence-account-session" ? value.startsWith("Bearer ") ? value.slice(7) : "" : cookies(req)[cookieName];
    return { raw, session: accounts.authenticate(raw) };
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body));
  };
  const sameOrigin = (req: IncomingMessage) => req.headers.origin === origin;
  function limited(key: string, max: number) {
    const now = Date.now();
    for (const [key, entry] of rates) if (entry.expires <= now) rates.delete(key);
    if (rates.size >= 10000 && !rates.has(key)) return true;
    const entry = rates.get(key) ?? { n: 0, expires: now + 60_000 }; entry.n++; rates.set(key, entry); return entry.n > max;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Permissions-Policy", "microphone=(self), xr-spatial-tracking=(self), publickey-credentials-get=(self), publickey-credentials-create=(self)");
    let path: string;
    try { path = new URL(req.url ?? "/", origin).pathname; } catch { return json(res, 400, { error: "Invalid request" }); }
    if (path === "/.well-known/apple-app-site-association" || path === "/apple-app-site-association") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return json(res, 405, { error: "Method not allowed" });
      }
      const body = appleAssociation ?? JSON.stringify({ error: "Not found" });
      res.writeHead(appleAssociation ? 200 : 404, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": appleAssociation ? "public, max-age=300, must-revalidate" : "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    const { raw, session } = auth(req);
    const owner = session?.scope === "owner";
    const currentOwner = () => {
      const current = accounts.authenticate(raw);
      return current?.scope === "owner" && current.account === session?.account;
    };
    const peer = req.socket.remoteAddress ?? "unknown";
    // The public entry point binds loopback behind nginx, which overwrites X-Real-IP.
    const ip = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer) ? String(req.headers["x-real-ip"] ?? peer) : peer;
    if (req.headers.origin && !sameOrigin(req)) return json(res, 403, { error: "Origin not allowed" });
    if (path.startsWith("/auth") && req.method !== "GET" && !sameOrigin(req)) return json(res, 403, { error: "Use this site's account page" });
    if (req.method === "POST" && passkeyAttemptRoutes.has(path) && limited(`auth:${ip}`, 40)) return json(res, 429, { error: "Too many sign-in requests; wait a minute" });
    if (session && limited(`api:${session.account}`, 900)) return json(res, 429, { error: "Too many requests; wait a minute" });
    try {
      // Match the tenant router's filtered segments, including its accepted
      // repeated/trailing slash forms, before any remote worker dispatch.
      const aiPathParts = path.split("/").filter(Boolean);
      const chatMessage = aiPathParts.length === 4 && aiPathParts[0] === "v1" && aiPathParts[1] === "chats" && aiPathParts[3] === "messages";
      const resumesWork = aiPathParts[0] === "v1" && (
        (aiPathParts[1] === "approvals" && aiPathParts.length === 3) ||
        (aiPathParts[1] === "phone" && aiPathParts.length === 4 && aiPathParts[3] === "resume") ||
        (aiPathParts[1] === "host-bridge" && aiPathParts[2] === "jobs" && aiPathParts.length === 5 && ["claim", "start"].includes(aiPathParts[4])) ||
        (aiPathParts[1] === "tasks" && aiPathParts.length === 4 && aiPathParts[3] === "artifacts")
      );
      if (session && req.method === "POST" &&
          (["/v1/messages", "/v1/chats", "/v1/phone", "/v1/host-bridge/jobs", "/v1/transcriptions", "/v1/transcriptions/live-sessions", "/v1/speech", "/v1/live-voice/sessions"].includes(path) ||
            chatMessage || resumesWork) && !accounts.hasAIConsent(session.account))
        throw new AIConsentError();
      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, service: "providence-accounts" });
      if (req.method === "GET" && path === "/auth/session") {
        const account = owner ? accounts.get(session!.account) : undefined;
        return json(res, 200, { hosted: true, authenticated: !!account, ...(account ? {
          name: account.name, accountId: account.id, keyConfigured: !!account.key, accountDeletionAvailable: true,
          aiConsentRequired: !accounts.hasAIConsent(account.id), aiConsentVersion: AI_CONSENT_VERSION,
        } : {}) });
      }
      if (req.method === "POST" && path === "/auth/ai-consent") {
        if (!owner) return json(res, 401, { error: "Sign in to review AI processing" });
        const input = await readBody(req, 1024);
        if (!input || typeof input !== "object" || Array.isArray(input) || input.allow !== true ||
            Object.keys(input).some(key => !["allow", "version"].includes(key))) return json(res, 400, { error: "Choose Allow AI processing to continue" });
        if (!currentOwner()) return json(res, 401, { error: "Sign in again before accepting AI processing" });
        return json(res, 200, accounts.acceptAIConsent(session!.account, input.version));
      }
      if (req.method === "POST" && path === "/auth/account/delete") {
        if (!owner) return json(res, 401, { error: "Sign in to delete your account" });
        const input = await readBody(req, 1024);
        if (!input || typeof input !== "object" || Array.isArray(input) ||
            Object.keys(input).some(key => key !== "stepUpToken") || typeof input.stepUpToken !== "string")
          return json(res, 400, { error: "Confirm account deletion with your passkey" });
        if (!currentOwner()) return json(res, 401, { error: "Sign in again before deleting your account" });
        const result = await accountDeletion.delete(raw!, input.stepUpToken);
        res.setHeader("Set-Cookie", [cookie(cookieName, "", 0), cookie(cookieName + "-challenge", "", 0), cookie(cookieName + "-stepup", "", 0)]);
        return json(res, result.deleted ? 200 : 202, result);
      }
      if (req.method === "POST" && path === "/auth/chats/clear") {
        if (!owner) return json(res, 401, { error: "Sign in to clear your chats" });
        const input = await readBody(req, 1024);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length)
          return json(res, 400, { error: "Use the Clear all chats button in Account" });
        if (!currentOwner()) return json(res, 401, { error: "Sign in again before clearing chats" });
        await workspaces.clearChats(session!.account, async () => {
          if (!currentOwner()) throw new ClearChatsError(401, "Sign in again before clearing chats");
          await liveVoice.revokeAccount(session!.account);
          if (!currentOwner()) throw new ClearChatsError(401, "Sign in again before clearing chats");
        });
        return json(res, 200, { cleared: true });
      }
      if (req.method === "GET" && path === "/auth/security") {
        if (!owner) return json(res, 401, { error: "Sign in to view account security" });
        return json(res, 200, accounts.security(session!.account, raw!));
      }
      if (req.method === "POST" && path === "/auth/step-up/options") {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const epoch = accounts.revocationEpoch(session!.account);
        const input = await readBody(req, 4096), intent = stepUpIntent(input.action, input.target);
        if (!currentOwner() || accounts.revocationEpoch(session!.account) !== epoch) throw new StepUpError();
        if (intent.action === "delete_account" && intent.target !== session!.account) throw new StepUpError();
        const credentials = accounts.security(session!.account, raw!).passkeys.filter(credential => intent.action !== "remove_passkey" || credential.id !== intent.target);
        if (!credentials.length) throw new StepUpError();
        const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "required",
          allowCredentials: credentials.map(credential => ({ id: credential.id })) });
        if (!currentOwner() || accounts.revocationEpoch(session!.account) !== epoch) throw new StepUpError();
        const challenge = accounts.challenge({ kind: "step-up", challenge: options.challenge, account: session!.account,
          sessionHash: digest(raw!), epoch, ...intent });
        res.setHeader("Set-Cookie", cookie(cookieName + "-stepup", challenge, 300));
        return json(res, 200, options);
      }
      if (req.method === "POST" && path === "/auth/step-up/verify") {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const challenge = accounts.consumeChallenge(cookies(req)[cookieName + "-stepup"] ?? "");
        if (challenge.kind !== "step-up" || challenge.account !== session!.account || challenge.sessionHash !== digest(raw!) ||
            challenge.epoch !== accounts.revocationEpoch(session!.account)) throw new StepUpError();
        const input = await readBody(req, 64000), response = input.response, credential = accounts.passkey(response?.id);
        if (!credential || credential.account !== session!.account || (challenge.action === "remove_passkey" && credential.id === challenge.target)) throw new StepUpError();
        const verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin,
          expectedRPID: url.hostname, requireUserVerification: true,
          credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")), counter: credential.counter, transports: JSON.parse(credential.transports) } });
        if (!verified.verified || !currentOwner() || challenge.epoch !== accounts.revocationEpoch(session!.account)) throw new StepUpError();
        const updated = accounts.db.prepare("UPDATE passkeys SET counter=? WHERE id=? AND account=? AND counter=?")
          .run(verified.authenticationInfo.newCounter, credential.id, session!.account, credential.counter);
        if (updated.changes !== 1) throw new StepUpError();
        const proof = accounts.issueStepUp(raw!, credential.id, challenge.action, challenge.target);
        res.setHeader("Set-Cookie", cookie(cookieName + "-stepup", "", 0));
        return json(res, 200, proof);
      }
      if (req.method === "POST" && path === "/auth/sessions/revoke-all") {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const hashes = accounts.revokeSessions(session!.account);
        accounts.clearSensitiveIntents(session!.account); setup.invalidateAccount(session!.account); closeSessions(hashes);
        void workspaces.disable(session!.account).catch(() => console.error("Hosted workspace stop requires inspection after session revocation."));
        res.setHeader("Set-Cookie", [cookie(cookieName, "", 0), cookie(cookieName + "-challenge", "", 0), cookie(cookieName + "-stepup", "", 0)]);
        return json(res, 202, { signedOutEverywhere: true, workStopping: true });
      }
      const sessionRemoval = /^\/auth\/sessions\/([0-9a-f-]{36})$/.exec(path);
      if (req.method === "DELETE" && sessionRemoval) {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const removed = accounts.revokeSession(session!.account, sessionRemoval[1]);
        if (!removed) return json(res, 404, { error: "Unknown account session" });
        closeSessions([removed.hash]);
        const current = removed.hash === digest(raw!);
        if (current) res.setHeader("Set-Cookie", [cookie(cookieName, "", 0), cookie(cookieName + "-challenge", "", 0), cookie(cookieName + "-stepup", "", 0)]);
        return json(res, 200, { revoked: true, current });
      }
      const passkeyRemoval = /^\/auth\/passkeys\/([A-Za-z0-9_-]{1,2048})$/.exec(path);
      if (req.method === "DELETE" && passkeyRemoval) {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const input = await readBody(req, 1024), proof = accounts.consumeStepUp(raw!, input.stepUpToken, "remove_passkey", passkeyRemoval[1]);
        try { accounts.removePasskey(session!.account, passkeyRemoval[1], proof.credentialId); }
        catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : "Passkey removal was not permitted" }); }
        closeSessions(accounts.revokeSessions(session!.account, raw!));
        accounts.clearSensitiveIntents(session!.account); setup.invalidateAccount(session!.account);
        return json(res, 200, { removed: true, otherSessionsRevoked: true });
      }
      if (req.method === "POST" && path === "/auth/activity") {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        const body = await readBody(req, 1024);
        if (!currentOwner()) return json(res, 401, { error: "This session was revoked" });
        if (typeof body.clientId !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(body.clientId) || typeof body.active !== "boolean") return json(res, 400, { error: "Invalid activity" });
        await workspaces.noteActivity(session!.account, body.clientId, body.active);
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/auth/devices") {
        if (!owner) return json(res, 401, { error: "Sign in to view your computers" });
        const devices = await workspaces.inspectDevices(session!.account);
        if (!currentOwner()) return json(res, 401, { error: "This session was revoked" });
        return json(res, 200, { devices });
      }
      if (req.method === "POST" && path === "/auth/registration/options") {
        const epoch = owner ? accounts.revocationEpoch(session!.account) : undefined;
        const input = await readBody(req, 1024);
        if (owner && (!currentOwner() || accounts.revocationEpoch(session!.account) !== epoch)) throw new StepUpError();
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) return json(res, 400, { error: "Enter a name of 1–80 characters" });
        const proof = owner ? accounts.consumeStepUp(raw!, input.stepUpToken, "add_passkey") : undefined;
        const count = accounts.db.prepare("SELECT count(*) AS n FROM accounts").get() as { n: number };
        if (!owner && count.n >= 1000) return json(res, 503, { error: "New registrations are temporarily full" });
        const userID = owner ? session!.account : randomUUID();
        const options = await generateRegistrationOptions({ rpName: "Providence", rpID: url.hostname, userName: name,
          userID: Buffer.from(userID), attestationType: "none", authenticatorSelection: { residentKey: "required", userVerification: "required" } });
        if (owner && (!currentOwner() || accounts.revocationEpoch(session!.account) !== epoch)) throw new StepUpError();
        const challenge = accounts.challenge({ kind: "registration", challenge: options.challenge, name, userID, account: owner ? session!.account : null,
          ...(owner ? { sessionHash: digest(raw!), verifiedCredential: proof!.credentialId, epoch } : {}) });
        res.setHeader("Set-Cookie", cookie(cookieName + "-challenge", challenge, 300)); return json(res, 200, options);
      }
      if (req.method === "POST" && path === "/auth/registration/verify") {
        const challenge = accounts.consumeChallenge(cookies(req)[cookieName + "-challenge"] ?? "");
        if (challenge.kind !== "registration" || (challenge.account && (!owner || challenge.account !== session?.account || challenge.sessionHash !== digest(raw!) ||
            challenge.epoch !== accounts.revocationEpoch(challenge.account)))) throw new Error("Invalid registration");
        const response = await readBody(req, 64000);
        const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: url.hostname, requireUserVerification: true });
        if (!result.verified || !result.registrationInfo) throw new Error("Passkey verification failed");
        if (challenge.account && (!currentOwner() || challenge.epoch !== accounts.revocationEpoch(challenge.account) ||
            accounts.passkey(challenge.verifiedCredential)?.account !== challenge.account)) throw new StepUpError();
        accounts.db.exec("BEGIN IMMEDIATE");
        let account;
        try { account = challenge.account ? accounts.get(challenge.account)! : accounts.create(challenge.name, challenge.userID);
          accounts.addPasskey(account.id, result.registrationInfo.credential); accounts.db.exec("COMMIT");
        } catch (error) { accounts.db.exec("ROLLBACK"); throw error; }
        res.setHeader("Set-Cookie", [cookie(cookieName, accounts.session(account.id), 7 * 86400), cookie(cookieName + "-challenge", "", 0)]);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/auth/login/options") {
        const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "required" });
        const challenge = accounts.challenge({ kind: "login", challenge: options.challenge });
        res.setHeader("Set-Cookie", cookie(cookieName + "-challenge", challenge, 300)); return json(res, 200, options);
      }
      if (req.method === "POST" && path === "/auth/login/verify") {
        const challenge = accounts.consumeChallenge(cookies(req)[cookieName + "-challenge"] ?? "");
        if (challenge.kind !== "login") throw new Error("Invalid sign-in");
        const response = await readBody(req, 64000), credential = accounts.passkey(response.id);
        if (!credential) throw new Error("Passkey not found");
        const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: url.hostname, requireUserVerification: true,
          credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")), counter: credential.counter, transports: JSON.parse(credential.transports) } });
        if (!result.verified) throw new Error("Passkey verification failed");
        const updated = accounts.db.prepare("UPDATE passkeys SET counter=? WHERE id=? AND counter=?").run(result.authenticationInfo.newCounter, credential.id, credential.counter);
        if (updated.changes !== 1) throw new Error("Passkey state changed; sign in again");
        res.setHeader("Set-Cookie", [cookie(cookieName, accounts.session(credential.account), 7 * 86400), cookie(cookieName + "-challenge", "", 0)]);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/auth/logout") {
        if (raw) { accounts.logout(raw); closeSessions([digest(raw)]); }
        res.setHeader("Set-Cookie", [cookie(cookieName, "", 0), cookie(cookieName + "-challenge", "", 0), cookie(cookieName + "-stepup", "", 0)]);
        return json(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && path === "/auth/api-key") {
        if (!owner) return json(res, 401, { error: "Sign in first" });
        setup.invalidateAccount(session!.account);
        void liveVoice.revokeAccount(session!.account).catch(() => console.error("Live voice closure requires inspection."));
        accounts.db.prepare("UPDATE accounts SET key=NULL WHERE id=?").run(session!.account);
        const stopping = workspaces.disable(session!.account);
        void stopping.catch(() => console.error("Hosted workspace stop requires inspection after key removal."));
        return json(res, 202, { ok: true, keyRemoved: true, workStopping: true, providerKeyRevoked: false });
      }
      const removal = /^\/(?:auth|v1)\/devices\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && removal) {
        if (!session) return json(res, 401, { error: "Sign in first" });
        if (!owner) return json(res, 403, { error: "Only the account owner can remove computer access" });
        if (!sameOrigin(req)) return json(res, 403, { error: "Use your signed-in Providence page" });
        return json(res, 200, await deviceAccess.owner(session.account, decodeURIComponent(removal[1])));
      }
      if (req.method === "POST" && path === "/device/revoke") {
        if (req.headers.origin || req.headers.cookie) return json(res, 403, { error: "Use the computer's local removal command" });
        if (limited(`device-revoke:${ip}`, 20)) return json(res, 429, { error: "Too many removal attempts; try again later" });
        const input = await readBody(req, 1024);
        return json(res, 200, await deviceAccess.self(input.deviceId, req.headers.authorization));
      }
      if (req.method === "POST" && path === "/auth/api-key") {
        return json(res, 410, { error: "API keys are entered only through the Providence terminal setup command." });
      }
      if (path.startsWith("/setup/")) {
        if (req.method !== "POST") return json(res, 405, { error: "Use the terminal setup command" });
        if (req.headers.origin || req.headers.cookie) return json(res, 403, { error: "Use the terminal setup command; browser credentials are not accepted here" });
        if (limited(`setup:${ip}`, 120)) return json(res, 429, { error: "Too many setup requests; wait a minute" });
        if (path === "/setup/start") {
          if (limited(`setup-start:${ip}`, 10)) return json(res, 429, { error: "Too many setup attempts; wait a minute" });
          await readBody(req, 1024); return json(res, 200, setup.start());
        }
        if (path === "/setup/poll") {
          const input = await readBody(req, 1024), result = setup.poll(input.deviceCode);
          return json(res, result.status === "pending" ? 202 : 200, result);
        }
        const setupToken = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
        if (path === "/setup/api-key") { const input = await readBody(req, 4096); return json(res, 200, await setup.setKey(setupToken, input.apiKey)); }
        if (path === "/setup/connect") return json(res, 200, await setup.connect(setupToken, await readBody(req, 8192)));
        return json(res, 404, { error: "Not found" });
      }
      if (path === "/auth/setup" || path === "/auth/setup/approve" || path === "/auth/setup/deny") {
        if (!owner) return json(res, 401, { error: "Sign in before approving terminal setup" });
        if (path === "/auth/setup" && req.method === "GET") return json(res, 200, setup.inspect(new URL(req.url!, origin).searchParams.get("code"), session!.account));
        if (req.method === "POST") {
          const input = await readBody(req, 1024);
          if (path === "/auth/setup/approve") {
            accounts.consumeStepUp(raw!, input.stepUpToken, "approve_setup", input.code);
            return json(res, 200, setup.approve(input.code, session!.account));
          }
          if (path === "/auth/setup/deny") {
            if (!currentOwner()) return json(res, 401, { error: "This session was revoked" });
            return json(res, 200, setup.deny(input.code, session!.account));
          }
        }
        return json(res, 405, { error: "Unsupported method" });
      }
      if (req.method === "GET" && ["/install.sh", "/install.ps1"].includes(path)) {
        const file = fileURLToPath(new URL(`../../install/${path.slice(1)}`, import.meta.url));
        if (!existsSync(file)) return json(res, 503, { error: "Installer is being prepared" });
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Disposition": `inline; filename="${path.slice(1)}"` });
        return res.end(readFileSync(file));
      }
      if (req.method === "GET" && path.startsWith("/downloads/")) {
        const versioned = /^\/downloads\/([a-f0-9]{64})\/(providence-companion\.(?:zip|tar\.gz))$/.exec(path);
        const legacy = ["/downloads/providence-companion.zip", "/downloads/providence-companion.tar.gz", "/downloads/companion-manifest.json"].includes(path);
        if (!versioned && !legacy) return json(res, 404, { error: "Not found" });
        const file = resolve(settings.directory, "." + path);
        if (!existsSync(file)) return json(res, 503, { error: "The companion download is being prepared" });
        const type = path.endsWith(".json") ? "application/json" : path.endsWith(".zip") ? "application/zip" : "application/gzip";
        res.writeHead(200, { "Content-Type": type, "Cache-Control": versioned ? "public, max-age=31536000, immutable" : "no-store",
          ...(path.endsWith(".json") ? {} : { "Content-Disposition": `attachment; filename="${path.split("/").at(-1)}"` }) });
        return res.end(readFileSync(file));
      }
      if (req.method === "GET" && (path === "/" || path === "/account" || path === "/account/" || path === "/privacy" || path === "/privacy/" || path.startsWith("/assets/") || path === "/favicon.svg")) {
        const isAccount = path.startsWith("/account") || (path === "/" && !owner);
        const file = path.startsWith("/assets/") ? assetFile(webRoot, path) : resolve(webRoot, path === "/favicon.svg" ? "favicon.svg" : path === "/privacy" || path === "/privacy/" ? "privacy.html" : isAccount ? "account.html" : "index.html");
        if (!file || !existsSync(file)) return json(res, 404, { error: "Page unavailable" });
        res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" } as Record<string, string>)[extname(file)] ?? "application/octet-stream");
        res.setHeader("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
        return res.end(readFileSync(file));
      }
      if (["/pair/exchange", "/client/exchange"].includes(path) && req.method === "POST") {
        if (limited(`pair:${ip}`, 12)) return json(res, 429, { error: "Too many attempts; wait a minute" });
        const input = await readBody(req, 2048);
        if (typeof input.code !== "string" || input.code.length > 50) throw new Error("Invalid code");
        const intent = accounts.consumeCodeIntent(input.code, path.startsWith("/pair") ? "device" : "client"), account = intent.account;
        const workspace = await workspaces.get(account);
        if (!accounts.codeIntentActive(intent)) return json(res, 401, { error: "Pairing authorization was revoked" });
        const response = await fetch(`http://127.0.0.1:${workspace.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(input), signal: AbortSignal.timeout(10000) });
        const body = await response.json() as any;
        if (!accounts.codeIntentActive(intent)) {
          if (response.ok) {
            if (path === "/pair/exchange") await workspaces.revokeDevice(account, body.deviceId, body.token);
            else await workspaces.revokeClient(account, body.clientId);
          }
          return json(res, 401, { error: "Pairing authorization was revoked" });
        }
        if (response.ok) {
          if (path === "/pair/exchange") accounts.db.prepare("INSERT INTO devices VALUES(?,?)").run(body.deviceId, account);
          else accounts.session(account, "client", Math.max(0, Date.parse(body.expiresAt) - Date.now()), body.token);
        }
        return json(res, response.status, body);
      }
      if (path === "/v1/live-voice" || path.startsWith("/v1/live-voice/")) {
        if (!owner) return json(res, 401, { error: "Sign in to use live voice" });
        const liveOwner = { account: session!.account, raw: raw! };
        if (req.method === "GET" && path === "/v1/live-voice") return json(res, 200, liveVoice.capability(liveOwner));
        if (req.method !== "POST") return json(res, 405, { error: "Use POST for voice session controls" });
        if (!sameOrigin(req)) return json(res, 403, { error: "Use your signed-in Providence page" });
        if (path === "/v1/live-voice/sessions") {
          if (limited(`live-voice:${session!.account}`, 6)) return json(res, 429, { error: "Wait a moment before starting voice again" });
          const body = await readBody(req, 64_000);
          if (typeof body.sdp !== "string" || !body.sdp.startsWith("v=0") || body.sdp.length > 60_000 ||
              typeof body.chatId !== "string" || !body.chatId || body.chatId.length > 200 ||
              Object.keys(body).some(key => !["sdp", "chatId"].includes(key))) return json(res, 400, { error: "Invalid voice connection" });
          const controller = new AbortController();
          req.once("aborted", () => controller.abort());
          res.once("close", () => { if (!res.writableEnded) controller.abort(); });
          const connection = await liveVoice.create(liveOwner, body, controller.signal);
          return json(res, 201, connection);
        }
        const control = /^\/v1\/live-voice\/sessions\/([^/]{1,200})\/(heartbeat|end)$/.exec(path);
        if (control) {
          const body = await readBody(req, 1024);
          if (Object.keys(body).length) return json(res, 400, { error: "Invalid voice session control" });
          return json(res, 200, control[2] === "end" ? await liveVoice.end(liveOwner, control[1]) : liveVoice.heartbeat(liveOwner, control[1]));
        }
        return json(res, 404, { error: "Unknown voice route" });
      }
      const spatialEntry = path === "/meta" || path === "/meta/";
      if (spatialEntry && req.method === "GET" && !owner) {
        res.writeHead(303, { Location: "/account?next=%2Fmeta", "Cache-Control": "no-store" }); return res.end();
      }
      if (!spatialEntry && !path.startsWith("/v1/") && !path.startsWith("/quest")) return json(res, 404, { error: "Not found" });
      if (!session) return json(res, 401, { error: "Sign in to Providence" });
      if (owner && !["GET", "HEAD"].includes(req.method ?? "") && !sameOrigin(req)) return json(res, 403, { error: "Use your signed-in Providence page" });
      if (!accounts.get(session.account)?.key) return json(res, 409, { error: "Add your OpenAI API key in Account settings" });
      const workspace = await workspaces.get(session.account);
      if (accounts.authenticate(raw)?.account !== session.account) return json(res, 401, { error: "This session was revoked" });
      const authorization = owner ? `Bearer ${workspace.token}` : `Bearer ${raw}`;
      if (req.method === "POST" && ["/v1/devices/pair", "/v1/clients/pair"].includes(path)) {
        if (!owner) return json(res, 403, { error: "Account sign-in required" });
        const input = await readBody(req, 2048);
        accounts.consumeStepUp(raw!, input.stepUpToken, path.includes("devices") ? "pair_device" : "pair_client", input.name);
        const epoch = accounts.revocationEpoch(session.account);
        const { stepUpToken: _proof, ...pairingInput } = input;
        const response = await fetch(`http://127.0.0.1:${workspace.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization, Origin: origin }, body: JSON.stringify(pairingInput), signal: AbortSignal.timeout(10000) });
        const body = await response.json() as any;
        if (accounts.authenticate(raw)?.account !== session.account || accounts.revocationEpoch(session.account) !== epoch)
          return json(res, 401, { error: "Pairing authorization was revoked" });
        if (response.ok) accounts.code(session.account, path.includes("devices") ? "device" : "client", body.code, raw!);
        return json(res, response.status, body);
      }
      // Only the authenticated account chooses the internal upstream. No caller-supplied host or account ID.
      const upstream = httpRequest({ host: "127.0.0.1", port: workspace.port, path: spatialEntry ? "/quest/" : req.url, method: req.method,
        headers: { authorization, ...(req.headers.origin ? { origin } : {}), "content-type": req.headers["content-type"] ?? "application/json", ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}) } }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      trackSession(raw!, upstream);
      trackSession(raw!, res);
      upstream.on("error", () => { if (!res.headersSent) json(res, 502, { error: "Workspace connection unavailable" }); else res.destroy(); });
      req.on("aborted", () => upstream.destroy()); res.on("close", () => upstream.destroy()); req.pipe(upstream);
    } catch (error) {
      if (error instanceof ClearChatsError && !res.headersSent) return json(res, error.status, { error: error.message });
      if (error instanceof AIConsentError && !res.headersSent) return json(res, error.status,
        { error: error.message, errorCode: error.errorCode, aiConsentVersion: error.aiConsentVersion });
      if (error instanceof AccountDeletionError && !res.headersSent) return json(res, error.status, { error: error.message });
      if (error instanceof LiveConversationError && !res.headersSent) return json(res, error.status,
        { error: error.message, ...(error.errorCode ? { errorCode: error.errorCode } : {}) });
      if (error instanceof StepUpError && !res.headersSent) return json(res, error.status, { error: error.message, errorCode: error.errorCode });
      if (error instanceof DeviceAccessError && !res.headersSent) return json(res, error.status, { error: error.message });
      if (error instanceof SetupError && !res.headersSent) return json(res, error.status, { error: error.message });
      if (!res.headersSent) json(res, 400, { error: "The request could not be completed. Check your sign-in, configuration and active tasks." });
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    const reject = () => { socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); };
    try {
      const path = new URL(req.url ?? "/", origin);
      let account: string | undefined, clientRaw: string | undefined;
      if (path.pathname === "/worker" && !req.headers.origin) {
        const row = accounts.db.prepare("SELECT account FROM devices WHERE id=?").get(path.searchParams.get("deviceId") ?? "") as { account: string } | undefined; account = row?.account;
      } else if (path.pathname === "/v1/transcriptions/live" && req.headers.origin === origin) { const client = auth(req); account = client.session?.account; clientRaw = client.raw;
        if (account && !accounts.hasAIConsent(account)) return reject(); }
      if (!account) return reject();
      const workspace = await workspaces.get(account);
      if (clientRaw && accounts.authenticate(clientRaw)?.account !== account) return reject();
      // The tenant server independently authenticates the device token or single-use voice ticket.
      const upstream = connect(workspace.port, "127.0.0.1", () => {
        const headers = Object.entries(req.headers).filter(([key]) => !["cookie", "x-real-ip", "x-forwarded-for"].includes(key)).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
        upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`); if (head.length) upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
      });
      if (clientRaw) { trackSession(clientRaw, upstream); trackSession(clientRaw, socket); }
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy()); socket.on("close", () => upstream.destroy());
    } catch { reject(); }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  return { server, accounts, workspaces, setup, async close() { await accountDeletion.close(); await liveVoice.close(); await workspaces.stop(); server.close(); accounts.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const keyFile = process.env.PROVIDENCE_ACCOUNT_KEY_FILE;
  if (!keyFile) throw new Error("Set PROVIDENCE_ACCOUNT_KEY_FILE to a private 32-byte encryption key file");
  const app = createHostedServer({ directory: resolve(process.env.PROVIDENCE_HOSTED_DATA_DIR ?? ".providence/hosted"),
    origin: process.env.PROVIDENCE_PUBLIC_ORIGIN ?? "https://providence.hani.so", encryptionKey: readFileSync(keyFile), model: process.env.PROVIDENCE_HOSTED_MODEL,
    appleAppIds: appleAppIdsFromEnvironment(process.env.PROVIDENCE_APPLE_APP_IDS) });
  app.server.listen(Number(process.env.PORT ?? 8788), "127.0.0.1", () => console.log("Providence account service listening on loopback"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void app.close(); });
}
