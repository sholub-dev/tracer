# Tracer

[![npm version](https://img.shields.io/npm/v/tracer-sh)](https://www.npmjs.com/package/tracer-sh)
[![CI](https://github.com/sholub-dev/tracer/actions/workflows/ci.yml/badge.svg)](https://github.com/sholub-dev/tracer/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sholub-dev/tracer/actions/workflows/codeql.yml/badge.svg)](https://github.com/sholub-dev/tracer/actions/workflows/codeql.yml)

Local-first AI-powered observability platform.

During an incident, most time goes to switching between observability tools
and gathering context — not fixing the problem. Tracer connects your providers
to a single AI chat interface so you find the root cause in one place.

## Debug

Chat with an AI agent that queries your providers in real-time and finds root causes — all from a single conversation.

- Natural language investigation
- Live query execution with inline charts
- Post-mortem reports — download as Markdown to share
- Share investigations as PNG — drop the exported image back into Tracer to re-open the analysis
- Agent memory across sessions
- Session history and cost tracking

![Debug page](docs/screenshots/debug_page.png)

## Settings

Configure providers, LLM credentials, agent behavior, and memory. All data is stored locally — nothing leaves your machine except the API calls you configure.

- Anthropic (Claude) and Google (Gemini) API keys
- Data provider setup with connectivity tests
- Thinking budgets and step limits
- Agent memory management

![Settings page](docs/screenshots/settings_page.png)

## How it works

```
┌─────────┐       your API keys         ┌──────────────────┐
│         │ ◄──────────────────────────►│  Observability   │
│ Tracer  │                             │  Providers       │
│  local  │       your API keys         ├──────────────────┤
│         │ ◄──────────────────────────►│  LLM Providers   │
└─────────┘                             └──────────────────┘
```

Everything runs on your machine. Your data stays local in an encrypted SQLite
database. Tracer talks directly to your provider and LLM APIs using your own API
keys — no intermediary servers, no data leaves your machine except API calls you control.

## Security

Tracer is built **defense-in-depth**: your secrets — provider and LLM API keys,
integration tokens, chat history, and agent memory — sit behind several independent
layers, so no single failure exposes them.

- **Local-only.** Nothing leaves your machine except the provider and LLM API calls you configure. No Tracer servers, no telemetry, no sync.
- **Encrypted at rest.** The entire SQLite database is encrypted with SQLCipher (AES-256). On disk it is ciphertext — a stolen laptop, a copied `.db` file, or a backup is useless without the key.
- **Machine-bound, user-scoped key.** A random 256-bit key is generated on first run and stored in your OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service). It never leaves the machine and is scoped to your OS user, so another user on the same box can't read the database either.
- **Hardened on disk.** The data directory is created owner-only (`0700`); if no keychain is available, the fallback key file is written `0600`.

**Automatic and transparent.** New installs are encrypted from the first run. An
existing plaintext database is migrated on the first launch of this version — the
encrypted copy is verified and atomically swapped in, and no plaintext is left behind.
There's nothing to enable.

**CI / headless.** Where no keychain exists, supply the key yourself with
`TRACER_DB_KEY` — a 64-character hex string (e.g. `openssl rand -hex 32`).

**What this protects — and what it doesn't.** Encryption at rest defends the file
(theft, backups, copies) and blocks other users on the same machine. It does **not**
defend against you, the logged-in user, running code as yourself: the app must hold the
key at runtime to read its own data, so anyone controlling your user session can too. No
local-first app escapes this — it's the honest boundary of on-device encryption.

**Key loss means data loss.** Because the key lives only in your keychain, losing it (an
OS reinstall or keychain reset) makes the database unrecoverable. For a safety net, back
up the `tracer-sh` / `db-key` keychain value somewhere secure.

**Verify it yourself.** The raw file should be unreadable without the key:

```bash
sqlite3 ~/.tracer/data/tracer.db '.tables'    # → "Error: file is not a database"
head -c 16 ~/.tracer/data/tracer.db | od -c   # → random bytes, not "SQLite format 3"
```

## Install

Requires [Node.js 20+](https://nodejs.org/).

**Run the latest, no install:**

```bash
npx tracer-sh@latest
```

`npx` is ephemeral — it runs the newest published version on every launch and isn't a pinned version.

**Install a pinned copy:**

```bash
npm install -g tracer-sh
tracer-sh
```

The first run gets the latest version; it then stays on that version until you explicitly update — either with **Update now** in the app (click the version in the sidebar) or by re-running the install.

**Which should I pick?** Use the global install if you want a stable version that only changes when you choose; use `npx` to always grab the newest with zero install.

Open `http://localhost:3579`, go to **Settings** to add your API keys and choose an LLM — done.

## Headless / CLI

Run an investigation from the terminal and get back the final analysis — so other tools and agents (including Claude Code) can drive Tracer:

```bash
tracer-sh analyze "Why did checkout error rate spike after 14:00 UTC?"
```

Continue a prior run with `--session <id>`; pass `--json` for the full response (session id, queries, usage). Requires a running server.

## Supported Providers

**Data:** New Relic (NRQL), Google Cloud (Logs, Traces, Metrics, Errors), PostHog (HogQL)

**LLM:** Anthropic (Claude), Google (Gemini)

## Uninstall

```bash
npm uninstall -g tracer-sh
```

To also remove your local database (settings, sessions, API keys):

```bash
rm -rf ~/.tracer
```

The database encryption key also lives in your OS keychain (service `tracer-sh`,
account `db-key`). Remove it for a clean slate — on macOS:

```bash
security delete-generic-password -s tracer-sh -a db-key
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Native SQLite build fails | macOS: `xcode-select --install` / Linux: `sudo apt install build-essential python3` |
| Port in use | `TRACER_PORT=3580 tracer-sh` |
| No LLM responses | Add an API key in Settings |
| Headless / CI: no keychain available | Set `TRACER_DB_KEY` to a 64-char hex key (`openssl rand -hex 32`) |

## Contributing

Contributions are welcome! There are two main ways to help:

**Report bugs or request features** — [open an issue](https://github.com/sholub-dev/tracer/issues). Include steps to reproduce for bugs, or a clear description for feature requests.

**Submit a code change:**

1. Fork this repo
2. Create a branch (`git checkout -b fix/my-fix`)
3. Make your changes and commit
4. Push to your fork (`git push origin fix/my-fix`)
5. Open a pull request against `master`

All PRs require approval before merging.

## License

[Elastic License 2.0](https://www.elastic.co/licensing/elastic-license) — free for any use, including internal business use, modification, and redistribution. You may not offer it as a hosted or managed service competing with Tracer.
