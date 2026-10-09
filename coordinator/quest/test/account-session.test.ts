import test from "node:test";
import assert from "node:assert/strict";
import { hostedAccountMode, SPATIAL_ACCOUNT_HREF, clearSpatialLogin } from "../src/account-session";

test("hosted spatial pages retain a passkey return route and cannot offer the standalone credential form", () => {
  assert.equal(SPATIAL_ACCOUNT_HREF, "/account?next=%2Fmeta");
  for (const host of ["providence.hani.so", "htn.hani.so", "PROVIDENCE.HANI.SO"]) assert.equal(hostedAccountMode(host), true);
  assert.equal(hostedAccountMode("private.example", { hosted: true, authenticated: false }), true);
  for (const value of [undefined, {}, null, { hosted: "true" }, { hosted: false }]) assert.equal(hostedAccountMode("private.example", value), false);
  assert.equal(hostedAccountMode("providence.hani.so.untrusted.example"), false);
});

test("storage failures cannot prevent logout from proceeding to retire visible account state", () => {
  const removed: string[] = [];
  clearSpatialLogin(() => ({ removeItem: key => { removed.push(key); if (key.endsWith("session")) throw new Error("Storage denied"); } }));
  assert.deepEqual(removed, ["providence.quest.session", "providence.quest.pending"]);
  assert.doesNotThrow(() => clearSpatialLogin(() => { throw new Error("Storage getter denied"); }));
});
