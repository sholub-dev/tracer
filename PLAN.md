# Plan: search box for the Recent sessions list

## Review
- Monorepo: `shared`, `server` (tRPC + SQLite/SQLCipher), `web` (Vite, React 19, Tailwind, shadcn), `ios` (Capacitor wrapper of the web app).
- The README is thorough and matches the features; `docs/` only holds screenshots.
- The web package keeps logic in small pure `lib/*.ts` files with `*.test.ts` next to them (run by `tsx --test`); good pattern to follow.
- Components have few tests; the UI is covered mostly through the pure helpers.
- The sidebar `RecentSessions` only filters by kind (All/Chats/Alerts/API); no way to find a session by title.
- The sidebar already loads the full list through `trpc.sessions.list`, so a client-side filter needs no server change.
- The row limit (`FIRST_ROWS`) and day grouping are done in the component; filtering code is inline in a `useMemo` and untested.
- No keyboard shortcut to focus a list or search (only the sidebar toggle shortcut).
- Settings and monitors pages are large; refactoring is out of scope for a small change.

## Feature: title search in the Recent list
- **What:** a "Search investigations" input above the kind filter in the sidebar. Typing narrows the list to sessions whose title contains all typed words (case-insensitive), combined with the kind filter. A clear button resets it; an empty result shows "No matches".
- **Where:** new pure helper `packages/web/src/lib/session-search.ts` (`matchesQuery(title, query)`) with `session-search.test.ts`; wired into `packages/web/src/components/layout/RecentSessions.tsx` (state, input, empty message).
- **Why it fits:** the list grows without bound and is only filterable by kind. It is client-only, changes no data format or API, and leaves existing behaviour unchanged when the box is empty. It works on iOS too, since it is shared web code.
- **Screenshot:** the desktop sidebar with a query typed (e.g. "checkout"), showing only the matching rows with the clear button; a second shot with the "No matches" state.
- **Tests:** unit tests for `matchesQuery` (empty query, case, multiple words in any order, whitespace, no match) run with `cd packages/web && pnpm test`; plus `pnpm typecheck` and a manual check in the running UI.

Branch: `feature/session-search`
