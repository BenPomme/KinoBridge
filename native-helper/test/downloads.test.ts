import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DownloadOptionsSchema, StreamDescriptorSchema } from "@kinobridge/shared";
import { buildFfmpegArguments, resolveOutputPaths } from "../src/downloads.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function descriptor() {
  return StreamDescriptorSchema.parse({
    source: "kino.pub",
    candidate: {
      id: "candidate",
      tabId: 1,
      navigationId: "nav",
      requestId: "request",
      url: "https://cdn.example/master.m3u8?token=secret",
      pageUrl: "https://kino.pub/item/1",
      pageTitle: "Fixture",
      observedAt: 1,
      access: { headers: [] }
    },
    classification: "master"
  });
}

describe("download planning", () => {
  it("uses collision-safe sanitized filenames inside the selected directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kinobridge-download-test-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "Season 1-Episode 1.mkv"), "existing");
    const options = DownloadOptionsSchema.parse({ outputDirectory: directory, filename: "../Season 1:Episode 1", container: "mkv" });
    const paths = await resolveOutputPaths(options);
    expect(paths.final).toBe(join(directory, "Season 1-Episode 1 (2).mkv"));
    expect(paths.temporary.startsWith(`${directory}/.`)).toBe(true);
  });

  it("keeps the signed upstream URL out of the FFmpeg argument array", () => {
    const options = DownloadOptionsSchema.parse({ outputDirectory: "/tmp", filename: "Fixture", container: "mkv", codec: "copy" });
    const args = buildFfmpegArguments("http://127.0.0.1:49152/capability/master", descriptor(), options, "/tmp/.Fixture.part.mkv");
    expect(args).toContain("http://127.0.0.1:49152/capability/master");
    expect(args.join(" ")).not.toContain("token=secret");
    expect(args).toContain("copy");
  });

  it("requires transcoding for SBS output", () => {
    const options = DownloadOptionsSchema.parse({
      outputDirectory: "/tmp",
      filename: "Fixture",
      codec: "copy",
      inputStereo: "half-tb",
      outputProfile: "xreal-sbs"
    });
    expect(() => buildFfmpegArguments("http://127.0.0.1/stream", descriptor(), options, "/tmp/output.mkv")).toThrow(/requires H\.264 or HEVC/i);
  });
});
