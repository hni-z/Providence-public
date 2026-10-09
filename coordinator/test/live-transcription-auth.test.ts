import test from "node:test";
import assert from "node:assert/strict";
import { LiveTranscriptionTickets } from "../src/live-transcription-auth.js";

test("live tickets require existing authorization, retain retry identity and are consumed exactly once", () => {
  const tickets = new LiveTranscriptionTickets(() => 1000);
  assert.throws(() => tickets.issue("Bearer fixture", "r1", "https://example.com", () => false), /Unauthorized/);
  const issue = () => tickets.issue("Bearer fixture", "r1", "https://example.com", () => true);
  const first = issue();
  assert.deepEqual(issue(), first);
  assert.equal(Date.parse(first.expiresAt), 31_000);
  assert.equal(first.ticket.length >= 40, true);
  assert.equal(JSON.stringify(first).includes("Bearer fixture"), false);
  assert.throws(() => tickets.consume(first.ticket, "https://other.example"), /invalid or expired/);
  assert.deepEqual(tickets.consume(first.ticket, "https://example.com"), { sessionId: first.sessionId, requestId: "r1" });
  assert.throws(() => tickets.consume(first.ticket, "https://example.com"), /invalid or expired/);
  assert.throws(issue, /already used or expired/);
});
test("expired, revoked and cross-origin tickets never become a new live session", () => {
  let now = 1000, allowed = true;
  const tickets = new LiveTranscriptionTickets(() => now);
  const first = tickets.issue("Bearer fixture", "r1", undefined, () => allowed);
  allowed = false;
  assert.throws(() => tickets.consume(first.ticket, undefined), /invalid or expired/);
  allowed = true; now += 30_000;
  assert.throws(() => tickets.consume(first.ticket, undefined), /invalid or expired/);
  assert.throws(() => tickets.issue("Bearer fixture", "r1", undefined, () => allowed), /already used or expired/);
  assert.throws(() => tickets.issue("Bearer fixture", "r2", undefined, () => false), /Unauthorized/);
  const other = tickets.issue("Bearer another", "r1", undefined, () => true);
  assert.notEqual(other.ticket, first.ticket);
  tickets.clear();
  assert.throws(() => tickets.consume(other.ticket, undefined), /invalid or expired/);
});
test("an established stream still respects revocation of the original app authorization", () => {
  let allowed = true;
  const tickets = new LiveTranscriptionTickets(() => 1000);
  const ticket = tickets.issue("Bearer fixture", "r1", undefined, () => allowed);
  assert.equal(tickets.isAuthorized(ticket.sessionId), false);
  tickets.consume(ticket.ticket, undefined);
  assert.equal(tickets.isAuthorized(ticket.sessionId), true);
  allowed = false;
  assert.equal(tickets.isAuthorized(ticket.sessionId), false);
});
