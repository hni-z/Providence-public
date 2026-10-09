# Sharing the showcase source

The current source uses fictional device names, example account details and placeholder bundle identifiers. Set your own app identifiers and signing team locally before installing an Apple client. The product website and Devpost links are intentionally public.

Keep provider keys, client/device access tokens, account sessions, signing assets, local configuration, personal paths, screenshots of real workspaces and operational logs outside Git. Use the existing `.env.example` files for configuration documentation. Hosted account credentials and encrypted API keys remain in private server storage.

Before sharing changes:

```sh
python3 scripts/check-showcase-privacy.py
gitleaks dir --redact /path/to/clean-source
```

The default privacy check covers tracked and non-ignored new files. For a history-free export, run `python3 scripts/check-showcase-privacy.py --source-dir /path/to/clean-source`. Run the secret scanner on that clean source export without dependencies or private ignored files. Review any findings; security tests may contain intentional dummy credentials. Inspect images and their metadata separately.

## Git history is a separate surface

Deleting a file from the latest revision does not delete it from old commits, other branches, pull requests, forks or clones. Historical commits also contain author names and email addresses. A source archive created from the cleaned revision contains no Git history. Use a new history-free repository for a public showcase if the existing repository contains personal operational records. Do not make an old private repository public on the strength of a current-file scan alone.

A privacy scan reduces accidental disclosure; it is not a guarantee that every possible sensitive detail has been detected. Revoke any genuine exposed credential at its provider even after removing it from source.

## Public source contents

Keep development handoffs, agent instructions, prompt transcripts, release receipts and personal debugging records outside the source export. Runtime instructions in `coordinator/src/tools.ts`, `coordinator/src/runtime.ts`, `coordinator/src/working-style.ts` and `backend/src/ai.ts` implement the product and remain part of its source. Test prompts and synthetic credentials exercise those interfaces.

The source is a public showcase with all rights reserved; no open-source license is granted. See [LICENSE](../LICENSE). Third-party components retain their respective licenses. A separate reuse or distribution agreement would need its own review, including artwork rights and client configuration. The Watch helper, iPhone shell and Mac enrollment helper currently include the original hosted origin. A clean source scan does not establish that those clients are ready for another operator's server.
