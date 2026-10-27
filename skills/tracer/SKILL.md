---
name: tracer
description: Drive the local Tracer observability agent from the CLI to investigate incidents and query providers (New Relic, GCP, PostHog), returning only the final analysis. Use when the user asks to "ask Tracer", "investigate with Tracer", "run a Tracer analysis", or wants a root-cause / error-rate / latency / logs investigation across their observability stack, and to follow up on a prior Tracer session.
---

# Tracer CLI

## Purpose

Tracer is a local-first AI observability agent. `tracer-sh analyze` runs an
investigation to completion on the running local Tracer server and returns only
the final analysis, plus a session id you can pass back to continue it.

## Prerequisites

- Node.js 22.12 or newer.
- The Tracer server running locally (default `http://127.0.0.1:3579`; override
  with `TRACER_HOST` / `TRACER_PORT`). Health check:
  `curl -s 127.0.0.1:3579/health` returns `{"status":"ok"}`.
- An LLM key configured in Tracer's Settings, and data providers connected for
  real queries.
- The CLI: `tracer-sh` if installed globally (`npm i -g tracer-sh`), otherwise
  `node bin/tracer.mjs analyze ...` from a Tracer checkout. `analyze` only makes
  an HTTP call; it never starts the server.
- `tracer-sh --help` lists all commands and flags; `tracer-sh --version` prints
  the version.

## Command

```
tracer-sh analyze "<message>" [--session <id>] [--provider <name>] [--json]
```

- `<message>` (required): the question for the agent.
- `-s, --session <id>`: continue an existing session with its full context.
  Omit to start a new one.
- `-p, --provider <name>`: scope to one provider (`newrelic`, `gcp`, `posthog`).
  Omit for unified mode across all connected providers.
- `--json`: print the full envelope `{ sessionId, status, analysis, queries,
  usage, model }`. Avoid by default: `queries` holds the full raw rows and can
  be very large. Use it only when you need the rows programmatically.

Default mode (no `--json`): stdout is just the `analysis` prose, and the line
`session <id> · <model>` goes to stderr. The analysis already includes the
executed queries and a compact summary of their results; that is the evidence.

Exit code is non-zero on error (server unreachable, no model configured, or the
session is already processing a response). New sessions are tagged `api` and
appear in the API group in Tracer's sidebar, where they can also be continued
from the web UI.

Any Tracer session can be continued with `--session <id>`: web chats, monitor
investigations, and API sessions. The id is the last segment of the web URL
`/debug/<id>`.

## Workflow

1. If unsure the server is up, run `curl -s 127.0.0.1:3579/health`. If it fails,
   tell the user to start Tracer (`tracer-sh` with no args, or `pnpm dev` in the
   checkout). Do not start it yourself.
2. Run the analysis in default mode. It runs real provider queries and can take
   a while; let it block.
3. Present the analysis (stdout) to the user.
4. Keep the session id from the stderr line. For follow-ups on the same
   investigation, reuse it with `--session <id>` so prior context stays. Start a
   new session only when the topic changes.
5. On a non-zero exit, report the error message verbatim and stop.

## Examples

```
tracer-sh analyze "Why did checkout error rate spike after 14:00 UTC?"
tracer-sh analyze "Top 5 slowest GCP Cloud Run requests right now." --provider gcp
tracer-sh analyze "Correlate that spike with recent deploys." --session <id>
tracer-sh analyze "Return the raw error counts per minute." --json
```
