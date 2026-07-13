import { describe, expect, it } from "vitest";
import { PlaybackOptionsSchema } from "@kinobridge/shared";
import { buildTopBottomToSbsFilter } from "../src/stereo.js";

describe("Top/Bottom to SBS filter", () => {
  it("builds a deterministic 3840x1080 left-first graph", () => {
    const options = PlaybackOptionsSchema.parse({ inputStereo: "half-tb", outputProfile: "xreal-sbs" });
    const filter = buildTopBottomToSbsFilter(options);
    expect(filter).toContain("crop=iw:ih/2:0:0");
    expect(filter).toContain("crop=iw:ih/2:0:ih/2");
    expect(filter).toContain("crop=1920:1080");
    expect(filter).toContain("[left][right]hstack=inputs=2");
  });

  it("gives alignment controls travel at zoom 1 and shifts the eyes symmetrically", () => {
    const options = PlaybackOptionsSchema.parse({
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs",
      verticalAlignment: 18
    });
    const filter = buildTopBottomToSbsFilter(options)!;
    expect(filter).toContain("max(ih\\,1080)+36");
    expect(filter).toContain("(ih-oh)/2+18");
    expect(filter).toContain("(ih-oh)/2+-18");
  });

  it("swaps eye labels for right-first input", () => {
    const options = PlaybackOptionsSchema.parse({ inputStereo: "full-tb", outputProfile: "xreal-sbs", eyeOrder: "right-first" });
    const filter = buildTopBottomToSbsFilter(options)!;
    expect(filter.indexOf("[right]")).toBeLessThan(filter.indexOf("[left]"));
  });

  it("does not filter ordinary 2D playback", () => {
    expect(buildTopBottomToSbsFilter(PlaybackOptionsSchema.parse({ inputStereo: "2d", outputProfile: "normal" }))).toBeUndefined();
  });
});
