# Voice configuration

Providence can use OpenAI or ElevenLabs for transcription and speech. Input and output providers are selected independently. Hosted accounts use OpenAI for both input and output. The provider configuration below applies to standalone instances.

The web and Quest clients use authenticated `/v1/transcriptions` and `/v1/speech` endpoints. A transcript starts no computer task until the client submits it to the selected conversation. Changing conversations, signing out or stopping voice invalidates unfinished capture and playback. Cancelling a submitted computer task is a separate operation.

## Private configuration

Store provider keys in an owner-readable env file outside Git. Add nonsecret selections to your private coordinator configuration, for example:

```json
{
  "transcriptionProvider": "elevenlabs",
  "speechProvider": "elevenlabs",
  "elevenLabsEnvFile": "/absolute/private/path/elevenlabs.env",
  "elevenLabsTranscriptionModel": "scribe_v2",
  "elevenLabsSpeechModel": "eleven_flash_v2_5",
  "elevenLabsVoiceId": "YOUR_ACCOUNT_VOICE_ID"
}
```

The env file contains `ELEVENLABS_API_KEY`. An explicit file is read without shell evaluation; an unreadable file does not fall back to another credential. Select a voice available to your account. No voice is selected by default.

To retain OpenAI transcription and use ElevenLabs output, set `transcriptionProvider` to `openai`, keep your `transcriptionEnvFile` and `transcriptionModel`, and configure `speechProvider`, `speechEnvFile` and `elevenLabsVoiceId` as described in [speech output](ELEVENLABS_OUTPUT.md). The output credential file is never used for input.

Configuration is loaded at startup. Follow [the release procedure](../../docs/RELEASES.md) when restarting an existing instance with retained state.

## API behavior

- `GET /v1/voice` reports input and output readiness separately, with provider labels and safe configuration reasons. It returns no credential or private file path.
- `POST /v1/transcriptions` accepts `{requestId,deviceId,base64,mimeType}` and returns a retained job for polling. Audio is capped at 512 KiB and transcript text at 8,000 characters. Duplicate or interrupted requests do not trigger another provider attempt.
- `POST /v1/speech` accepts `{requestId,text}` with at most 4,000 characters and returns up to 4 MiB of MP3 audio. See [speech output](ELEVENLABS_OUTPUT.md) for request identity and retry behavior.
- The client cannot override provider credentials, endpoints, models or voices in a request.
- Provider failures are not automatically retried with another vendor. Client playback retries can use cached audio without another paid synthesis call.
- Backgrounding, stopping or changing context suppresses late client callbacks. A cancelled transport does not establish that a provider stopped processing or billing.

Browser speech features are used only when supported and selected by the client. Audio is not stored in localStorage. Hardware microphone and speaker behavior must be checked on each target device.

## Verification

Run the coordinator and Quest tests with synthetic providers before configuring live services. For your own live setup, check authenticated discovery, submit a short test recording, inspect the transcript, then request and play a short reply. Verify Stop and context changes independently from computer-task cancellation.

API references: [ElevenLabs transcription](https://elevenlabs.io/docs/api-reference/speech-to-text/convert), [streaming speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [authentication](https://elevenlabs.io/docs/api-reference/authentication).
