import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PlaybackOptionsSchema } from "@kinobridge/shared";
import { deriveStereoAnalysis, type StereoCropSample } from "../src/stereo-analysis.js";
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

async function renderFixture(
  source: string,
  sample: StereoCropSample,
  overrides: Record<string, unknown> = {}
): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "kinobridge-stereo-pixels-"));
  roots.push(root);
  const output = join(root, "frame.rgb");
  const geometry = deriveStereoAnalysis([sample], 360);
  const filter = buildTopBottomToSbsFilter(PlaybackOptionsSchema.parse({
    inputStereo: "half-tb",
    outputProfile: "xreal-sbs",
    outputWidth: 640,
    outputHeight: 360,
    ...overrides
  }), geometry)!;
  await run(ffmpeg!, [
    "-v", "error", "-f", "lavfi", "-i", source,
    "-vf", filter, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", output
  ]);
  return readFile(output);
}

function center(rows: number[]): number {
  return (rows[0]! + rows.at(-1)!) / 2;
}

function activeBounds(frame: Buffer, channel: 0 | 2): { width: number; height: number } {
  let minX = 640;
  let maxX = -1;
  let minY = 360;
  let maxY = -1;
  for (let y = 0; y < 360; y += 1) {
    for (let x = 0; x < 640; x += 1) {
      if ((frame[(y * 640 + x) * 3 + channel] ?? 0) <= 180) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { width: maxX - minX + 1, height: maxY - minY + 1 };
}

describe.skipIf(!ffmpeg)("stereo filter pixel output", () => {
  it.each([
    {
      name: "no packing gap",
      source: "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=100:color=red:t=fill,drawbox=x=0:y=100:w=320:h=100:color=blue:t=fill",
      sample: { top: { y: 0, height: 160 }, bottom: { y: 0, height: 160 } }
    },
    {
      name: "central packing gap",
      source: "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=80:color=red:t=fill,drawbox=x=0:y=120:w=320:h=80:color=blue:t=fill",
      sample: { top: { y: 0, height: 128 }, bottom: { y: 32, height: 128 } }
    },
    {
      name: "outer letterbox",
      source: "color=c=black:s=320x200,drawbox=x=0:y=20:w=320:h=80:color=red:t=fill,drawbox=x=0:y=100:w=320:h=80:color=blue:t=fill",
      sample: { top: { y: 32, height: 128 }, bottom: { y: 0, height: 128 } }
    }
  ])("aligns both eye images for $name", async ({ source, sample }) => {
    const frame = await renderFixture(source, sample);
    expect(frame).toHaveLength(640 * 360 * 3);
    const left = activeRows(frame, 640, 360, 160, 0);
    const right = activeRows(frame, 640, 360, 480, 2);
    expect(Math.abs(left[0]! - right[0]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(left.at(-1)! - right.at(-1)!)).toBeLessThanOrEqual(1);
    expect(left[0]).toBeGreaterThan(0);
    expect(left.at(-1)).toBeLessThan(359);
  });

  it("swaps the rendered eye order without changing geometry", async () => {
    const source = "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=100:color=red:t=fill,drawbox=x=0:y=100:w=320:h=100:color=blue:t=fill";
    const sample = { top: { y: 0, height: 160 }, bottom: { y: 0, height: 160 } };
    const frame = await renderFixture(source, sample, { eyeOrder: "right-first" });
    expect(activeRows(frame, 640, 360, 160, 2).length).toBeGreaterThan(0);
    expect(activeRows(frame, 640, 360, 480, 0).length).toBeGreaterThan(0);
    expect(activeRows(frame, 640, 360, 160, 0)).toHaveLength(0);
  });

  it("adds the manual alignment after automatic geometry normalization", async () => {
    const frame = await renderFixture(
      "color=c=black:s=320x200,drawbox=x=0:y=0:w=320:h=80:color=red:t=fill,drawbox=x=0:y=120:w=320:h=80:color=blue:t=fill",
      { top: { y: 0, height: 128 }, bottom: { y: 32, height: 128 } },
      { verticalAlignment: 18 }
    );
    const left = activeRows(frame, 640, 360, 160, 0);
    const right = activeRows(frame, 640, 360, 480, 2);
    expect(Math.abs(Math.abs(center(left) - center(right)) - 36)).toBeLessThanOrEqual(2);
  });

  it("restores Half-TB vertical resolution without stretching geometry", async () => {
    const frame = await renderFixture(
      "color=c=black:s=320x200,drawbox=x=100:y=20:w=120:h=60:color=red:t=fill,drawbox=x=100:y=120:w=120:h=60:color=blue:t=fill",
      { top: { y: 0, height: 160 }, bottom: { y: 0, height: 160 } }
    );
    const red = activeBounds(frame, 0);
    expect(Math.abs(red.width - red.height)).toBeLessThanOrEqual(2);
  });
});
