import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseProbeOptions,
  selectExistingDevice,
  verifyExecutorProof,
} from "../scripts/probe-existing-device.js";

const ready = {
  id: "actual-demoPC",
  name: "DemoPC",
  online: true,
  hostname: "DemoPC",
  platform: "win32",
  workspace: "C:\\ProvidenceWorkspace",
  capabilities: { files: true, shell: true },
};
const inventory = (...devices: unknown[]) => ({ devices });
test("existing-device preflight rejects absent, offline, ambiguous and incorrect executor identities", () => {
  assert.throws(
    () => selectExistingDevice(inventory(), "DemoPC", "DemoPC"),
    /No existing/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory({ ...ready, online: false }),
        "DemoPC",
        "DemoPC",
      ),
    /offline/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory(ready, { ...ready, id: "duplicate-name" }),
        "DemoPC",
        "DemoPC",
      ),
    /unique device ID/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory({ ...ready, platform: "darwin" }),
        "DemoPC",
        "DemoPC",
      ),
    /win32/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory({ ...ready, hostname: "OtherPC" }),
        "DemoPC",
        "DemoPC",
      ),
    /does not match/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory({ ...ready, hostname: undefined }),
        "DemoPC",
      ),
    /identity/,
  );
  assert.throws(
    () =>
      selectExistingDevice(
        inventory({ ...ready, capabilities: { files: true, shell: false } }),
        "DemoPC",
      ),
    /shell/,
  );
  assert.equal(
    selectExistingDevice(
      inventory(ready, { ...ready, id: "another" }),
      ready.id,
      "demoPC",
    ).id,
    ready.id,
  );
  assert.equal(
    "token" in
      selectExistingDevice(
        inventory({ ...ready, token: "never-print-this" }),
        ready.id,
      ),
    false,
  );
});

test("existing-device CLI allows secure origins and has no pairing/reset/revoke switches", () => {
  const args = [
    "https://coordinator.example",
    "/private/config.json",
    "--device",
    "actual-demoPC",
    "--expected-host",
    "DemoPC",
  ];
  assert.equal(parseProbeOptions(args).expectedHost, "DemoPC");
  assert.equal(
    parseProbeOptions(["http://127.0.0.1:8787", ...args.slice(1)]).origin,
    "http://127.0.0.1:8787",
  );
  assert.throws(
    () => parseProbeOptions(["http://venue-host:8787", ...args.slice(1)]),
    /HTTPS/,
  );
  assert.throws(
    () =>
      parseProbeOptions([
        "https://credential@coordinator.example",
        ...args.slice(1),
      ]),
    /credentials/,
  );
  assert.throws(
    () => parseProbeOptions([...args, "--revoke", "yes"]),
    /Unknown/,
  );
  assert.throws(() => parseProbeOptions([...args, "--pair", "yes"]), /Unknown/);
});

test("artifact proof rejects stale nonces, changed bytes and a substituted executor", () => {
  const proof = {
    nonce: "fresh-nonce",
    hostname: "DemoPC",
    platform: "win32",
    revision: 1,
  };
  const bytes = Buffer.from(JSON.stringify(proof));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    verifyExecutorProof(bytes, hash, "fresh-nonce", ready, "DemoPC", 1).hostname,
    "DemoPC",
  );
  assert.throws(
    () =>
      verifyExecutorProof(
        Buffer.concat([bytes, Buffer.from(" ")]),
        hash,
        "fresh-nonce",
        ready,
        "DemoPC",
        1,
      ),
    /hash/,
  );
  assert.throws(
    () => verifyExecutorProof(bytes, hash, "another-run", ready, "DemoPC", 1),
    /nonce/,
  );
  assert.throws(
    () =>
      verifyExecutorProof(
        bytes,
        hash,
        "fresh-nonce",
        { ...ready, hostname: "OtherPC" },
        undefined,
        1,
      ),
    /hostname/,
  );
  assert.throws(
    () =>
      verifyExecutorProof(
        bytes,
        hash,
        "fresh-nonce",
        { ...ready, platform: "darwin" },
        "DemoPC",
        1,
      ),
    /platform/,
  );
  assert.throws(
    () => verifyExecutorProof(bytes, hash, "fresh-nonce", ready, "DemoPC", 2),
    /revision/,
  );
  const second = Buffer.from(
    JSON.stringify({ ...proof, revision: 2, verifiedVia: "followup" }),
  );
  const secondHash = createHash("sha256").update(second).digest("hex");
  assert.equal(
    verifyExecutorProof(second, secondHash, "fresh-nonce", ready, "DemoPC", 2)
      .verifiedVia,
    "followup",
  );
});
