import { describe, expect, it } from "vitest";
import { buildStereoAss } from "../src/stereo-subtitles.js";

const source = `[Script Info]
PlayResX: 384
PlayResY: 288

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,A long subtitle, with a comma and {\\pos(5000,0)}unsafe override
`;

describe("stereo subtitle preparation", () => {
  it("duplicates each cue inside both 1920-pixel eye regions", () => {
    const result = buildStereoAss(source, 3840, 1080);
    expect(result).toContain("PlayResX: 3840");
    expect(result).toContain("PlayResY: 1080");
    expect(result).toContain("Style: LeftEye,Arial,49");
    expect(result).toContain(",2,120,2040,70,1");
    expect(result).toContain("Style: RightEye,Arial,49");
    expect(result).toContain(",2,2040,120,70,1");
    expect(result.match(/^Dialogue:/gm)).toHaveLength(2);
    expect(result).toContain("{\\clip(0,0,1920,1080)}A long subtitle, with a comma and unsafe override");
    expect(result).toContain("{\\clip(1920,0,3840,1080)}A long subtitle, with a comma and unsafe override");
    expect(result).not.toContain("pos(5000");
  });

  it("rejects malformed display geometry and empty tracks", () => {
    expect(() => buildStereoAss(source, 3839, 1080)).toThrow(/even display width/i);
    expect(() => buildStereoAss("[Events]\n", 3840, 1080)).toThrow(/no readable cues/i);
  });
});
