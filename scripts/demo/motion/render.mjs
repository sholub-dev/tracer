/**
 * Renders the README motion intro. Loads scene.html in headless Chrome with the
 * built web stylesheet injected (so the UI is the real one), calls
 * window.render(t) for every frame at 60 fps, screenshots each frame and
 * encodes docs/screenshots/motion-intro.mp4 (60 fps) and .gif (24 fps).
 * With --sheet it also writes .demo-tmp/motion-sheet.png, a 4x4 contact sheet
 * for reviewing the clip. Frames are removed when the script ends.
 *
 * Needs a built web app (pnpm build), Google Chrome and ffmpeg:
 *
 *   pnpm demo:motion [--sheet]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const tmp = join(root, ".demo-tmp");
const frames = join(tmp, "motion-frames");
const outDir = join(root, "docs/screenshots");
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FPS = 60;
const DURATION = 15.9;
const COUNT = Math.round(FPS * DURATION); // frame COUNT would equal frame 0, so the loop is seamless
const frame = (i) => join(frames, `${String(i).padStart(4, "0")}.png`);

// The scene uses the real app styles, so it is written next to the frames with the stylesheet inlined.
function sceneFile() {
  const assets = join(root, "packages/web/dist/assets");
  const css = readdirSync(assets).find((f) => /^index-.*\.css$/.test(f));
  if (!css) throw new Error("Web build not found. Run pnpm build first.");
  const file = join(tmp, "scene.html");
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scene = readFileSync(join(here, "scene.html"), "utf8").replace("<!--version-->", version);
  writeFileSync(file, scene.replace("<!--css-->", `<style>${readFileSync(join(assets, css), "utf8")}</style>`));
  return file;
}

function run(args) {
  const r = spawnSync(FFMPEG, ["-y", "-v", "error", ...args], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) throw new Error("ffmpeg failed");
}

async function capture(sheet) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(sceneFile()).href);
    await page.evaluate(() => window.ready);
    for (let i = 0; i < COUNT; i++) {
      await page.evaluate((t) => window.render(t), i / FPS);
      await page.screenshot({ path: frame(i) });
    }
    if (!sheet) return;
    const picks = Array.from({ length: 16 }, (_, k) => Math.round((k * COUNT) / 16));
    const tiles = picks.map((i) => `<figure><img src="${pathToFileURL(frame(i)).href}"><figcaption>${(i / FPS).toFixed(2)} s</figcaption></figure>`);
    const html = join(tmp, "sheet.html");
    writeFileSync(html, `<style>body{margin:0;display:grid;grid-template-columns:repeat(4,480px);gap:6px;background:#222;font:14px sans-serif;color:#fff}figure{margin:0}img{width:480px;display:block}figcaption{padding:2px 6px}</style>${tiles.join("")}`);
    const sheetPage = await browser.newPage({ viewport: { width: 1938, height: 1300 } });
    await sheetPage.goto(pathToFileURL(html).href);
    await sheetPage.screenshot({ path: join(tmp, "motion-sheet.png"), fullPage: true });
  } finally {
    await browser.close();
  }
}

const sheet = process.argv.includes("--sheet");
try {
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  await capture(sheet);

  const input = ["-framerate", String(FPS), "-i", join(frames, "%04d.png")];
  const mp4 = join(outDir, "motion-intro.mp4");
  run([...input, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", mp4]);
  const filters = "fps=24,scale=900:-1:flags=lanczos";
  const palette = join(tmp, "palette.png");
  run([...input, "-vf", `${filters},palettegen=max_colors=128:stats_mode=diff`, palette]);
  const gif = join(outDir, "motion-intro.gif");
  run([...input, "-i", palette, "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", gif]);
  console.log(`Wrote ${gif}\nWrote ${mp4}`);
} finally {
  rmSync(frames, { recursive: true, force: true });
  rmSync(join(tmp, "palette.png"), { force: true });
  rmSync(join(tmp, "sheet.html"), { force: true });
  if (!sheet) rmSync(tmp, { recursive: true, force: true });
}
