# Providence

An assistant for coordinating work across your connected computers, with web, Apple Watch and Quest clients. Providence brings conversations, task progress, approval requests and results into one workspace while work runs on the selected device.

[Project on Devpost](https://devpost.com/software/providence-tn6m4h) · [Providence](https://providence.hani.so/)

This is a project showcase and experimental release. The Apple clients currently use developer installation; see the native setup guides below.

See [how Providence was built](coordinator/docs/ENGINEERING.md) for the architecture, technology stack, request flow, build process and use of AI during development.

Use [Providence online](https://providence.hani.so/account#devices): copy the installer command for your computer, sign in with a passkey, and finish setup in the terminal. Your OpenAI API key is entered privately there for hosted coordination and voice. Computers keep their own Codex sign-in and can run the companion in the background after you approve login startup. The Apple Watch pairs to your account. See [hosted accounts](coordinator/docs/HOSTED_ACCOUNTS.md) for deployment and account isolation. The local setup below runs a separate single-user instance.

## What it does

- Routes requests to connected computers and their project conversations.
- Supports live voice in chat, recorded voice requests, and spoken responses when the selected provider is configured.
- Shows task progress, asks for approval when needed, and returns file previews and downloads.
- Keeps conversation context and task state across client refreshes.
- Provides browser, Watch and Quest interfaces. Device capabilities depend on the host platform, available tools and permissions.

## Source guide

| Component | Start here |
| --- | --- |
| Coordinator and web workspace | [Setup and architecture](coordinator/README.md) |
| Apple Watch | [Watch setup](WATCH_SETUP.md), [routing](docs/WATCH_MAC_ROUTING.md) |
| Quest | [Quest client](coordinator/docs/QUEST.md) |
| iPhone shell | [iPhone setup](iPhone/README.md), [distribution requirements](iPhone/DISTRIBUTION.md) |
| AI usage and billing | [User-funded API and Codex usage](coordinator/docs/BILLING.md) |
| Reviewed email backend | [Backend setup](docs/MVP_SETUP.md), [voice API](backend/VOICE_API.md) |
| Device companion | [First-run guide for Mac, Windows and Linux](coordinator/docs/FIRST_RUN.md), [Windows setup](coordinator/docs/WINDOWS_SETUP.md) |

## Run locally

Use Node.js 22.12 or newer and a locally authenticated Codex runtime for actual device execution.

```sh
cd coordinator
npm ci
npm --prefix web ci
npm --prefix quest ci
npm run build:web
npm --prefix quest run build
npm run setup
npm start
```

Open `http://127.0.0.1:8787`. Setup creates private local configuration; never commit it. Use your own provider accounts if enabling transcription or speech. Native Apple clients require Xcode and your own signing configuration.

## Privacy and sharing

Examples use fictional device names and placeholder app identifiers. Operational receipts, account details, private paths and device screenshots are excluded from the showcase source. See the [sharing guide](docs/PRIVACY.md) before publishing a copy, especially one containing Git history.

## License

This repository is a public showcase, not an open-source release. All rights are reserved; see [LICENSE](LICENSE). Third-party components remain subject to their respective licenses.
