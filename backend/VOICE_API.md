# Spoken email API

This is the additive backend half of the coordinator-owned voice-first contract. Existing audio, development text, draft editing, approval and send endpoints remain available. `MAIL_SENDER` remains authoritative. Examples use synthetic contacts only.

All routes below require the existing bearer token. Existing response/status/error formats and request limits apply. No endpoint in this document sends email.

| Route | JSON / headers | Result |
| --- | --- | --- |
| `POST /api/jobs/voice-text` | `{ "text": "Email Alex alex at example dot com saying please test it" }`, UUID `X-Request-ID` | `202` for a new job, `200` for an identical registration, `409` for an ID/content conflict. Native dictation entry is independent of `ENABLE_TEXT_TEST`. |
| `POST /api/jobs/:id/clarify` | `{ "version": 1, "text": "Alex alex at example dot com" }` | Updated Job with incremented version. Recipient-only clarification preserves subject/body without another AI call. A complete replacement email request redrafts content. |
| `POST /api/jobs/:id/remember-contact` | `{ "version": 2, "name": "Alex" }` | `{ "contact": { "name": "Alex", "email": "alex@example.com" } }`. Call only after explicit user confirmation. Email comes from that exact job/version's explicit recipient evidence; the request cannot supply an email. |

`voice-text` retains `source: "text"` for old-client compatibility and uses the existing registration fingerprint. Keep one request ID and exact original body through uncertain registration responses. Poll `GET /api/jobs/:id`; do not create a new ID automatically. Clarification retains the job ID. Do not replay an edit with a refreshed version after a lost response: GET the job and review the result first. A repeated/stale clarification receives `409`.

Optional Job fields:

```json
{
  "clarification": "What is the recipient’s full email address? You can say their name followed by the address.",
  "contactProposal": { "name": "Alex", "email": "alex@example.com" }
}
```

These fields describe independent states: `clarification` asks for another spoken turn; `contactProposal` is an explicit name/address association awaiting a separate remember confirmation. `status: "ready"` can have a clarification **without a draft**, for example when inbox context is missing or the provider needs a complete request. Render the question before offering approval. For a provider content clarification or reply-context clarification, provide a complete email request in the next dictated turn.

Supported recipient forms include literal addresses, `at`, `dot`, `plus`, `underscore`, `dash`/`hyphen`, a name plus full address, and exact saved/configured names. For example, `respond to Alex saying ...` is a new-email intent. Only the initial recipient clause is trusted; body aliases, quoted commands/addresses, provider guesses, conflicting names, header injection and multiple recipients cannot select an address. A remembered-name conflict asks for one full address to use in this draft. Saving that address under the conflicting name still fails; use a distinct confirmed name.

Actual `reply to ...`, `respond to Alex's email/message ...`, or explicit thread/inbox requests return: “I can't access inbox threads. To send a new email, say 'email NAME saying MESSAGE'.” There is no inbox retrieval, message ID, `In-Reply-To`, or threading capability in this backend. A new email must be requested explicitly; do not label it as a thread reply.

Clarification invalidates prior approvals before asynchronous processing and claims the next version immediately. The existing PATCH endpoint also clears voice contact evidence. Remembering cannot mutate a draft or approve/send it, so a successful remember does not change the draft version. Repeating an identical save is idempotent; a stale version, changed recipient, unavailable evidence, or conflicting name fails safely. Send attempts continue to use exact approval tokens, version checks and the persistent no-repeat journal. After any send attempt, contact saves and edits are blocked.

## Private storage and offline verification

`Config.contactsFile?: string` selects the private remembered-contact file. `configFromEnv()` uses `.providence/remembered-contacts.local.json`, which is covered by the existing `.providence/*.local.*` ignore rule. The configured static `.providence/contacts.local.json` remains a separate input and is never overwritten. A manually constructed test Config without `contactsFile` defaults to `contacts.local.json` inside its `journalDir`; always use temporary directories in tests.

The store validates names/addresses, rereads current data, rejects differing addresses under the same normalized name, limits saved contacts to 100, and uses an exclusive lock plus flushed atomic rename. File mode is `0600`; the save directory is `0700`. Existing invalid files or symlink files fail closed. A crash during a save can leave a lock file and block future saves. The Mac operator should inspect the file and establish that no writer remains before removing a stale lock; this code never bypasses a live/uncertain lock. Contact data is not included in API configuration/list responses beyond the specific job/proposal/confirmation being reviewed.

Run with installed backend dependencies:

```sh
cd backend
npm run check
npm test
```

`test/voice.test.ts` injects fake AI/mail, writes only synthetic contacts into temporary storage, starts local ephemeral HTTP servers, and proves restart persistence, clarification races, exact approval invalidation, recipient attacks, save conflicts, permissions and uncertain-send no-repeat. Existing audio and build-2 API tests remain in `test/app.test.ts`. These checks make no AI requests, invoke no Apple Mail action and send no email.
