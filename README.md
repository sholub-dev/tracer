# OKO

[![npm version](https://img.shields.io/npm/v/oko-sh)](https://www.npmjs.com/package/oko-sh)

Local-first AI-powered observability platform.

During an incident, most time goes to switching between observability tools
and gathering context — not fixing the problem. OKO connects your providers
to a single AI chat interface so you find the root cause in one place.

```
┌─────────┐       your API keys         ┌──────────────────┐
│         │ ◄──────────────────────────► │  Observability   │
│   OKO   │                             │  Providers       │
│  local  │       your API keys         ├──────────────────┤
│         │ ◄──────────────────────────► │  LLM Providers   │
└─────────┘                             └──────────────────┘
```

Everything runs on your machine. Your data stays local in a SQLite database.
OKO talks directly to your provider and LLM APIs using your own API keys —
no intermediary servers, no data leaves your machine except API calls you control.

## Install

Requires [Node.js 20+](https://nodejs.org/).

```bash
npx oko-sh
```

Or install globally:

```bash
npm install -g oko-sh
oko-sh
```

Open `http://localhost:3579`, go to **Settings** to add your API keys and choose an LLM — done.

## Features

- **Debug** — Chat with an AI agent that queries your providers in real-time, correlates data across services, and finds root causes

## Supported Providers

| Data Providers | LLM Providers |
|---|---|
| New Relic (NRQL via NerdGraph) | Anthropic (Claude) |
| Google Cloud (Logs, Traces, Metrics, Errors) | Google (Gemini) |

## Uninstall

```bash
npm uninstall -g oko-sh
```

To also remove your local database (settings, sessions, API keys):

```bash
rm -rf ~/.oko
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `better-sqlite3` build fails | macOS: `xcode-select --install` / Linux: `sudo apt install build-essential python3` |
| Port in use | `OKO_PORT=3580 oko-sh` |
| No LLM responses | Add an API key in Settings |

## License

[PolyForm Shield 1.0.0](https://polyformproject.org/licenses/shield/1.0.0/) — free to use, except to build competing products.
