import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OfflineStore } from "../src/offline-store.js";

const roots: string[] = [];
const source = { title: "Fixture", pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1" };
const options = { outputDirectory: "~/Downloads", filename: "Fixture", container: "mkv" as const };

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; path: string; store: OfflineStore }> {
  const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-store-"));
  roots.push(root);
  const path = join(root, "offline.json");
  const store = new OfflineStore(path);
  await store.load();
  return { root, path, store };
}

describe("OfflineStore", () => {
  it("persists only safe queue metadata and marks unfinished jobs interrupted after restart", async () => {
    const { path, store } = await fixture();
    await store.enqueue("job-1", source, options);
    await store.updateJob("job-1", { state: "running", progress: { percent: 12 } });
    const raw = await readFile(path, "utf8");
    expect(raw).not.toMatch(/cookie|authorization|\.m3u8|token=/i);
    const restarted = new OfflineStore(path);
    expect((await restarted.load()).queue[0]).toMatchObject({ id: "job-1", state: "interrupted" });
  });

  it("retries interrupted jobs and preserves FIFO order", async () => {
    const { path, store } = await fixture();
    await store.enqueue("one", source, options);
    await store.enqueue("two", { ...source, title: "Second" }, { ...options, filename: "Second" });
    await store.updateJob("one", { state: "failed", error: "network" });
    await store.retry("one");
    expect(store.nextQueued()?.id).toBe("one");
    expect(JSON.parse(await readFile(path, "utf8")).queue).toHaveLength(2);
  });

  it("maintains a library and deletes only the exact registered regular media file", async () => {
    const { root, store } = await fixture();
    const media = join(root, "Fixture.mkv");
    await writeFile(media, "media");
    await store.addLibraryEntry({
      id: "library-1", title: "Fixture", sourcePageUrl: source.pageUrl, outputPath: media,
      sizeBytes: 5, durationSeconds: 10, tracks: [{ type: "video", codec: "h264", width: 1920, height: 1080 }], createdAt: Date.now()
    });
    expect(store.snapshot().library).toHaveLength(1);
    await store.deleteLibraryFile("library-1");
    expect(store.snapshot().library).toHaveLength(0);
    await expect(readFile(media)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects signed or non-Kino source identities", async () => {
    const { store } = await fixture();
    await expect(store.enqueue("bad", { title: "Bad", pageUrl: "https://cdn.example/movie?token=secret" }, options)).rejects.toThrow(/credential-free Kino/i);
  });

  it("quarantines corrupted state and starts with an empty safe snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-corrupt-"));
    roots.push(root);
    const path = join(root, "offline.json");
    await writeFile(path, "{not-json");
    const store = new OfflineStore(path);
    expect(await store.load()).toEqual({ queue: [], library: [] });
  });
});
