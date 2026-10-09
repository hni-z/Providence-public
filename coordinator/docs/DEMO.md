# Demonstrating Providence

Run your own configured coordinator and authenticate each client. For the hosted service, sign in at `/account` and connect your computers first. Use a dedicated workspace with sample data and keep access keys out of recordings.

## Example workflow

1. Connect a computer and create an **Event brief** conversation. Give it a fictional event name, time and audience.
2. Create an **Invitation** conversation on the intended computer. Select Event brief as a context source and request an invitation text file.
3. Follow the task's progress, then preview and download the returned file. Check the displayed device, conversation and file revision.
4. Ask for a shorter version in the same conversation. Compare the new file with the original snapshot.
5. With a second connected computer, submit a request from its browser to the first computer and inspect the resulting file on both sides.

The optional product decision tool has been removed. Runtime permission requests may still appear when the configured execution environment requires them.

For device preparation and recovery, see [DEVICE_DEMO.md](DEVICE_DEMO.md). Voice, headset interaction and native computer control depend on the configured providers, tools and device permissions. A scripted fixture is available through `npm run demo:fixture`; it uses synthetic responses and does not execute computer tasks.
