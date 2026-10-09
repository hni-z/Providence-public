# Issue a one-use Watch code

This operator helper is for a **standalone coordinator host**. For hosted Providence, sign in to [Account and devices](https://providence.hani.so/account) and choose **Pair an Apple Watch**; that flow requires passkey confirmation.

The standalone helper reads the existing private `config.json` and calls the coordinator’s loopback listener. It does not print or replace the workspace key, exchange the code, register a device, or restart a service. Standalone client sessions default to 24 hours; hosted account sessions last 30 days. Existing grants keep their recorded expiry.

When the Watch is ready, the authorized operator can run this from the deployed checkout's `coordinator/` directory with Node 22 or later:

```sh
node ../watch-pairing/issue-code.mjs --name "Watch"
```

Use the same `PROVIDENCE_DATA_DIR` and `PORT` as the running coordinator. Defaults are `.providence` relative to the current working directory and port `8787`. An explicit private directory may be supplied without placing a reusable credential in shell arguments:

```sh
PROVIDENCE_DATA_DIR=/private/path/to/existing/coordinator-state PORT=8787 node ../watch-pairing/issue-code.mjs --name "Watch"
```

Do not copy credentials into this repository or move private configuration to make this command work. The helper always uses `127.0.0.1`; arbitrary URLs and HTTP redirects are not supported. Run it on the existing coordinator host where that listener is available. It makes one request with a five-second timeout and no automatic retry. If a response is lost, the server may have issued a pending code; check with the owner before issuing more. Errors are deliberately generic and never echo configuration, server bodies or raw exception text.

Successful stdout contains only JSON `{ "code": "XXXX-XXXX-XXXX", "expiresAt": "..." }`. The code uses twelve characters from `23456789ABCDEFGHJKMNPQRSTVWXYZ`. Treat it as a temporary secret: enter it on the intended Watch and do not place it in shared logs, screenshots or Git. It lasts ten minutes and can be exchanged once. Spaces, hyphens and case do not matter. The Watch pairing field accepts a nonempty code up to 50 characters. The Watch stores the resulting 64-hex token in its existing secure storage. Standalone sessions default to 24 hours after exchange and can be revoked earlier. Existing sessions retain their saved expiry.

At most ten client codes can be pending. Invalid exchanges return a generic error and leave other live codes intact. Restart discards pending codes; persisted sessions and the workspace key survive.

Separately, each pairing endpoint and socket address gets twenty failed HTTP exchanges in a sixty-second window. Further failed attempts wait for the window deadline, while a valid code remains redeemable for users sharing that address. Client/device pairing cannot lock or reset one another. Forwarded address headers are ignored, so users behind the same gateway can share the socket-address budget.

For existing-session metadata/revocation, use authenticated `GET /v1/clients` and `DELETE /v1/clients/:id` through the established owner interface. This helper never prints a reusable access token. See the [client API contract](../coordinator/docs/WATCH_API.md).

## Offline verification

From the repository root, these tests use only temporary synthetic configuration and injected/local HTTP servers. They do not contact the deployed coordinator:

```sh
node --test watch-pairing/issue-code.test.mjs
cd coordinator
./node_modules/.bin/tsx --test test/client-sessions.test.ts test/http-clients-quest.test.ts test/web-api.test.ts
npm run check
```

Do not run the issuance command against live state as an implementation check. Pair a physical Watch against your own configured coordinator.
