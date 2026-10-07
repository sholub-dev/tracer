/**
 * Records the README demo of the Tracer web UI: a question typed into the
 * composer, then an investigation streaming in. Starts the built server on a
 * temporary TRACER_HOME, seeds it with scripts/seed-demo.mjs, fakes the chat
 * stream in the browser (no LLM key needed), records the page, and writes
 * docs/screenshots/demo-investigation.gif and .mp4. All temporary files and
 * the server process are removed when the script ends.
 *
 * Needs a built repo (pnpm build), Google Chrome and ffmpeg:
 *
 *   pnpm demo:record
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installFakeChat } from "./canned-stream.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const tmp = join(root, ".demo-tmp");
const outDir = join(root, "docs/screenshots");
const PORT = 3991;
const QUESTION = "Why did checkout latency spike in the last hour?";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
// The video starts at page creation; skip the load so the clip opens on the settled start screen.
const TRIM = process.env.DEMO_TRIM || "1.6";

const env = {
  ...process.env,
  TRACER_HOME: join(tmp, "home"),
  TRACER_DB_KEY: randomBytes(32).toString("hex"),
  TRACER_PORT: String(PORT),
  NODE_ENV: "production",
};

let server;
async function startServer() {
  server = spawn("node", ["--import", join(here, "fake-nr.mjs"), "packages/server/dist/index.js"], { cwd: root, env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start");
}
async function stopServer() {
  const proc = server;
  server = undefined;
  if (!proc || proc.exitCode !== null) return;
  const closed = new Promise((r) => proc.once("exit", r));
  proc.kill();
  await closed;
}
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error(`${cmd} failed`);
}

async function record() {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: join(tmp, "video"), size: { width: 1280, height: 800 } },
      timezoneId: "UTC",
      locale: "en-US",
    });
    const page = await ctx.newPage();
    await page.addInitScript(installFakeChat);
    await page.goto(`http://localhost:${PORT}/`);
    await page.getByText("New Relic connected").waitFor();
    await page.waitForTimeout(1500);
    await page.locator("textarea").click();
    await page.keyboard.type(QUESTION, { delay: 45 });
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    // The answer ends with the errors chart card, which only shows its query button once the query finished.
    await page.locator('section[aria-label="Analysis"]').getByLabel("Checkout errors per minute: show query").waitFor({ timeout: 60000 });
    await page.waitForTimeout(2200);
    const video = page.video();
    await ctx.close();
    await video.saveAs(join(tmp, "clip.webm"));
  } finally {
    await browser.close();
  }
}

try {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(join(tmp, "home"), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  await startServer(); // creates the schema
  await stopServer();
  run("node", ["scripts/seed-demo.mjs"]);
  await startServer(); // loads the seeded provider config

  await record();

  const clip = join(tmp, "clip.webm");
  const gif = join(outDir, "demo-investigation.gif");
  const mp4 = join(outDir, "demo-investigation.mp4");
  run(FFMPEG, ["-y", "-v", "error", "-ss", TRIM, "-i", clip, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-vf", "fps=30,scale=1280:-2:flags=lanczos", "-movflags", "+faststart", mp4]);
  const filters = "fps=15,scale=1000:-1:flags=lanczos";
  const palette = join(tmp, "palette.png");
  run(FFMPEG, ["-y", "-v", "error", "-ss", TRIM, "-i", clip, "-vf", `${filters},palettegen=stats_mode=diff`, palette]);
  run(FFMPEG, ["-y", "-v", "error", "-ss", TRIM, "-i", clip, "-i", palette, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`, "-loop", "0", gif]);
  console.log(`Wrote ${gif}\nWrote ${mp4}`);
} finally {
  await stopServer();
  rmSync(tmp, { recursive: true, force: true });
}
