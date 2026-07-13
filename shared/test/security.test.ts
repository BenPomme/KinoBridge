import { describe, expect, it } from "vitest";
import { assertSafeUpstream, redactUrl, sanitizeFilename } from "../src/security.js";

describe("shared security", () => {
  it("redacts signed URL query values", () => {
    expect(redactUrl("https://cdn.example/video.m3u8?token=secret&quality=hd")).toBe(
      "https://cdn.example/video.m3u8?token=%5BREDACTED%5D&quality=hd"
    );
  });

  it("allows only configured HTTPS origins", () => {
    expect(assertSafeUpstream("https://cdn.example/a.m3u8", new Set(["https://cdn.example"])).hostname).toBe("cdn.example");
    expect(() => assertSafeUpstream("http://cdn.example/a.m3u8", new Set(["https://cdn.example"]))).toThrow();
  });

  it("sanitizes download filenames", () => {
    expect(sanitizeFilename("../Season 1: Episode 2.mkv")).toBe("Season 1- Episode 2.mkv");
  });
});
