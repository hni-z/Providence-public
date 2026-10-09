import test from "node:test";
import assert from "node:assert/strict";
import { parseAccountSecurity, verifiedAccountRequest } from "../web/src/account-security.js";

test("enrollment waits for existing-passkey verification and binds the exact displayed setup code", async () => {
  const calls: string[] = [];
  let allowVerification!: () => void;
  const verification = new Promise<void>(resolve => { allowVerification = resolve; });
  const request = async (path: string, body: any) => {
    calls.push(path);
    if (path === "/auth/step-up/options") {
      assert.deepEqual(body, { action: "approve_setup", target: "ABCD-EFGH" });
      return { challenge: "synthetic-challenge" };
    }
    if (path.endsWith("/verify")) {
      assert.deepEqual(body, { response: { id: "existing-credential" } });
      return { stepUpToken: "synthetic-single-use-proof" };
    }
    assert.equal(path, "/auth/setup/approve");
    assert.deepEqual(body, { code: "ABCD-EFGH", stepUpToken: "synthetic-single-use-proof" });
    return { ok: true };
  };
  const pending = verifiedAccountRequest({ request, authenticate: async options => {
    assert.deepEqual(options, { challenge: "synthetic-challenge" });
    await verification;
    return { id: "existing-credential" };
  } }, "approve_setup", "/auth/setup/approve", { code: "ABCD-EFGH" }, "ABCD-EFGH");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["/auth/step-up/options"]);
  allowVerification();
  assert.deepEqual(await pending, { ok: true });
  assert.deepEqual(calls, ["/auth/step-up/options", "/auth/step-up/verify", "/auth/setup/approve"]);
});

test("cancelled or rejected authentication never submits a sensitive request", async () => {
  for (const rejectedBy of ["authenticator", "server", "missing-proof"]) {
    const calls: string[] = [];
    await assert.rejects(verifiedAccountRequest({
      request: async path => {
        calls.push(path);
        if (path === "/auth/step-up/options") return {};
        if (rejectedBy === "server") throw new Error("Verification rejected");
        return {};
      },
      authenticate: async () => {
        if (rejectedBy === "authenticator") throw new Error("Cancelled");
        return { id: "synthetic-credential" };
      },
    }, "pair_client", "/v1/clients/pair", { name: "Watch" }, "Watch"));
    assert.ok(!calls.includes("/v1/clients/pair"));
  }
});

test("a failed sensitive request is not retried with the consumed proof", async () => {
  let attempts = 0;
  await assert.rejects(verifiedAccountRequest({
    request: async path => {
      if (path === "/auth/step-up/options") return {};
      if (path.endsWith("/verify")) return { stepUpToken: "synthetic-proof" };
      attempts++;
      throw new Error("Response lost");
    }, authenticate: async () => ({}),
  }, "add_passkey", "/auth/registration/options", { name: "Owner" }), /Response lost/);
  assert.equal(attempts, 1);
});

test("passkey removal binds verification to that credential and uses DELETE only for the final request", async () => {
  const calls: { path: string; body: unknown; method?: string }[] = [];
  const response = await verifiedAccountRequest({
    request: async (path, body, method) => {
      calls.push({ path, body, method });
      if (path === "/auth/step-up/options") return { challenge: "synthetic-removal-challenge" };
      if (path === "/auth/step-up/verify") return { stepUpToken: "synthetic-removal-proof" };
      return { removed: true, otherSessionsRevoked: true };
    },
    authenticate: async options => {
      assert.equal(options.challenge, "synthetic-removal-challenge");
      return { id: "different-existing-passkey" };
    },
  }, "remove_passkey", "/auth/passkeys/passkey-being-removed", {}, "passkey-being-removed", "DELETE");
  assert.deepEqual(calls, [
    { path: "/auth/step-up/options", body: { action: "remove_passkey", target: "passkey-being-removed" }, method: undefined },
    { path: "/auth/step-up/verify", body: { response: { id: "different-existing-passkey" } }, method: undefined },
    { path: "/auth/passkeys/passkey-being-removed", body: { stepUpToken: "synthetic-removal-proof" }, method: "DELETE" },
  ]);
  assert.deepEqual(response, { removed: true, otherSessionsRevoked: true });
});

const inventory = {
  sessions: [{ id: "00000000-0000-0000-0000-000000000001", scope: "owner", createdAt: null, expiresAt: "2026-10-03T00:00:00.000Z", current: true }],
  passkeys: [{ id: "synthetic-passkey", createdAt: null, transports: ["internal"] }],
};

test("security inventory accepts legacy unknown creation dates and current-session identity", () => {
  assert.deepEqual(parseAccountSecurity(inventory), inventory);
  const dated = {
    sessions: [{ ...inventory.sessions[0], createdAt: "2026-09-26T00:00:00.000Z", current: false }],
    passkeys: [{ ...inventory.passkeys[0], createdAt: "2026-09-26T00:00:00.000Z" }],
  };
  assert.deepEqual(parseAccountSecurity(dated), dated);
  assert.deepEqual(parseAccountSecurity({ sessions: [], passkeys: [] }), { sessions: [], passkeys: [] });
});

test("unavailable or malformed inventory fails visibly rather than claiming there are no credentials", () => {
  for (const value of [
    undefined, null, {}, { sessions: [], passkeys: "invalid" },
    { ...inventory, sessions: [{ ...inventory.sessions[0], current: "yes" }] },
    { ...inventory, sessions: [{ ...inventory.sessions[0], id: "../another-session" }] },
    { ...inventory, sessions: [{ ...inventory.sessions[0], expiresAt: "invalid" }] },
    { ...inventory, passkeys: [{ ...inventory.passkeys[0], id: "unsafe/id" }] },
    { ...inventory, passkeys: [{ ...inventory.passkeys[0], transports: [null] }] },
    { ...inventory, passkeys: [{ ...inventory.passkeys[0], createdAt: "invalid" }] },
  ]) assert.throws(() => parseAccountSecurity(value), /could not be checked/);
});
