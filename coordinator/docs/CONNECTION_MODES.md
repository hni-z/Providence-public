# Providence connection modes

Providence routes work through **website → authenticated Providence API → connected computer’s locally authenticated Codex app-server → tracked task/result**. Desktop navigation links are a separate manual handoff, not an automatic execution transport.

## Documented desktop links

The [official desktop commands reference](https://learn.chatgpt.com/docs/reference/commands#deep-links) documents:

| Purpose | Syntax | Meaning |
| --- | --- | --- |
| Open an existing local task | `codex://threads/<thread-id>` | Navigate to its technical thread ID. |
| Open a new local task | `codex://threads/new` | Open a new composer. |
| Prefill a new task | `codex://threads/new?prompt=<encoded-text>` | Put text in the new composer. |
| Alternate new-task form | `codex://new?prompt=<encoded-text>` | Requires at least one supported query parameter. |

New-task links accept `prompt`, `path` and `originUrl`. `path` is an absolute local directory; `originUrl` matches a known workspace by Git remote. If both are supplied, path resolution takes priority. Percent-encode query values. The documented example explicitly leaves sending to the user. The existing-task form has no documented prompt or automatic-send parameter. Do not invent `send=true`, attach a prompt to an existing-task URI, or claim that opening a link executed work.

Example:

```text
codex://new?prompt=Review%20the%20Providence%20demo%20checklist.
```

## Human handoff to an existing desktop task

If a user deliberately chooses desktop handoff:

1. Copy the reviewed instruction from Providence.
2. Open `codex://threads/<the-registered-provider-thread-id>` on the computer containing that local task.
3. Verify the destination, paste the instruction, and press Send in the desktop app.

For a new-task link, step 3 still requires reviewing the prefilled composer and pressing Send. The link acts on the device where it is opened; no remote host selector is documented for these chat URLs. A phone without the desktop handler cannot use this as a remote executor.

Browser focus changes or a link click do not confirm task submission. The website must not claim a provider task ID, progress, approval resolution or returned artifact from the link alone. Automatic tracking requires a separately working supported integration; otherwise any reported completion is explicitly user-reported.

## Automatic execution and existing conversations

App-server is the supported product integration surface for starting/resuming conversations, turns, events and approvals. Its existing-thread APIs are separate from desktop URI navigation. Registering a stored Codex thread in a standalone app-server does not, by itself, prove attachment to the desktop-owned live runtime or inheritance of its Computer Use permissions. [Official app-server protocol](https://learn.chatgpt.com/docs/app-server)

A tool available inside a desktop app is not automatically available to the public Providence website or a separate app-server process. Do not copy host session metadata or expose private IPC to bridge that boundary.

## Delivery rule

Keep imported history, task execution, manual desktop handoff and desktop GUI capability distinguishable. Verify an actual app action and its result on the selected computer before describing that control route as working. An online companion, completed text response or opened desktop link is not sufficient evidence.
