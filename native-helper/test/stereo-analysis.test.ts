import { describe, expect, it } from "vitest";
import { analyzeTopBottomGeometry, deriveStereoAnalysis, parseStereoCropLog, stereoSampleOffsets } from "../src/stereo-analysis.js";

describe("automatic Top/Bottom geometry analysis", () => {
  it.each([
    { name: "no gap", top: { y: 0, height: 160 }, bottom: { y: 0, height: 160 }, expected: 0 },
    { name: "central gap", top: { y: 0, height: 128 }, bottom: { y: 32, height: 128 }, expected: -108 },
    { name: "outer letterbox", top: { y: 32, height: 128 }, bottom: { y: 0, height: 128 }, expected: 108 },
    { name: "unequal borders", top: { y: 10, height: 132 }, bottom: { y: 18, height: 128 }, expected: -20 }
  ])("derives a source-specific correction for $name", ({ top, bottom, expected }) => {
    expect(deriveStereoAnalysis([{ top, bottom }], 1080).verticalAlignment).toBe(expected);
  });

  it("uses the median of several scenes instead of one outlier", () => {
    expect(deriveStereoAnalysis([
      { top: { y: 0, height: 128 }, bottom: { y: 32, height: 128 } },
      { top: { y: 0, height: 128 }, bottom: { y: 32, height: 128 } },
      { top: { y: 0, height: 160 }, bottom: { y: 0, height: 160 } }
    ], 1080).verticalAlignment).toBe(-108);
  });

  it("preserves the whole half when packing borders vary across scenes", () => {
    const samples = [0, 8, 16, 24, 32].map((y) => ({
      top: { y, height: 128 },
      bottom: { y, height: 128 }
    }));
    expect(deriveStereoAnalysis(samples, 1080)).toMatchObject({
      verticalAlignment: 0,
      top: { y: 0, height: 160 },
      bottom: { y: 0, height: 160 }
    });
  });

  it("parses only the latest valid crop for both named eyes", () => {
    const log = [
      "[cropdetect@top @ 0x1] crop=320:100:0:4",
      "[cropdetect@bottom @ 0x2] crop=320:98:0:24",
      "[cropdetect@top @ 0x1] crop=320:128:0:0",
      "[cropdetect@bottom @ 0x2] crop=320:128:0:32"
    ].join("\n");
    expect(parseStereoCropLog(log)).toEqual({
      top: { y: 0, height: 128 },
      bottom: { y: 32, height: 128 }
    });
  });

  it("rejects missing eyes or incompatible active heights", () => {
    expect(parseStereoCropLog("[cropdetect@top @ 0x1] crop=320:128:0:0")).toBeUndefined();
    expect(() => deriveStereoAnalysis([{
      top: { y: 0, height: 150 }, bottom: { y: 40, height: 80 }
    }], 1080)).toThrow(/incompatible active geometry/i);
  });

  it("samples multiple interior scenes for normal movies", () => {
    expect(stereoSampleOffsets(undefined)).toEqual([0]);
    expect(stereoSampleOffsets(60)).toEqual([6, 18, 30, 42, 54]);
    expect(stereoSampleOffsets(7_200)).toEqual([60, 2_016, 3_600, 5_184, 7_080]);
  });

  it("never analyzes a direct file or upstream URL", async () => {
    await expect(analyzeTopBottomGeometry("/opt/homebrew/bin/ffmpeg", "https://media.example/movie.m3u8", 60, 1080))
      .rejects.toThrow(/loopback access broker/i);
  });
});
