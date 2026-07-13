import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildStereoAss } from "../src/stereo-subtitles.js";

const run = promisify(execFile);
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
const mpv = ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"].find(existsSync);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

function brightBounds(frame: Buffer, startX: number, endX: number): Bounds {
  const bounds: Bounds = { minX: endX, maxX: -1, minY: 360, maxY: -1, count: 0 };
  for (let y = 0; y < 360; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * 640 + x) * 3;
      if ((frame[offset] ?? 0) < 180 || (frame[offset + 1] ?? 0) < 180 || (frame[offset + 2] ?? 0) < 180) continue;
      bounds.minX = Math.min(bounds.minX, x - startX);
      bounds.maxX = Math.max(bounds.maxX, x - startX);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxY = Math.max(bounds.maxY, y);
      bounds.count += 1;
    }
  }
  return bounds;
}

describe.skipIf(!ffmpeg || !mpv)("rendered dual-eye subtitles", () => {
  it("renders one identical readable subtitle inside each eye and not across the seam", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-stereo-sub-render-"));
    roots.push(root);
    const source = `[Script Info]\nPlayResX: 384\nPlayResY: 288\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:02.50,Default,,0,0,0,,Readable in both eyes\n`;
    const subtitle = join(root, "stereo.ass");
    const movie = join(root, "stereo.mkv");
    const screenshots = join(root, "screens");
    const raw = join(root, "frame.rgb");
    await writeFile(subtitle, buildStereoAss(source, 640, 360));
    await run(ffmpeg!, [
      "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=640x360:r=1:d=3", "-i", subtitle,
      "-map", "0:v:0", "-map", "1:s:0", "-c:v", "ffv1", "-c:s", "ass", movie
    ]);
    await run(mpv!, [
      "--no-config", "--really-quiet", "--audio=no", "--sub-auto=no", "--sid=1", "--start=1", "--frames=1",
      "--vo=image", "--vo-image-format=png", `--vo-image-outdir=${screenshots}`, movie
    ]);
    const screenshot = join(screenshots, (await readdir(screenshots))[0]!);
    await run(ffmpeg!, ["-v", "error", "-i", screenshot, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw]);
    const frame = await readFile(raw);
    const left = brightBounds(frame, 0, 320);
    const right = brightBounds(frame, 320, 640);
    expect(left.count).toBeGreaterThan(50);
    expect(right).toEqual(left);
    expect(brightBounds(frame, 316, 324).count).toBe(0);
  });
});
