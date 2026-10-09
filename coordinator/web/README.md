# Providence web workspace

A responsive React interface served by the coordinator from `web/dist`.

```sh
cd coordinator/web
npm ci
npm run build
```

The coordinator serves the production build at its own origin. API calls use `/v1` and an `Authorization` header. The private workspace key is entered on the sign-in screen and kept in session storage; it is never placed in a URL, source bundle, or local storage. Locking the workspace clears it.

The UI uses real coordinator snapshots for conversations, device capabilities, tasks, decisions and activity. It polls only while visible and refreshes on reconnect. Master completion and worker completion remain separate: a main reply can be ready while its delegated work still runs or needs input. Worker result cards use explicit task linkage; older replies can link tasks only when they reference an exact task ID, never by timing. The cards expose actual outputs and jump to the owning conversation. A completed turn is not presented as independently verified file creation; outputs use the verified artifact endpoints.

Submitting a message creates a request ID that survives an uncertain network response and page refresh in this browser session. **Retry request** sends the exact same envelope. Ordinary polling never replays work. Request errors remain visible; the UI does not fabricate progress percentages or assistant output.

**Start voice** uses the same selected chat and message submission path. Server transcription and reply speech are configured independently as OpenAI or ElevenLabs; labels reflect each actual provider, with feature-detected browser fallbacks when a server service is unconfigured. Only fresh replies associated with the active voice session can play. Downloaded audio is cached in memory for explicit playback retry; a failed provider request is not silently retried or sent to a different provider. Stop, chat changes, sign-out, disconnect or configuration changes invalidate unfinished capture/playback. Discovery refreshes periodically and on browser reconnect/resume. Text tasks and their histories remain intact. See [ELEVENLABS_VOICE.md](../docs/ELEVENLABS_VOICE.md) for source-preparation status, limits and activation prerequisites; live audio is not established by client fixtures.

Conversation routing is in the composer. Direct conversations can attach up to five source conversations; the coordinator labels the source context and records the transfer. Registered Codex history is distinguished from Providence-tracked context. Command/file decisions and structured questions resolve only their specific approval IDs.

Files are fetched with authentication. Images are shown with bounded local blob previews, while text (including HTML source) is escaped as text. Markdown never executes raw HTML and remote image embeds are rendered as links. Other files download as attachments. Snapshot revisions remain separate. Each turn shows its own newest attached revision first, with older revisions expandable; a newer file from a later turn is linked explicitly instead of silently replacing the original.

New computers are paired using a short-lived code from **Your devices → +**. Remote access can be revoked from device details. Pairing and companion setup are separate from a Codex desktop Remote connection.

The production build self-hosts DM Sans and Manrope. It requires no external font service. Desktop uses a conversation, sidebar and task panel; mobile uses separate navigation/details drawers. Cmd/Ctrl+K focuses the composer, Enter submits, and Shift+Enter inserts a line break.

For development, `npm run dev` proxies `/v1` to the coordinator at `127.0.0.1:8787`. Use the production same-origin build for authenticated integration tests; the coordinator intentionally rejects unconfigured browser origins.

The default workspace opens with **Superagent** and **Chats**. Chat search filters registered names, device metadata and workspace paths; it does not claim a universal native-session catalog. Task/activity details remain available from the toolbar. Diagnostic proof views remain accessible by their dedicated hash routes but have no default navigation links.

Superagent renders server-derived child progress and final responses with their source chat, device and update time. A parent reply is marked as an earlier snapshot only when the server explicitly reports a newer child update; the stored parent message is never rewritten. Provider-offered response persistence appears only when advertised, defaults to one request, and sends a selected duration only on explicit acceptance.
