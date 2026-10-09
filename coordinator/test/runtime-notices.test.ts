import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeNotices, runtimeNoticesPlugin } from "../scripts/runtime-notices.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "providence-notices-"));
  const dependency = join(root, "node_modules", "example-runtime"); mkdirSync(dependency, { recursive: true });
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: {
    "": {}, "node_modules/example-runtime": { version: "1.0.0", license: "MIT" },
    "node_modules/example-dev-only": { dev: true, license: "MIT" },
  } }));
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "example-runtime", version: "1.0.0", license: "MIT" }));
  return { root, dependency, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("release notices include runtime license text verbatim and do not require dev-only packages", () => {
  const f = fixture();
  try {
    const license = "Synthetic copyright notice.\nSynthetic license terms.";
    writeFileSync(join(f.dependency, "LICENSE"), license);
    const text = runtimeNotices(f.root);
    assert.match(text, /example-runtime 1\.0\.0/); assert.ok(text.includes(license));
    assert.ok(!text.includes("example-dev-only"));
    const plugin = runtimeNoticesPlugin(f.root, "/quest/");
    const files: any[] = []; const bundle = { html: { type: "asset", fileName: "index.html", source: '<head></head><a href="__PROVIDENCE_LICENSE_NOTICES__">Licenses</a>' } };
    plugin.generateBundle.handler.call({ emitFile: (value: any) => files.push(value) }, {}, bundle);
    assert.equal(files.length, 1); assert.match(files[0].fileName, /^assets\/third-party-notices-[a-f0-9]{16}\.txt$/);
    assert.ok(bundle.html.source.includes(`/quest/${files[0].fileName}`));
    assert.ok(!bundle.html.source.includes("__PROVIDENCE_LICENSE_NOTICES__"));
  } finally { f.close(); }
});

test("missing license text fails a release instead of silently dropping attribution", () => {
  const f = fixture(); try { assert.throws(() => runtimeNotices(f.root), /Missing license text/); } finally { f.close(); }
});
