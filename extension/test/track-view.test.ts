import { describe, expect, it } from "vitest";
import { MediaTrackSchema } from "@kinobridge/shared";
import { projectTrack } from "../src/track-view.js";

describe("popup track projection", () => {
  it("exposes exact rendition identity without URI or access data", () => {
    const view = projectTrack(MediaTrackSchema.parse({
      id: "audio:Original",
      type: "audio",
      name: "Original",
      language: "eng",
      uri: "https://cdn.example/audio.m3u8?token=secret",
      default: false,
      autoselect: true
    }));
    expect(view).toEqual({
      id: "audio:Original",
      type: "audio",
      name: "Original",
      language: "eng",
      default: false,
      autoselect: true,
      forced: false
    });
    expect(JSON.stringify(view)).not.toMatch(/https:|token|secret|uri/i);
  });
});
