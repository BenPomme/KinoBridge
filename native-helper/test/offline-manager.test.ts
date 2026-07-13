import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownloadOptionsSchema, StreamDescriptorSchema } from "@kinobridge/shared";
import type { DownloadHandle, DownloadResult } from "../src/downloads.js";
import { KinoBridgeError } from "../src/errors.js";
import { OfflineManager } from "../src/offline-manager.js";
import { OfflineStore } from "../src/offline-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function descriptor(page = "https://zerkalo.xyz/item/view/12345/s0e1") {
  return StreamDescriptorSchema.parse({
    source: "kino.pub",
    candidate: {
      id: `candidate:${page}`,
      tabId: 1,
      navigationId: "nav",
      requestId: "request",
      url: "https://media.example.test/master.m3u8?token=fixture",
      pageUrl: page,
      pageTitle: "Movie Fixture",
      observedAt: Date.now(),
      access: { headers: [] }
    },
    classification: "master",
    masterUrl: "https://media.example.test/master.m3u8?token=fixture",
    variants: [{ uri: "https://media.example.test/video.m3u8?token=fixture", height: 1080, codecs: "avc1.640028" }],
    tracks: [
      { id: "audio-en", type: "audio", uri: "https://media.example.test/audio.m3u8?token=fixture", language: "en" },
      { id: "sub-fr", type: "subtitle", uri: "https://media.example.test/sub.m3u8?token=fixture", language: "fr" }
    ]
  });
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for offline manager state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferredHandle() {
  let resolve!: (value: DownloadResult) => void;
  let reject!: (error: unknown) => void;
  const completed = new Promise<DownloadResult>((yes, no) => { resolve = yes; reject = no; });
  const handle: DownloadHandle = {
    child: {} as ChildProcessWithoutNullStreams,
    completed,
    cancel: () => reject(new KinoBridgeError("CANCELED", "Download was canceled"))
  };
  return { handle, resolve, reject };
}

