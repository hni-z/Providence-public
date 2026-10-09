# Voice in chat

In hosted Providence, the voice button beside Send starts a GPT-Live conversation in the selected chat. Users can keep speaking while computer tasks run and ask for progress. Completed work submitted during that voice session is announced once. Written tasks and results remain in the same chat. If live voice cannot connect, the interface offers a recorded voice message.

The account's OpenAI API key needs access to `gpt-live-1` and `gpt-6-sol`. API billing is separate from a ChatGPT subscription. Voice uses `gpt-live-1`; Responses delegation uses GPT-6 Sol with low reasoning and priority service. Device work continues through the existing Providence coordinator and local Codex runtime.

## Connection and authorization

The browser requests its microphone after a click, exchanges an SDP offer through the authenticated Providence server, and sends media directly over WebRTC. The long-lived API key never enters the browser. A server-side OpenAI connection runs the two allowed tools: submit a request to the selected chat and read progress. Browser data-channel permissions permit only closing the voice session and muting or unmuting input.

Every tool call is bound to the original Providence owner session, account, API-key version and selected chat. Duplicate function calls reuse their original result. Changing chat, revoking the owner session, changing/removing the saved key, or shutting down the service fences further voice tool dispatch. A lost browser heartbeat ends the voice session after 35 seconds; sessions have a ten-minute maximum duration. These limits bound voice sessions, not already-submitted computer tasks.

Providence still authorizes and routes device work. This feature does not transfer that security boundary to OpenAI. Revoking a provider key is not a substitute for removing a device or revoking its Providence credentials.

## Ending and recovering

End voice stops microphone capture immediately and waits briefly for the provider's closing event. Hiding the page or leaving the chat also releases microphone and playback resources. There is no automatic reconnect, capture restart, task replay or repeated paid session creation after a failure. Already-submitted work remains visible in the chat and has its own Stop control.

Provider handshakes and synthetic audio tests do not establish physical microphone, speaker or headset behavior. Test those on the intended device, including backgrounding, a network interruption and sign-out during voice.

Protocol references: [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls).
