# ElevenLabs speech output

The coordinator converts a bounded reply into MP3 audio through the selected ElevenLabs voice. Transcription is configured separately. Hosted accounts use OpenAI speech. Configure ElevenLabs only for your own standalone coordinator.

## Configuration

Add these selections to your private coordinator JSON:

```json
{
  "speechProvider": "elevenlabs",
  "speechEnvFile": "/absolute/private/path/providence-speech.env",
  "elevenLabsVoiceId": "YOUR_ACCOUNT_VOICE_ID"
}
```

The env file must contain `ELEVENLABS_API_KEY` and should be readable only by its owner. `speechEnvFile` takes precedence for output only. If omitted, `elevenLabsEnvFile` is used when configured; otherwise the named process environment key is used. An explicitly configured file never falls back to another credential when unreadable.

Select a voice available to your account. Missing credentials or voice selection leaves speech unavailable. Omitted `speechProvider` retains the OpenAI default. See [voice configuration](ELEVENLABS_VOICE.md) for independent input settings.

## API and limits

- Authenticated `GET /v1/voice` reports the selected provider and separate input/output configuration status. No key or private path is returned.
- `POST /v1/speech` accepts `{requestId,text}` and returns `audio/mpeg` with `Cache-Control: no-store`.
- Text is limited to 4,000 UTF-16 code units, audio to 4 MiB, with one generation at a time and a 60-second provider timeout.
- The server tracks up to 512 consumed request IDs in memory per process. A failed or timed-out provider attempt is not automatically repeated. This does not provide durable billing idempotency across restarts.
- Stopping playback aborts transport where possible and suppresses late audio; it cannot guarantee cancellation of provider billing.
- Errors are sanitized and redirects rejected. The provider receives the submitted reply text without a generative rewrite.

The implementation uses `/v1/text-to-speech/{voice_id}/stream?output_format=mp3_44100_128` with the configured `elevenLabsSpeechModel`, defaulting to `eleven_flash_v2_5`.

## Checks

From `coordinator/`:

```sh
npm run check
./node_modules/.bin/tsx --test test/speech.test.ts test/elevenlabs-speech.test.ts test/browser-voice.test.ts test/voice-api.test.ts
```

These tests use synthetic providers. A live MP3 response and audible playback on a physical Watch or Quest require separate checks with your own configuration.

API references: [streaming speech](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [authentication](https://elevenlabs.io/docs/api-reference/authentication).
