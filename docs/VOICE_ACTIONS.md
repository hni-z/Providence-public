# Voice actions

Providence accepts voice input through its Watch, web and Quest clients. Transcription, task execution and reply speech are separate operations; each needs its own configured service or device capability.

## Computer tasks

A client captures a request, displays its transcript and submits it to the selected conversation. The coordinator routes the task to its registered computer and returns progress and results. Request identity is retained through uncertain submissions so retries do not create another action.

See [Watch routing](WATCH_MAC_ROUTING.md), [Watch API](../coordinator/docs/WATCH_API.md) and [Quest setup](../coordinator/docs/QUEST.md).

## Email

The email backend prepares a draft from a recording. The Watch shows the sender, recipient and message for review before the user selects Send. Missing or misheard addresses can be corrected before submission. Provider credentials remain on the backend.

See [MVP setup](MVP_SETUP.md) and [voice API](../backend/VOICE_API.md). Mail submission and inbox delivery are separate outcomes.

## Speech and device support

Input and output providers can be configured independently. See [voice configuration](../coordinator/docs/ELEVENLABS_VOICE.md) and [speech output](../coordinator/docs/ELEVENLABS_OUTPUT.md). Stopping playback does not cancel an already submitted computer task.

A browser client on a phone or headset can direct a connected computer. Controlling the phone's or headset's installed applications requires a separate native integration. See [desktop and phone support](../coordinator/docs/DESKTOP_PHONE.md).
