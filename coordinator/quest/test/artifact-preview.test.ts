import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { ProvidenceApi } from "../src/api";
import type { Artifact } from "../src/types";

const source = ts.createSourceFile(
  "main.ts",
  readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set(["openArtifact"]);
const functions = source.statements.filter(
  (node) =>
    ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text),
);
assert.equal(functions.length, names.size);

// The real open path against the real ProvidenceApi and real SHA-256. Only the
// transport response, DOM and re-render sinks are fake; nothing is requested.
function controller(body: string, sha256: string, mime = "text/plain") {
  const served: string[] = [];
  const fetched = async (path: string) => {
    served.push(path);
    return new Response(body, { status: 200, headers: { "Content-Type": mime } });
  };
  const code = `
    let artifactPreview, renders=0;
    const failures=[], notices=[];
    const caps={active:true};
    const api=new ProvidenceApi('private-test-token');
    const $=()=>({scrollIntoView(){}});
    function element(){return {href:'',download:'',click(){}};}
    function renderResult(){renders++;} function renderSpatial(){}
    function notice(message){notices.push(message);}
    function fail(error){failures.push(error instanceof Error?error.message:String(error));}
    ${functions.map((node) => node.getText(source)).join("\n")}
    return {
      open:openArtifact,
      inspect(){return {artifactPreview,renders,failures,notices};}
    };
  `;
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const original = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetched });
  const ui = new Function("ProvidenceApi", "URL", compiled)(ProvidenceApi, URL);
  return { ...ui, served, restore: () => Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: original }) };
}

async function digest(body: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

function artifact(sha256: string, mime = "text/plain"): Artifact {
  return { id: "returned-file", name: "output.txt", mime, size: 512000, sha256, revision: 1, taskId: "accepted" };
}

test("a large text artifact is verified whole and previewed up to the shared cap", async () => {
  const body = "Returned artifact contents. ".repeat(20000);
  assert.ok(body.length > 512000);
  const hash = await digest(body);
  const ui = controller(body, hash);
  try {
    await ui.open(artifact(hash));
    const state = ui.inspect();
    assert.deepEqual(state.failures, []);
    assert.equal(state.artifactPreview.taskId, "accepted");
    assert.equal(state.artifactPreview.text.length, 100000);
    assert.equal(state.artifactPreview.text, body.slice(0, 100000));
    assert.equal(state.renders, 1);
    assert.deepEqual(ui.served, ["/v1/artifacts/returned-file/content"]);
  } finally {
    ui.restore();
  }
});

test("the capped preview does not weaken hash verification of the whole returned file", async () => {
  const body = "Returned artifact contents. ".repeat(20000);
  // Identical for the first 100,000 characters, different beyond the preview cap.
  const tampered = `${body.slice(0, 400000)}tampered tail${body.slice(400013)}`;
  assert.equal(tampered.slice(0, 100000), body.slice(0, 100000));
  const ui = controller(tampered, await digest(body));
  try {
    await ui.open(artifact(await digest(body)));
    const state = ui.inspect();
    assert.equal(state.artifactPreview, undefined);
    assert.equal(state.renders, 0);
    assert.match(state.failures[0], /did not match its verified snapshot hash/);
  } finally {
    ui.restore();
  }
});
