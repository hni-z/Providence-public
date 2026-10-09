# Physical acceptance (not executed by this package)

Every checkbox starts unchecked. Offline green results are insufficient. Keep real addresses, tokens, contact stores, account screenshots and private task text out of Git; record redacted identity matches and receipt references in the private run record.

## Preconditions and private run record

- [ ] Record exact integrated commit, backend/coordinator deployed revisions, Watch version/build actually installed, browser selection, timestamp and operator. An uploaded build does not prove installation. Build 2 lacks unified Talk and cannot pass W01.
- [ ] Confirm backend health/config and coordinator reachability through approved operator tools. If unhealthy, stop; do not change accounts, ports, tokens or routing to hide it. Reconcile a reported HTTP 530 with deployment owner before email tests.
- [ ] Record **exact existing** device ID and chat ID privately; verify selected chat belongs to that online device, expected workspace and browser capability. A display name alone is insufficient. Do not create or pair another computer for this test.
- [ ] Confirm Watch credentials are valid. If needed, parent/user explicitly requests one fresh short code; privately exchange it once. Do not record a reusable token, reuse a consumed code or claim pairing merely from code display.
- [ ] Use Safari for the exact command below only if it is the selected, supported browser on that registered Mac. If another browser is selected, substitute its exact name in the written command **before** dictation and record the resulting complete command.

## Required first route: Watch → selected Mac browser → Watch

1. [ ] Open the app. Observe one prominent **Talk** action. Tap it and cancel native dictation once. Expected: no email job, Mac task, contact write or approval/send request. Reopen app: no canceled text silently submitted.
2. [ ] Tap Talk and say exactly: **“On my Mac, open https://example.com in Safari and tell me the page title.”** Expected: native dictated text, Mac intent, no recipient field/email draft. Correct recognition by voice if needed before confirming native dictation.
3. [ ] Confirm native dictation with **Done** once. This may dispatch the ordinary Mac request directly. If a separate transcript review/submit tap remains, record its count and demonstrated reliability reason as a UX tradeoff; do not claim literal Talk → dictate → action. Do not tap submission twice. Record the request UUID locally and returned task ID. Expected: one `POST /v1/chats/<selectedChatId>/messages`; task's chat/device match the recorded IDs. No `POST /v1/messages`, no email POST, no silent fallback.
4. [ ] If an approval appears, review the exact displayed browser action and approve only that action. If task/device/turn/action has changed, stop and refresh; a stale tap must fail. Do not approve unrelated permissions or commands just to finish the demo.
5. [ ] Observe the **selected physical Mac** opening `https://example.com` in the selected browser. Confirm page title **Example Domain**. A coordinator task saying “completed” without the action is insufficient.
6. [ ] Observe the Watch return the task result/title for the same task. Record request UUID → task ID → exact chat/device → observed browser action → Watch result. Record a timing measurement if useful; no preset latency claim.
7. [ ] Background and reopen the Watch while checking this known task. Expected: GET-only status recovery, same task, no additional tab/action/submission. Never deliberately sever a live side-effect acknowledgement to test retry; use the synthetic timeout test for that failure.

If any identity differs, outcome remains unknown, approval is stale, or only the UI claims success: stop and record the failing step. Do not submit a fresh UUID to conceal uncertainty. No hardware success is recorded until steps 3, 5 and 6 all have direct observations.

- [ ] Negative target rehearsal: say **“On my Windows PC, open https://example.com.”** Expected: clear unsupported-target clarification and **zero dispatches** to email, configured Mac, master or another device. Repeat with an explicit iPhone/Quest target if relevant. The interim feature supports only the configured Mac; an untouched Mac is the expected outcome. Do not claim a multi-device resolver exists.

## Voice email rehearsal without sending

1. [ ] Talk: **“Email Alex at alex at example dot com saying I can help tomorrow.”** Expected: email route, recipient `alex@example.com`, reviewed body and actual configured sender. `example.com` is synthetic; **do not send**.
2. [ ] Decline remembering once, cancel review, and try “Email Alex saying I can help tomorrow.” Expected: unknown contact asks for an address by voice. Dictate “alex at example dot com”; body unchanged, same job ID/version increment, still not sent.
3. [ ] In the synthetic rehearsal context only, explicitly confirm “Remember Alex” for that exact reviewed address. Expected: confirmation, then later name-only draft resolves Alex. Reopen app and repeat without sending. Avoid storing a synthetic alias in a user's real contact namespace unless the operator has intentionally reserved it; use the offline V04 proof otherwise.
4. [ ] Try an unknown/conflicting name and “Respond to Alex saying I can help tomorrow.” Expected: voice clarification where needed; new-email review may be offered. **“Reply to the latest email from Alex in the same thread saying I can help tomorrow”** must produce a visible/spoken question even when **no draft exists**. Approval, Send and Remember must be unavailable. Answer by voice: **“Email Alex at alex at example dot com saying I can help tomorrow.”** Expected: same job, version +1, full new-email draft to review; no automatic send. Never invent a reply thread.
5. [ ] Review once, modify the recipient/body by voice, then attempt the old confirmation if reachable. Expected: old approval rejected; latest content must be reviewed again. Cancel. No email has been authorized or sent by these steps.

## Optional live email (separate exact user authorization required)

1. [ ] User explicitly supplies/authorizes **one exact recipient, subject and body** for one send from the displayed configured account. Do not infer authorization from this checklist, a drafted message, the browser demo or contact remembering. Substitute the approved values into the voice request; no synthetic-address send.
2. [ ] On Watch verify exact sender, recipient, subject/body and current version, then show the existing final confirmation. User confirms that exact draft once. Record job ID/version privately, without recording approval tokens.
3. [ ] Submit once. `submitted` means handed to Apple Mail, not delivered. If timeout/`uncertain`, perform status reads only and reconcile Sent/Outbox before any separate new action. Never resend automatically.
4. [ ] Independently verify exactly one matching message in authorized Sent/Outbox or a recipient receipt. Record whether submitted, still queued, delivered, or uncertain. App reopen must show the same send status and must not send again.

Final run record: required browser route PASS/FAIL/NOT RUN, voice clarification PASS/FAIL/NOT RUN, optional email NOT AUTHORIZED/SUBMITTED/UNCERTAIN/RECEIPT VERIFIED; exact evidence references and remaining blockers. No “end-to-end works” claim from compilation, mock success or a TestFlight upload alone.
