# AI usage and billing

The hosted Providence release uses the account owner's OpenAI API key for coordination, transcription and spoken replies. The API project pays for that usage. A connected computer uses its own signed-in Codex runtime for delegated work, subject to that account's access and usage limits. Providence does not automatically switch either route to another funding source when a limit is reached.

API billing, ChatGPT subscriptions and optional ChatGPT credits are separate. Removing a saved key stops its use by Providence; revoking the key at OpenAI is a separate action. Device authorization is separate from both billing routes.

## Sign in with ChatGPT plan sharing

OpenAI introduced an official way for eligible users to authorize participating applications to use their ChatGPT plan. This is a potential future coordination option, but it is not enabled in the current hosted Providence release.

The current preview is not a drop-in replacement for Providence's API key:

- Remotely hosted applications must request access from OpenAI before offering plan sharing. Publishing source under an all-rights-reserved showcase license does not make Providence an open-source integration.
- The documented public flow supports eligible Responses API inference. It does not cover this release's live voice, speech generation or transcription stack.
- The inference contract requires streaming, explicit input history and `store: false`; several ordinary Responses fields and hosted tools are unsupported. It needs a separate tested adapter, not substitution of an OAuth token into the existing API-key path.
- Identity, plan-usage permission and Providence device authorization are separate grants. A ChatGPT sign-in does not pair a computer or make Providence's dispatcher untrusted.

Before enabling it, obtain approval for the hosted application, implement its issued client configuration, verify account linking and token renewal, test the allowed models/tools and limit errors, and show the selected funding source clearly. Do not extract credentials from an existing ChatGPT or Codex login, use private ChatGPT endpoints, silently fall back to an API key, or change the project's license to imply eligibility.

References checked October 2, 2026: [Sign in with ChatGPT](https://developers.openai.com/siwc/quickstart), [hosted-app eligibility](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), and [usage UI guidance](https://developers.openai.com/siwc/ui-ux-guidelines).
