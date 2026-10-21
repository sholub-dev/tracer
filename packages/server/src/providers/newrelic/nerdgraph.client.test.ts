import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NerdGraphClient } from "./nerdgraph.client.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const reply = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;
};
const client = () => new NerdGraphClient("key", "1");

test("a non-2xx response puts the first 500 characters of the body in the error", async () => {
  reply("x".repeat(800), 400);
  await assert.rejects(client().query("SELECT 1", { retry: false }), (e: Error) => e.message.includes("400") && e.message.endsWith("x".repeat(500)) && !e.message.includes("x".repeat(501)));
});

test("all GraphQL error messages are joined", async () => {
  reply({ errors: [{ message: "first" }, { message: "second" }] });
  await assert.rejects(client().query("SELECT 1", { retry: false }), /first; second/);
});

test("a null nrql field gives a clear error", async () => {
  reply({ data: { actor: { account: { nrql: null } } } });
  await assert.rejects(client().query("SELECT 1", { retry: false }), /no result/);
});

test("a timeout gives the narrowing advice", async () => {
  reply({ errors: [{ message: "NRQL query timeout exceeded" }] });
  await assert.rejects(client().query("SELECT 1", { retry: false }), /The query timed out: narrow the window, add a WHERE clause or aggregate/);
});

test("an error that quotes a timeout attribute keeps its own message", async () => {
  reply({ errors: [{ message: "NRQL Syntax Error: Error at line 1 position 22, unexpected 'timeout'" }] });
  await assert.rejects(client().query("SELECT 1", { retry: false }), /unexpected 'timeout'/);
});

test("a query returns its results and metadata", async () => {
  reply({ data: { actor: { account: { nrql: { results: [{ a: 1 }], metadata: { timeWindow: { begin: 1, end: 2 }, messages: ["m"] } } } } } });
  const res = await client().query("SELECT 1", { retry: false });
  assert.deepEqual(res.data?.actor.account.nrql.metadata?.messages, ["m"]);
});
