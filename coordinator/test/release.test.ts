import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRelease } from "../src/release.js";

function manifest(overrides: Record<string, unknown> = {}) {
  const digest = "a".repeat(64);
  return {
    schemaVersion: 1,
    commit: "b".repeat(40),
    builtAt: "2026-09-20T05:00:00.000Z",
    nodeVersion: "22.23.2",
    webEntry: { path: "web/dist/assets/index.js", url: "/assets/index.js", sha256: digest },
    questEntry: { path: "quest/dist/assets/index.js", url: "/quest/assets/index.js", sha256: digest },
    ...overrides,
  };
}

test("an unreadable or invalid release manifest still boots as an unstamped build", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "providence-release-"));
  const file = join(directory, "release.json");
  const errors: string[] = [];
  t.mock.method(console, "error", (message: unknown) => errors.push(String(message)));
  try {
    assert.deepEqual(loadRelease(file), { commit: "development", builtAt: null, stamped: false });
    for (const broken of [
      '{"schemaVersion":1,"commit":"',
      JSON.stringify(manifest({ commit: "not-a-commit" })),
      JSON.stringify(manifest({ builtAt: "yesterday" })),
      JSON.stringify(manifest({ webEntry: { path: "../escape.js", url: "/assets/index.js", sha256: "a".repeat(64) } })),
      "",
    ]) {
      writeFileSync(file, broken);
      assert.deepEqual(loadRelease(file), { commit: "unreadable", builtAt: null, stamped: false });
    }
    assert.equal(errors.length, 5);
    assert.equal(errors.every((message) => !message.includes("ZodError")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stamped manifest reports its commit, including the longer object names the builder accepts", () => {
  const directory = mkdtempSync(join(tmpdir(), "providence-release-"));
  const file = join(directory, "release.json");
  try {
    writeFileSync(file, JSON.stringify(manifest()));
    assert.deepEqual(loadRelease(file), { ...manifest(), stamped: true });
    const long = "c".repeat(64);
    writeFileSync(file, JSON.stringify(manifest({ commit: long })));
    const release = loadRelease(file);
    assert.equal(release.commit, long);
    assert.equal(release.stamped, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
