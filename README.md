# OKO

Local-first AI-powered observability platform.

<p align="center">
  <img src="docs/hero.gif" alt="OKO Demo" width="800" />
</p>

During an incident, most time goes to switching between observability tools
and gathering context — not fixing the problem. OKO connects your providers
to a single AI chat interface so you find the root cause in one place.

```
┌─────────┐       your API keys         ┌──────────────────┐
│         │ ◄──────────────────────────►│  Observability   │
│   OKO   │                             │  Providers       │
│  local  │       your API keys         ┌──────────────────┐
│         │ ◄──────────────────────────►│  LLM Providers   │
└─────────┘                             └──────────────────┘
```

Runs on your machine. No intermediary servers — only calls to your own
provider and LLM APIs using your API keys.

## Features

**Debug** — Chat with an AI agent that queries your providers in real-time,
correlates data across services, and finds root causes. Sessions persist
with full conversation history.

**Dashboard** *(coming soon)* — Describe what you want to see and the AI builds the query,
picks a chart type, and places it on a drag-and-drop grid.

**Monitors** *(coming soon)* — Scheduled query checks with configurable thresholds.
Automatic evaluation, alert history, and trigger/resolve tracking.

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

## Development

```bash
git clone https://github.com/sholub1989/oko.git && cd oko
npm i -g pnpm && pnpm i
pnpm dev
```

Open `http://localhost:5173` for dev mode with hot reload.

## Providers & Models

| Data Providers | LLM Providers |
|---|---|
| **New Relic** (NRQL via NerdGraph) | **Anthropic** (Claude) |
| **Google Cloud** (Logs, Traces, Metrics, Errors via MCP) | **Google** (Gemini) |
| More coming soon | |

All configured through the Settings UI. The provider system uses a factory
pattern — adding a new provider means implementing `IProvider` and
registering a factory.

## Production

```bash
pnpm build && pnpm start
```

Full app at `http://localhost:3579`.

## Project Structure

```
packages/
  shared/   — Types and interfaces
  server/   — Hono + tRPC, provider system, SQLite
  web/      — React 19 + Vite, Tailwind v4
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `better-sqlite3` build fails | macOS: `xcode-select --install` / Linux: `sudo apt install build-essential python3` |
| Wrong Node.js version | Need 20+. Check with `node -v` |
| Port in use | `OKO_PORT=3580 oko-sh` |
| Provider not connecting | Check API keys in Settings |
| No LLM responses | Add an Anthropic or Google API key in Settings |
| GCP shows disconnected | Run `gcloud auth application-default login`, then click **Test Connection** in Settings |
| GCP chat fails with auth error | Same as above — credentials expired or require re-login |

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/) — free for non-commercial use.
