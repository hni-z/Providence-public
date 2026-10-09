import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { readWorkspaceArtifact, Artifacts } from "../src/artifacts.js";
// Creating a symlink on Windows requires a privilege the test process may not hold.
const linked = (target: string, path: string) => {
  try {
    symlinkSync(target, path);
    return true;
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    )
      return false;
    throw error;
  }
};
test("artifact snapshots are independently verified, bounded and immutable across revisions", () => {
  const dir = mkdtempSync(join(tmpdir(), "providence-artifact-"));
  const root = join(dir, "workspace");
  mkdirSync(root);
  const file = join(root, "result.txt");
  try {
    const store = new Store(join(dir, "state.json"));
    const outputs = new Artifacts(store, join(dir, "outputs"));
    const t = store.createTask("r", "c", "mac", "create").task;
    writeFileSync(file, "first");
    const payload = readWorkspaceArtifact(root, root, "result.txt");
    const a = outputs.save(t, payload);
    assert.equal(a.revision, 1);
    assert.equal(outputs.save(t, payload).id, a.id);
    store.update(t.id, { status: "completed" });
    const t2 = store.createTask("r2", "c", "mac", "revise").task;
    writeFileSync(file, "second");
    const b = outputs.save(t2, readWorkspaceArtifact(root, root, file));
    assert.equal(b.revision, 2);
    assert.equal(outputs.content(a.id).bytes.toString(), "first");
    assert.equal(outputs.content(b.id).bytes.toString(), "second");
    assert.throws(
      () => outputs.save(t, { ...payload, sha256: "bad" }),
      /integrity/,
    );
    writeFileSync(join(dir, "secret"), "private");
    if (linked(join(dir, "secret"), join(root, "escape")))
      assert.throws(
        () => readWorkspaceArtifact(root, root, "escape"),
        /outside/,
      );
    assert.throws(
      () => readWorkspaceArtifact(root, root, "../secret"),
      /outside/,
    );
    writeFileSync(join(root, "large"), Buffer.alloc(512 * 1024 + 1));
    assert.throws(() => readWorkspaceArtifact(root, root, "large"), /512 KiB/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
