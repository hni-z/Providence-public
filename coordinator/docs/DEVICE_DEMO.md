# Device testing and recovery

Use your own configured HTTPS coordinator and authenticated clients. For hosted accounts, connect the test computers through `/account`. See [DEMO.md](DEMO.md) for an example workflow.

## Prepare

- Confirm each computer's hostname, operating system, workspace and online state in device details.
- Use dedicated test conversations and sample files. Keep credentials and personal workspace contents out of recordings.
- For cross-device testing, submit from the actual client and inspect the output on the selected computer. Record task identity and the artifact hash when diagnosing a mismatch.
- Test Watch dictation, Quest interaction and audio on the relevant hardware. Browser fixtures and builds cover software behavior only.

## Recovery

| Symptom | Action |
| --- | --- |
| Uncertain submission | Keep the original request ID. Refresh the existing task, or use the client's same-request retry. |
| Worker offline | Check its companion process, sleep state and connection. Restart the same companion with its existing configuration if needed. Inspect interrupted work before submitting again. |
| Expired approval | Refresh the task and review its current approval. An old answer cannot resolve a different request. |
| Missing output | Check the worker task and artifact list. Published files must be inside the allowed workspace and within the 512 KiB limit. |
| Authentication rejected | Check the origin and the correct client or device credential. These credentials serve different purposes. |
| Coordinator restart | Wait for active work to finish and retain the state directory. Unfinished tasks become interrupted and pending approvals expire. |

[Watch API](WATCH_API.md), [Windows setup](WINDOWS_SETUP.md) and [desktop capability support](DESKTOP_PHONE.md) describe the relevant interfaces.
