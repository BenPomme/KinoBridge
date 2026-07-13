import { describe, expect, it } from "vitest";
import { automaticMovieDefaults } from "../src/defaults.js";

describe("automatic movie defaults", () => {
  it("applies the complete XREAL preset and title filename to a 3D movie", () => {
    expect(automaticMovieDefaults("Jumanji: The Next Level 3D")).toEqual({
      filename: "Jumanji: The Next Level 3D",
      outputDirectory: "~/Downloads",
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs",
      outputWidth: 3840,
      outputHeight: 1080,
      aspectCorrection: 1,
      horizontalAlignment: 0,
      verticalAlignment: -78,
      zoom: 1,
      codec: "h264-videotoolbox"
    });
  });

  it("does not force a 3D transcode for a normal movie", () => {
    expect(automaticMovieDefaults("Normal movie")).toEqual({ filename: "Normal movie", outputDirectory: "~/Downloads" });
  });
});