function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("OfflineManager", () => {
  it("runs a persistent FIFO queue one job at a time and adds validated results to the library", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-manager-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const handles = [deferredHandle(), deferredHandle()];
    let starts = 0;
    const manager = new OfflineManager(store, () => undefined, {
      createBroker: () => ({
        start: async () => "http://127.0.0.1:49000/cap/video.m3u8",
        expose: (url: string) => `http://127.0.0.1:49000/cap/${url.includes("audio") ? "audio" : "sub"}.m3u8`,
        refresh: () => undefined,
        close: async () => undefined
      }),
      probe: async (candidate) => StreamDescriptorSchema.parse({ ...descriptor(), candidate, classification: "video", variants: [], tracks: [], durationSeconds: 10 }),
      download: async (_resources, _descriptor, _options, onProgress) => {
        onProgress({ phase: "downloading", percent: 10, seconds: 1 });
        return handles[starts++]!.handle;
      }
    });
    const options = DownloadOptionsSchema.parse({ outputDirectory: root, filename: "Movie One", audioLanguages: ["en"], subtitleLanguages: ["fr"] });
    await manager.enqueue("one", descriptor(), options);
    await manager.enqueue("two", descriptor("https://zerkalo.xyz/item/view/54321/s0e1"), { ...options, filename: "Movie Two" });
    await waitFor(() => starts === 1);
    expect(manager.snapshot().queue.map((item) => item.state)).toEqual(["running", "queued"]);

    const firstPath = join(root, "Movie One.mkv");
    await writeFile(firstPath, "first");
    handles[0]!.resolve({ outputPath: firstPath, streams: 3, durationSeconds: 10, tracks: [{ type: "video", codec: "h264" }, { type: "audio", codec: "aac", language: "en" }] });
    await waitFor(() => starts === 2);
    expect(manager.snapshot().queue.map((item) => item.state)).toEqual(["completed", "running"]);

    const secondPath = join(root, "Movie Two.mkv");
    await writeFile(secondPath, "second");
    handles[1]!.resolve({ outputPath: secondPath, streams: 2, durationSeconds: 10, tracks: [{ type: "video", codec: "h264" }, { type: "audio", codec: "aac", language: "en" }] });
    await waitFor(() => manager.snapshot().library.length === 2);
    expect(manager.snapshot().queue.every((item) => item.state === "completed")).toBe(true);
    expect(manager.snapshot().library.map((entry) => entry.title)).toEqual(["Movie Fixture", "Movie Fixture"]);
  });

  it("requires retry access to come from the same Kino page", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-retry-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    await store.load();
    await store.enqueue("retry-me", { title: "Movie", pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1" }, { outputDirectory: root, filename: "Movie" });
    await store.updateJob("retry-me", { state: "interrupted" });
    const manager = new OfflineManager(store, () => undefined);
    await expect(manager.retry("retry-me", descriptor("https://zerkalo.xyz/item/view/99999/s0e1"))).rejects.toThrow(/different Kino title/i);
  });

  it("binds a live authorization refresh to the active job page before updating its broker", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-offline-live-refresh-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const deferred = deferredHandle();
    const brokerRefresh = vi.fn();
    const emit = vi.fn();
    let requestRefresh: (() => void) | undefined;
    const manager = new OfflineManager(store, emit, {
      createBroker: (_candidate, onAuthExpired) => {
        requestRefresh = onAuthExpired;
        return {
          start: async () => "http://127.0.0.1:49000/cap/video.m3u8",
          expose: (url: string) => `http://127.0.0.1:49000/cap/${url.includes("audio") ? "audio" : "sub"}.m3u8`,
          refresh: brokerRefresh,
          close: async () => undefined
        };
      },
      probe: async (candidate) => StreamDescriptorSchema.parse({ ...descriptor(), candidate, classification: "video", variants: [], tracks: [], durationSeconds: 10 }),
      download: async () => deferred.handle
    });
    const options = DownloadOptionsSchema.parse({ outputDirectory: root, filename: "Movie", audioLanguages: ["en"] });
    await manager.enqueue("live", descriptor(), options);
    await waitFor(() => manager.snapshot().queue[0]?.state === "running" && requestRefresh !== undefined);

    requestRefresh?.();
    expect(emit).toHaveBeenCalledWith("refreshRequired", expect.objectContaining({
      jobId: "live",
      tabId: 1,
      navigationId: "nav",
      pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1",
      pageTitle: "Movie Fixture",
      rootRole: "master"
    }), "live");

    const wrongPage = descriptor("https://zerkalo.xyz/item/view/99999/s0e1").candidate;
    expect(() => manager.refresh("live", wrongPage)).toThrow(/different Kino title/i);
    expect(brokerRefresh).not.toHaveBeenCalled();

    const samePage = { ...descriptor().candidate, id: "fresh", requestId: "fresh", pageTitle: "Updated display title" };
    manager.refresh("live", samePage);
    expect(brokerRefresh).toHaveBeenCalledWith(samePage);
    const outputPath = join(root, "Movie.mkv");
    await writeFile(outputPath, "complete");
    deferred.resolve({ outputPath, streams: 2, durationSeconds: 10, tracks: [{ type: "video", codec: "h264" }, { type: "audio", codec: "aac", language: "en" }] });
    await waitFor(() => manager.snapshot().queue[0]?.state === "completed");
  });

  it("cancels safely while playlist probes are still resolving", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-cancel-probe-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const probeGate = deferredValue<void>();
    const emit = vi.fn();
    const createBroker = vi.fn();
    const download = vi.fn();
    let probeCalls = 0;
    const manager = new OfflineManager(store, emit, {
      createBroker,
      probe: async (candidate) => {
        probeCalls += 1;
        await probeGate.promise;
        return StreamDescriptorSchema.parse({ ...descriptor(), candidate, classification: "video", variants: [], tracks: [], durationSeconds: 10 });
      },
      download
    });
    await manager.enqueue("cancel-probe", descriptor(), DownloadOptionsSchema.parse({
      outputDirectory: root,
      filename: "Cancel Probe",
      audioLanguages: ["en"],
      subtitleLanguages: ["fr"]
    }));
    await waitFor(() => manager.snapshot().queue[0]?.state === "running" && probeCalls > 0);
    await manager.cancel("cancel-probe");
    const emitsBeforeRelease = emit.mock.calls.length;
    probeGate.resolve();
    await waitFor(() => emit.mock.calls.length > emitsBeforeRelease);
    expect(manager.snapshot().queue[0]?.state).toBe("canceled");
    expect(manager.snapshot().library).toEqual([]);
    expect(createBroker).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([type]) => type === "completed")).toBe(false);
  });

  it("cancels safely while the broker is starting", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-cancel-broker-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const startGate = deferredValue<string>();
    const close = vi.fn(async () => undefined);
    const download = vi.fn();
    const emit = vi.fn();
    let startEntered = false;
    const manager = new OfflineManager(store, emit, {
      createBroker: () => ({
        start: async () => {
          startEntered = true;
          return startGate.promise;
        },
        expose: (url: string) => `http://127.0.0.1:49000/cap/${url.includes("audio") ? "audio" : "sub"}.m3u8`,
        refresh: () => undefined,
        close
      }),
      probe: async (candidate) => StreamDescriptorSchema.parse({ ...descriptor(), candidate, classification: "video", variants: [], tracks: [], durationSeconds: 10 }),
      download
    });
    await manager.enqueue("cancel-broker", descriptor(), DownloadOptionsSchema.parse({
      outputDirectory: root,
      filename: "Cancel Broker",
      audioLanguages: ["en"],
      subtitleLanguages: ["fr"]
    }));
    await waitFor(() => manager.snapshot().queue[0]?.state === "running" && startEntered);
    await manager.cancel("cancel-broker");
    startGate.resolve("http://127.0.0.1:49000/cap/video.m3u8");
    await waitFor(() => close.mock.calls.length === 1);
    expect(manager.snapshot().queue[0]?.state).toBe("canceled");
    expect(manager.snapshot().library).toEqual([]);
    expect(download).not.toHaveBeenCalled();
    expect(emit.mock.calls.some(([type]) => type === "completed")).toBe(false);
  });

  it("observes a late download handle rejection when canceled during handle creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "kinobridge-cancel-handle-"));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const handleGate = deferredValue<DownloadHandle>();
    const late = deferredHandle();
    const originalCancel = late.handle.cancel;
    late.handle.cancel = vi.fn(originalCancel);
    const close = vi.fn(async () => undefined);
    const emit = vi.fn();
    let downloadEntered = false;
    const manager = new OfflineManager(store, emit, {
      createBroker: () => ({
        start: async () => "http://127.0.0.1:49000/cap/video.m3u8",
        expose: (url: string) => `http://127.0.0.1:49000/cap/${url.includes("audio") ? "audio" : "sub"}.m3u8`,
        refresh: () => undefined,
        close
      }),
      probe: async (candidate) => StreamDescriptorSchema.parse({ ...descriptor(), candidate, classification: "video", variants: [], tracks: [], durationSeconds: 10 }),
      download: async () => {
        downloadEntered = true;
        return handleGate.promise;
      }
    });
    await manager.enqueue("cancel-handle", descriptor(), DownloadOptionsSchema.parse({
      outputDirectory: root,
      filename: "Cancel Handle",
      audioLanguages: ["en"],
      subtitleLanguages: ["fr"]
    }));
    await waitFor(() => manager.snapshot().queue[0]?.state === "running" && downloadEntered);
    await manager.cancel("cancel-handle");
    handleGate.resolve(late.handle);
    await waitFor(() => close.mock.calls.length === 1);
    expect(late.handle.cancel).toHaveBeenCalledOnce();
    expect(manager.snapshot().queue[0]?.state).toBe("canceled");
    expect(manager.snapshot().library).toEqual([]);
    expect(emit.mock.calls.some(([type]) => type === "completed")).toBe(false);
  });

  it.each(["audio", "sub"] as const)("rejects an encrypted selected %s playlist before FFmpeg starts", async (encryptedKind) => {
    const root = await mkdtemp(join(tmpdir(), `kinobridge-encrypted-${encryptedKind}-`));
    roots.push(root);
    const store = new OfflineStore(join(root, "state.json"));
    const probed: string[] = [];
    let downloads = 0;
    const manager = new OfflineManager(store, () => undefined, {
      createBroker: () => ({
        start: async () => "http://127.0.0.1:49000/cap/video.m3u8",
        expose: () => "http://127.0.0.1:49000/cap/resource.m3u8",
        refresh: () => undefined,
        close: async () => undefined
      }),
      probe: async (candidate) => {
        probed.push(candidate.url);
        return StreamDescriptorSchema.parse({
          ...descriptor(),
          candidate,
          classification: candidate.url.includes("audio") ? "audio" : candidate.url.includes("sub") ? "subtitle" : "video",
          variants: [],
          tracks: [],
          encrypted: candidate.url.includes(encryptedKind)
        });
      },
      download: async () => {
        downloads += 1;
        return deferredHandle().handle;
      }
    });
    await manager.enqueue(`encrypted-${encryptedKind}`, descriptor(), DownloadOptionsSchema.parse({
      outputDirectory: root,
      filename: "Encrypted",
      audioLanguages: ["en"],
      subtitleLanguages: ["fr"],
      embedSubtitles: true
    }));
    await waitFor(() => manager.snapshot().queue[0]?.state === "failed");
    expect(probed.some((url) => url.includes("video"))).toBe(true);
    expect(probed.some((url) => url.includes("audio"))).toBe(true);
    expect(probed.some((url) => url.includes("sub"))).toBe(true);
    expect(downloads).toBe(0);
    expect(manager.snapshot().queue[0]?.error).toMatch(/Encrypted or DRM-protected HLS/i);
  });
});
