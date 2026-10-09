import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("render-gateway.mjs", import.meta.url));

function render(...args) {
  const output = mkdtempSync(resolve(tmpdir(), "render-gateway-"));
  const result = spawnSync(process.execPath, [script, ...args, "--output", output], { encoding: "utf8" });
  return { ...result, output, files: readdirSync(output).filter((name) => name !== "logs") };
}

test("the live canonical and legacy hostnames are refused as protected names", () => {
  for (const hostname of ["providence.hani.so", "htn.hani.so"]) {
    const result = render("--hostname", hostname);
    assert.notEqual(result.status, 0, `${hostname} was rendered instead of refused`);
    assert.match(result.stderr, /protected site/);
    assert.deepEqual(result.files, []);
  }
});

test("--canonical renders the live pair with the upstream port substituted", () => {
  const result = render("--canonical", "--upstream-port", "19191");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.files.sort(), ["providence-canonical.conf", "providence-htn-redirect.conf"]);
  for (const name of result.files) {
    const rendered = readFileSync(resolve(result.output, name), "utf8");
    assert.doesNotMatch(rendered, /__[A-Z_]+__/, `${name} kept an unsubstituted template variable`);
  }
  const canonical = readFileSync(resolve(result.output, "providence-canonical.conf"), "utf8");
  assert.match(canonical, /proxy_pass http:\/\/127\.0\.0\.1:19191;/);
});

test("a dedicated hostname still renders its own pair and launch agent", () => {
  const result = render("--hostname", "unused-htn.hani.so");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.files.sort(), ["com.providence.htn-tunnel.plist", "providence-htn.http.conf", "providence-htn.https.conf"]);
  assert.match(readFileSync(resolve(result.output, "providence-htn.https.conf"), "utf8"), /server_name unused-htn\.hani\.so;/);
});

test("a hostname and the canonical pair cannot be rendered together", () => {
  for (const args of [["--canonical", "--hostname", "unused-htn.hani.so"], []]) {
    const result = render(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical pair/);
  }
});
