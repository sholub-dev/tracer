# Add title search to the sidebar Recent list

## What changed

- The sidebar's Recent list has a "Search investigations" box above the All/Chats/Alerts/API filter. Typing narrows the list to sessions whose title contains every typed word (case-insensitive, any order, extra whitespace ignored). It combines with the kind filter. A clear button (x) resets it. When nothing matches, the list shows "No matches" instead of "Nothing here yet".
- New pure helper `packages/web/src/lib/session-search.ts` exporting `matchesQuery(title, query)`, with unit tests in `packages/web/src/lib/session-search.test.ts` (5 tests: empty/blank query, case, word order, whitespace, no match).
- `packages/web/src/components/layout/RecentSessions.tsx` holds the query state, renders the input and clear button, filters inside the existing `useMemo`, and resets the row limit when the query changes.
- `PLAN.md` records the review and plan for this change.
- Three screenshots are added under `docs/screenshots/`.

## Why

The Recent list grows without bound and could only be filtered by session kind, so there was no way to find an investigation by its title. The sidebar already loads the full list through `trpc.sessions.list`, so the filter is client-side. No server, API or data-format change is needed. With the box empty, the list behaves as before.

## How it was tested

Commands run in this sandbox (`pnpm` is not installed here, so the package scripts were run through `npx`/`node_modules/.bin` with the same commands they wrap):

- Web unit tests: `cd packages/web && npx --no-install tsx --test $(find src -name '*.test.ts' -o -name '*.test.tsx')`. Result: `# tests 100`, `# pass 100`, `# fail 0`. The new `session-search.test.ts` file alone was run with `npx --no-install tsx --test src/lib/session-search.test.ts`: 5 pass, 0 fail.
- Web typecheck: `cd packages/web && npx --no-install tsc --noEmit`. No errors printed.
- Lint: `node_modules/.bin/biome lint .` from the repo root. Result: "Checked 373 files", exit 0. The root `lint` script also runs `pnpm typecheck` for all packages; only the web typecheck was run here.
- Server tests: `cd packages/server && npx --no-install tsx --test $(find src -name '*.test.ts')`. Result: `# tests 426`, `# pass 391`, `# fail 35`. The failing files are under `db/`, `http/`, `monitors/`, `agents/`, `integrations/` and `llm/`; several exit with SIGSEGV. No server file is changed in this branch. This run does not reproduce the 732 passing server tests expected for this change, so the server result is not established here and needs a check in a working environment.
- Screenshots: the three images below were taken from the running web interface, as stated in the task. The manual check listed in `PLAN.md` is evidenced by those images.

## Screenshots

![Sidebar Recent list with an empty search box and all sessions shown](docs/screenshots/search-empty.png)

![Sidebar with the query "checkout" typed, showing only the three checkout sessions with the clear button](docs/screenshots/search-filtered.png)

![Sidebar with the query "zzzz nothing" typed, showing the "No matches" message](docs/screenshots/search-no-matches.png)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
