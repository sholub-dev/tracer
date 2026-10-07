// Preloaded into the demo server (node --import). Answers api.newrelic.com/graphql
// with canned NerdGraph results so the seeded New Relic provider reads as connected.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (!url.startsWith("https://api.newrelic.com/graphql")) return real(input, init);
  const body = JSON.parse(init?.body ?? "{}");
  const nrql = body.variables?.nrql ?? "";
  let data;
  if ((body.query ?? "").includes("aiIssues")) {
    data = { actor: { account: { aiIssues: { issues: { nextCursor: null, issues: [] } } } } };
  } else {
    const now = Math.floor(Date.now() / 1000);
    const results = /TIMESERIES/i.test(nrql)
      ? Array.from({ length: 18 }, (_, i) => ({ beginTimeSeconds: now - (18 - i) * 300, endTimeSeconds: now - (17 - i) * 300, count: 3 + ((i * 7) % 5) }))
      : [{ count: 4 }];
    data = { actor: { account: { nrql: { results } } } };
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
};
