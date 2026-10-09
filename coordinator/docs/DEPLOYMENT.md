# Self-hosting Providence

For the account-based service, use [hosted accounts](HOSTED_ACCOUNTS.md). The instructions below describe a separate single-user deployment.

To host your own instance:

1. Install Node.js 22.12 or newer and build the coordinator web and Quest clients.
2. Run setup with a private `PROVIDENCE_DATA_DIR` outside the source tree. Use one coordinator process per state directory.
3. Configure your own Codex login and optional transcription/speech provider credentials locally. Never copy another deployment's state or authentication files.
4. Set `PROVIDENCE_PUBLIC_ORIGIN` to your exact HTTPS origin. Keep authentication enabled and the coordinator bound to a private interface behind your TLS proxy.
5. Adapt the templates in `coordinator/deploy` to your domain, certificate paths, service account and upstream. The example SSH aliases `providence-server` and `providence-server-public` must be defined locally if using a reverse tunnel.
6. Validate the proxy configuration, then verify unauthenticated API requests are rejected and authorized requests reach only your intended devices.

The templates use placeholder home directories. Update them for your server; do not assume a specific account exists. TLS keys, environment files, access tokens and runtime logs belong outside Git. To take an instance offline, stop its coordinator and disable proxying to application routes while serving static product assets separately.
