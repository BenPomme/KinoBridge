import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PlaybackOptionsSchema } from "@kinobridge/shared";
import { buildTopBottomToSbsFilter } from "../src/stereo.js";

const run = promisify(execFile);
const ffmpeg = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(existsSync);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function activeRows(frame: Buffer, width: number, height: number, x: number, channel: 0 | 2): number[] {
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    const offset = (y * width + x) * 3;
    if ((frame[offset + channel] ?? 0) > 180) rows.push(y);
  }
  return rows;
}

describe.skipIf(!ffmpeg)("stereo filter pixel output", () => {
  it("aligns both eye images to the same vertical rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-stereo-pixels-"));
    roots.push(root);
    const output = join(root, "frame.rgb");
    const filter = buildTopBottomToSbsFilter(PlaybackOptionsSchema.parse({
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs",
      outputWidth: 640,
      outputHeight: 360,
      verticalAlignment: -36
    }))!;
    await run(ffmpeg!, [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=80:color=red:t=fill,drawbox=x=0:y=120:w=320:h=80:color=blue:t=fill",
      "-vf", filter,
      "-frames:v", "1",
      "-pix_fmt", "rgb24",
      "-f", "rawvideo",
      output
    ]);
    const frame = await readFile(output);
    expect(frame).toHaveLength(640 * 360 * 3);
    const left = activeRows(frame, 640, 360, 160, 0);
    const right = activeRows(frame, 640, 360, 480, 2);
    expect(Math.abs(left[0]! - right[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.at(-1)! - right.at(-1)!)).toBeLessThanOrEqual(1);
    expect(left[0]).toBeGreaterThan(0);
    expect(left.at(-1)).toBeLessThan(359);
  });
});
