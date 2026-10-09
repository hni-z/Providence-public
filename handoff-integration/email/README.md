# Email backend health check

This helper checks an explicitly supplied email backend origin without credentials, sending mail or changing configuration. The coordinator and email backend are separate services.

```sh
node handoff-integration/email/check-health.mjs https://email.example.com
node --test handoff-integration/email/check-health.test.mjs
```

The checker requests `/health`, rejects redirects, limits the response to 4 KiB and applies a five-second total timeout. Use `--timeout-ms` to select a timeout from 100 to 30000 milliseconds. It expects JSON containing `ok: true` and `service: "providence"`.

Exit codes are 0 for the expected healthy response, 2 for a reachable but unhealthy service, 3 for a network failure, and 64 for invalid input. A healthy response does not verify Mail permissions, provider credentials or message delivery.

For backend and Watch configuration, see [MVP setup](../../docs/MVP_SETUP.md) and [Watch setup](../../WATCH_SETUP.md). Keep generated Watch configuration and access tokens outside Git.
