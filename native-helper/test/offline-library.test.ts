import { describe, expect, it } from "vitest";
import { localPlayerArguments } from "../src/offline-library.js";

describe("offline library player arguments", () => {
  it("passes local paths as argument-array values without shell parsing", () => {
    const path = "/tmp/Movie; $(touch never).mkv";
    expect(localPlayerArguments("mpv", path)).toEqual(["--force-window=yes", "--", path]);
    expect(localPlayerArguments("vlc", path)).toEqual(["--", path]);
    expect(localPlayerArguments("iina", path)).toEqual([path]);
  });
});
