# Providence runtime profiles

Providence's Codex-backed routing master and device workers default to **GPT-6 Sol, low reasoning, Fast service tier**: `gpt-6-sol`, `low`, `priority`. These settings belong to Providence's app-server requests. They do not change engineering tasks' models, global Codex configuration, account authentication, or the separate speech/transcription providers.

The authenticated Mac catalog checked on September 26, 2026 advertises `gpt-6-sol`, reasoning effort `low`, and service-tier ID `priority` with display name **Fast** and description **1.5x speed**. Each computer still checks its own current catalog. This description is not a guarantee that each task takes two-thirds of its previous time. Tool execution, approvals, networking and other work also affect total duration.

Every new or resumed thread receives `model`, `serviceTier`, and `config.model_reasoning_effort`. Providence verifies the resolved settings before starting work. Every `turn/start` also explicitly supplies `model`, `effort`, and `serviceTier`, so an existing conversation cannot retain an old Astra/ultra profile merely because its thread was already loaded. Existing thread/chat IDs, permissions and histories are preserved.

Optional Providence-process environment overrides are `PROVIDENCE_MODEL`, `PROVIDENCE_REASONING_EFFORT`, and `PROVIDENCE_SERVICE_TIER`. Each must use an exact value supported by that device's authenticated model catalog. Unsupported or unconfirmed profiles fail with an explicit error; there is no silent model/tier fallback. Use `priority` for the app-server tier supported here. The similarly named `service_tier = "fast"` in Codex's configuration-file documentation is a different interface.

## Reading the startup line

Each runtime prints one line after its catalog check passes:

```
Providence runtime profile confirmed by this device's catalog: model gpt-6-sol, reasoning effort low, service tier priority.
```

That line names the exact three values the coordinator asked for and the catalog accepted, so a later failure can be read against a known starting point. There is no line when the check fails; the thrown message names the value the catalog rejected instead. Providence never selects a substitute profile, so a device whose catalog has moved on stays offline until one of the three overrides below matches it.

| Variable | Sets | Accepted form |
| --- | --- | --- |
| `PROVIDENCE_MODEL` | Model | A catalog `model` value, up to 200 characters of letters, digits, `.`, `_`, `:`, `/`, `-`, starting with a letter or digit |
| `PROVIDENCE_REASONING_EFFORT` | Reasoning effort | A `supportedReasoningEfforts` value, up to 64 lowercase characters, digits, `_` or `-` |
| `PROVIDENCE_SERVICE_TIER` | Service tier | A `serviceTiers` ID, same form as the reasoning effort |

Set them in the Providence process only. A surrounding space, a trailing newline, or an empty value is rejected at startup rather than trimmed, so the running profile is always the configured one. Run `codex app-server` and read `model/list` on the device to see the values its authenticated catalog advertises.

The profile does not grant browser or desktop permission. Full filesystem access, successful task dispatch, and functioning Computer Use are separate facts. A task can reach a computer successfully and then stop because Chrome permission was declined. A Mac Computer Use pipe-startup failure is likewise distinct from a routing failure. Do not replay a stopped message send or weaken permissions to make a profile check pass.

Validation records must distinguish the requested profile, resolved app-server thread settings, actual turn model/effort, and observed completion. `turn/start` does not return backend service-tier telemetry, so a resolved Fast setting must not be presented as independent proof of a fixed speedup.

## Hosted coordination and the selection check

The hosted coordinator uses the Responses API separately from each computer's Codex subscription. Its default is also `gpt-6-sol`, with `reasoning: { effort: "low" }` and `service_tier: "fast"` explicitly included on every request, including tool follow-ups. `PROVIDENCE_HOSTED_MODEL` overrides the hosted model only. A supplied model must support these request settings; an API error does not trigger a silent model fallback. Speech and transcription keep their separate models.

A September 26, 2026 check made six real hosted Responses requests: the same three short synthetic routing cases on GPT-5.6 Sol Low Fast and GPT-6 Sol Low Fast, with no device actions or tools. Both passed all three checks. GPT-5.6 Sol elapsed times were 1483, 863 and 1311 ms (median 1311 ms); GPT-6 Sol took 943, 1185 and 827 ms (median 943 ms, about 28% lower). Sol 6 was slower on one case. These six requests supported the default selection; they are not a general capability benchmark, Codex-worker latency measurement, physical computer-use test, or guarantee for future tasks.

Fast mode has different billing on the two routes. Codex consumes the signed-in account's subscription credits; hosted Responses uses the account's OpenAI API key and API token rates. Model, reasoning, token counts, caching and tool work affect total cost and time.

References: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode), [Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [App Server](https://learn.chatgpt.com/docs/app-server). The installed catalog and generated protocol schema take precedence for the exact app-server wire fields used by this release.

The integrated candidate additionally accepts private per-role model/effort
settings: masterModel/masterReasoningEffort, localWorkerModel/localWorkerReasoningEffort,
and companion workerModel/workerReasoningEffort. They override only that role's
model/effort while preserving the selected service tier. Conflicting coordinator
local-worker and worker aliases are rejected. These values still pass the same
catalog and resolved-profile checks; they never change global Codex settings.
