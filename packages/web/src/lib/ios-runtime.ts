import { App } from "@capacitor/app";
import { Keyboard } from "@capacitor/keyboard";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite";
import { unstable_localLink, type TRPCLink } from "@trpc/client";
import superjson from "superjson";
import { sessionChanges, startMobileServer } from "@tracer-sh/server/mobile";
import type { AppRouter } from "@tracer-sh/server/router";
import { setCopyLink } from "./copy-link";
import { setServerFetch } from "./server-fetch";

const DB_NAME = "tracer";
// Any absolute origin works: the in-process server reads only the path.
const SERVER_ORIGIN = "http://tracer.local";

/** The local database cannot be opened; only a reset makes the app usable again. */
export class LocalDataError extends Error {}

function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function openDatabase() {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  if (!(await sqlite.isSecretStored()).result) {
    if ((await sqlite.isDatabase(DB_NAME)).result) {
      throw new LocalDataError("The key that unlocks your local data is missing from the keychain.");
    }
    await sqlite.setEncryptionSecret(newSecret());
  }
  await sqlite.checkConnectionsConsistency();
  try {
    const connection = await sqlite.createConnection(DB_NAME, true, "secret", 1, false);
    await connection.open();
    return connection;
  } catch (err) {
    throw new LocalDataError(`Your local data does not open: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Deletes the database and stores a new key, so the next start creates an empty database. */
export async function resetLocalData(): Promise<void> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  await sqlite.closeAllConnections().catch(() => {});
  await sqlite.clearEncryptionSecret().catch(() => {});
  await sqlite.setEncryptionSecret(newSecret());
  // The plugin deletes a database it cannot open only through a full import with overwrite.
  await sqlite.importFromJson(JSON.stringify({ database: DB_NAME, version: 1, encrypted: true, mode: "full", overwrite: true, tables: [] }))
    .catch((err: unknown) => console.warn("Reset import:", err instanceof Error ? err.message : String(err)));
}

const LLM_IDLE_MS = 120_000;

/** Fails an LLM call that gets no bytes for two minutes: after iOS suspends the app, a connection can stay open but dead. */
function failWhenIdle(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const cancel = new AbortController();
    // Not AbortSignal.any: it needs iOS 17.4, and the app supports iOS 15.
    const outer = init?.signal;
    if (outer?.aborted) cancel.abort(outer.reason);
    else outer?.addEventListener("abort", () => cancel.abort(outer.reason), { once: true });
    const signal = cancel.signal;
    const stalled = () => new Error(`No data from the model for ${LLM_IDLE_MS / 1000} s`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A plain Error, not an abort: the run must end as failed, with Retry.
    const response = await new Promise<Response>((resolve, reject) => {
      timer = setTimeout(() => { reject(stalled()); cancel.abort(); }, LLM_IDLE_MS);
      fetchImpl(input, { ...init, signal }).then(resolve, reject);
    }).finally(() => clearTimeout(timer));
    if (!response.body) return response;
    let arm = () => {};
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => { controller.error(stalled()); cancel.abort(); }, LLM_IDLE_MS);
        };
        arm();
      },
      transform(chunk, controller) {
        arm();
        controller.enqueue(chunk);
      },
      flush() {
        clearTimeout(timer);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** iOS suspends the WebView soon after the app leaves the foreground; monitors run only while it is in front. */
function runSchedulerInForeground(scheduler: { start(): void; stop(): Promise<void> }) {
  void App.addListener("appStateChange", ({ isActive }) => {
    if (isActive) scheduler.start();
    else void scheduler.stop();
  });
}

/** Keeps the screen on while an agent run streams, so the owner can watch it. */
async function keepAwakeWhileRunning(activeRuns: () => number) {
  let awake = false;
  // The generator resumes after the run's map entry changes, so the count is current.
  for await (const _ of sessionChanges()) {
    const running = activeRuns() > 0;
    if (running === awake) continue;
    awake = running;
    console.log(`KeepAwake ${running ? "on" : "off"}`);
    await (running ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch((err: unknown) => console.warn("KeepAwake:", err));
  }
}

/** The Camera app opens tracer://copy links; the dialog asks before anything is replaced. */
function listenForCopyLinks() {
  const accept = (url: string | undefined, fromLaunch: boolean) => {
    if (!url?.startsWith("tracer://copy")) return;
    // The launch URL survives the reload after a copy, so it is offered once. A new scan is always
    // offered: after a failed copy the same code still works.
    try {
      if (fromLaunch && sessionStorage.getItem("copyLinkSeen") === url) return;
      sessionStorage.setItem("copyLinkSeen", url);
    } catch { /* storage off: offer the link anyway */ }
    setCopyLink(url);
  };
  void App.getLaunchUrl().then((launch) => accept(launch?.url, true));
  void App.addListener("appUrlOpen", ({ url }) => accept(url, false));
}

/** Opens the encrypted database, starts the server in this JS context, and returns the tRPC links that call it. */
export async function startIosRuntime(): Promise<TRPCLink<AppRouter>[]> {
  const connection = await openDatabase();
  // The global fetch goes through the native HTTP plugin, which buffers whole responses; the WebView fetch streams.
  const webFetch = (window as { CapacitorWebFetch?: typeof fetch }).CapacitorWebFetch;
  const server = await startMobileServer({ connection, llmFetch: failWhenIdle(webFetch ? webFetch.bind(window) : fetch) });
  setServerFetch((input, init) =>
    server.fetch(input instanceof Request ? input : new Request(new URL(String(input), SERVER_ORIGIN), init)),
  );
  if (server.scheduler) runSchedulerInForeground(server.scheduler);
  void keepAwakeWhileRunning(server.activeRuns);
  listenForCopyLinks();
  Keyboard.setAccessoryBarVisible({ isVisible: false }).catch((err: unknown) => console.warn("Keyboard:", err));
  return [unstable_localLink({ router: server.router, createContext: server.createContext, transformer: superjson })];
}
