import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  StreamDescriptorSchema,
  sanitizeFilename,
  type DownloadOptions,
  type OfflineQueueItem,
  type OfflineSnapshot,
  type StreamCandidate,
  type StreamDescriptor
} from "@kinobridge/shared";
import { AccessBroker } from "./broker.js";
import { startDownload, type DownloadHandle, type DownloadProgress, type DownloadResources } from "./downloads.js";
import { KinoBridgeError, safeError } from "./errors.js";
import { probeCandidate } from "./hls.js";
import { selectPlaybackResources } from "./media-selection.js";
import { OfflineStore } from "./offline-store.js";

type OfflineEmit = (type: "progress" | "completed" | "failed" | "refreshRequired" | "offlineState", payload: unknown, id?: string) => void;

interface BrokerLike {
  start(entryUrl?: string): Promise<string>;
  expose(upstreamUrl: string): string;
  refresh(candidate: StreamCandidate): void;
  close(): Promise<void>;
}

interface OfflineDependencies {
  createBroker(candidate: StreamCandidate, onAuthExpired: () => void, playlistUrls: readonly string[]): BrokerLike;
  probe(candidate: StreamCandidate): Promise<StreamDescriptor>;
  download(resources: DownloadResources, descriptor: StreamDescriptor, options: DownloadOptions, onProgress: (progress: DownloadProgress) => void): Promise<DownloadHandle>;
}

interface ActiveDownload {
  id: string;
  broker?: BrokerLike;
  handle?: DownloadHandle;
  aborted?: "canceled" | "interrupted";
}

const defaultDependencies: OfflineDependencies = {
  createBroker: (candidate, onAuthExpired, playlistUrls) => new AccessBroker(candidate, onAuthExpired, playlistUrls),
  probe: probeCandidate,
  download: startDownload
};

function cleanPageUrl(raw: string): string {
  const url = new URL(raw);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function samePage(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
}

function inferredQuality(descriptor: StreamDescriptor): string {
  const height = descriptor.variants.length === 1 ? descriptor.variants[0]?.height : undefined;
  return height ? `${height}p` : "auto";
}

export class OfflineManager {
  private readonly descriptors = new Map<string, StreamDescriptor>();
  private active: ActiveDownload | undefined;
  private pumping = false;
  private initialized = false;
  private lastProgressWrite = 0;

  constructor(private readonly store: OfflineStore, private readonly emit: OfflineEmit, private readonly dependencies: OfflineDependencies = defaultDependencies) {}

  async initialize(): Promise<OfflineSnapshot> {
    if (!this.initialized) {
      const snapshot = await this.store.load();
      this.initialized = true;
      await Promise.all(snapshot.queue.filter((item) => item.state === "interrupted").map((item) => this.cleanupPartials(item)));
    }
    return this.store.snapshot();
  }

  snapshot(): OfflineSnapshot { return this.store.snapshot(); }
  has(id: string): boolean { return this.store.getJob(id) !== undefined; }

  async enqueue(id: string, descriptor: StreamDescriptor, options: DownloadOptions): Promise<OfflineSnapshot> {
    await this.initialize();
    this.assertUsableDescriptor(descriptor);
    await this.store.enqueue(id, {
      title: descriptor.candidate.pageTitle,
      pageUrl: cleanPageUrl(descriptor.candidate.pageUrl)
    }, options, inferredQuality(descriptor));
    this.descriptors.set(id, descriptor);
    this.emitSnapshot(id);
    void this.pump();
    return this.snapshot();
  }

  async retry(id: string, descriptor: StreamDescriptor): Promise<OfflineSnapshot> {
    await this.initialize();
    const job = this.store.getJob(id);
    if (!job) throw new KinoBridgeError("JOB_NOT_FOUND", "Offline job was not found");
    this.assertUsableDescriptor(descriptor);
    if (!samePage(job.source.pageUrl, descriptor.candidate.pageUrl)) throw new KinoBridgeError("WRONG_OFFLINE_SOURCE", "Fresh stream access belongs to a different Kino title");
    await this.store.retry(id);
    this.descriptors.set(id, descriptor);
    this.emitSnapshot(id);
    void this.pump();
    return this.snapshot();
  }

  async cancel(id: string): Promise<OfflineSnapshot> {
    await this.initialize();
    const job = this.store.getJob(id);
    if (!job) throw new KinoBridgeError("JOB_NOT_FOUND", "Offline job was not found");
    if (this.active?.id === id) {
      this.active.aborted = "canceled";
      this.active.handle?.cancel();
    }
    this.descriptors.delete(id);
    await this.store.updateJob(id, { state: "canceled", error: undefined });
    this.emitSnapshot(id);
    return this.snapshot();
  }

  async remove(id: string): Promise<OfflineSnapshot> {
    await this.initialize();
    await this.store.removeJob(id);
    this.descriptors.delete(id);
    this.emitSnapshot(id);
    return this.snapshot();
  }

  refresh(id: string, candidate: StreamCandidate): OfflineSnapshot {
    if (this.active?.id !== id || !this.active.broker || this.active.aborted) {
      throw new KinoBridgeError("JOB_NOT_RUNNING", "Offline job is not actively downloading");
    }
    const job = this.store.getJob(id);
    if (!job || !samePage(job.source.pageUrl, candidate.pageUrl)) {
      throw new KinoBridgeError("WRONG_OFFLINE_SOURCE", "Fresh stream access belongs to a different Kino title");
    }
    this.active.broker.refresh(candidate);
    return this.snapshot();
  }

  async interruptActive(): Promise<void> {
    if (!this.active) return;
    const id = this.active.id;
    this.active.aborted = "interrupted";
    this.active.handle?.cancel();
    await this.store.updateJob(id, { state: "interrupted", error: "Native helper stopped; capture a fresh authorized stream to restart" });
    this.emitSnapshot(id);
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.active) return;
    this.pumping = true;
    try {
      while (!this.active) {
        const job = this.store.nextQueued();
        if (!job) return;
        const descriptor = this.descriptors.get(job.id);
        if (!descriptor) {
          await this.store.updateJob(job.id, { state: "interrupted", error: "Open this Kino title and retry with fresh stream access" });
          this.emitSnapshot(job.id);
          continue;
        }
        await this.run(job, descriptor);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: OfflineQueueItem, rawDescriptor: StreamDescriptor): Promise<void> {
    await this.store.updateJob(job.id, { state: "running", error: undefined, progress: { percent: 0, seconds: 0 } });
    const operation: ActiveDownload = { id: job.id };
    this.active = operation;
    const persisted = this.store.getJob(job.id);
    if (persisted?.state === "canceled" || persisted?.state === "interrupted") operation.aborted = persisted.state;
    this.emitSnapshot(job.id);
    let broker: BrokerLike | undefined;
    let materializedOutputPath: string | undefined;
    try {
      this.assertNotAborted(operation);
      const descriptor = await this.hydrateDescriptor(rawDescriptor, job.options);
      this.assertNotAborted(operation);
      const selected = selectPlaybackResources(descriptor, job.options);
      broker = this.dependencies.createBroker(
        descriptor.candidate,
        () => this.emit("refreshRequired", {
          jobId: job.id,
          candidateId: descriptor.candidate.id,
          tabId: descriptor.candidate.tabId,
          navigationId: descriptor.candidate.navigationId,
          pageUrl: descriptor.candidate.pageUrl,
          pageTitle: descriptor.candidate.pageTitle,
          rootRole: descriptor.classification
        }, job.id),
        [
          ...(descriptor.masterUrl ? [descriptor.masterUrl] : []),
          ...descriptor.variants.map((variant) => variant.uri),
          ...descriptor.tracks.flatMap((track) => track.uri ? [track.uri] : [])
        ]
      );
      operation.broker = broker;
      this.assertNotAborted(operation);
      const videoUrl = await broker.start(selected.videoUrl);
      this.assertNotAborted(operation);
      const handle = await this.dependencies.download({
        videoUrl,
        ...(selected.audioTrack?.uri ? { audio: { url: broker.expose(selected.audioTrack.uri), track: selected.audioTrack } } : {}),
        ...(job.options.embedSubtitles && selected.subtitleTrack?.uri ? { subtitle: { url: broker.expose(selected.subtitleTrack.uri), track: selected.subtitleTrack } } : {})
      }, descriptor, job.options, (progress) => this.onProgress(job.id, progress));
      operation.handle = handle;
      if (operation.aborted) {
        // Observe the completion rejection before canceling. Otherwise a
        // handle that arrives after a setup-time Cancel can reject without an
        // awaiter and trigger the helper's unhandled-rejection fail-safe.
        const settled = handle.completed.catch(() => undefined);
        handle.cancel();
        await settled;
      }
      this.assertNotAborted(operation);
      const result = await handle.completed;
      materializedOutputPath = result.outputPath;
      this.assertNotAborted(operation);
      const metadata = await stat(result.outputPath);
      this.assertNotAborted(operation);
      await this.store.addLibraryEntry({
        id: job.id,
        title: job.source.title,
        sourcePageUrl: job.source.pageUrl,
        outputPath: result.outputPath,
        sizeBytes: metadata.size,
        ...(result.durationSeconds === undefined ? {} : { durationSeconds: result.durationSeconds }),
        tracks: result.tracks,
        createdAt: Date.now()
      });
      if (operation.aborted) {
        await this.store.removeLibraryEntry(job.id);
        this.assertNotAborted(operation);
      }
      await this.store.updateJob(job.id, { state: "completed", progress: { percent: 100, ...(result.durationSeconds === undefined ? {} : { seconds: result.durationSeconds }) }, outputPath: result.outputPath, error: undefined });
      if (operation.aborted) {
        await this.store.removeLibraryEntry(job.id);
        this.assertNotAborted(operation);
      }
      this.emit("completed", { jobId: job.id, result, offline: this.snapshot() }, job.id);
    } catch (error) {
      const current = this.store.getJob(job.id);
      if (current?.state !== "canceled" && current?.state !== "interrupted") {
        const sanitized = safeError(error);
        await this.store.updateJob(job.id, { state: "failed", error: sanitized.message });
        this.emit("failed", { jobId: job.id, error: sanitized, offline: this.snapshot() }, job.id);
      }
    } finally {
      this.descriptors.delete(job.id);
      if (this.active === operation) this.active = undefined;
      if (operation.aborted) {
        await this.store.removeLibraryEntry(job.id);
        if (materializedOutputPath) await rm(materializedOutputPath, { force: true });
      }
      await broker?.close();
      this.emitSnapshot(job.id);
      queueMicrotask(() => { void this.pump(); });
    }
  }

  private onProgress(id: string, progress: DownloadProgress): void {
    if (this.active?.id !== id || this.active.aborted) return;
    const now = Date.now();
    const shouldPersist = progress.phase === "validating" || now - this.lastProgressWrite >= 1_000;
    if (!shouldPersist) return;
    this.lastProgressWrite = now;
    void this.store.updateJob(id, {
      progress: {
        ...(progress.percent === undefined ? {} : { percent: progress.percent }),
        ...(progress.seconds === undefined ? {} : { seconds: progress.seconds })
      }
    }).then(() => {
      this.emit("progress", { jobId: id, ...progress, offline: this.snapshot() }, id);
      this.emitSnapshot(id);
    }).catch(() => undefined);
  }

  private assertNotAborted(operation: ActiveDownload): void {
    if (operation.aborted === "canceled") throw new KinoBridgeError("CANCELED", "Download was canceled");
    if (operation.aborted === "interrupted") throw new KinoBridgeError("INTERRUPTED", "Download was interrupted");
  }

  private async hydrateDescriptor(descriptor: StreamDescriptor, options: DownloadOptions): Promise<StreamDescriptor> {
    const selected = selectPlaybackResources(descriptor, options);
    const playlists = [
      { kind: "video", url: selected.videoUrl },
      ...(selected.audioTrack?.uri ? [{ kind: "audio", url: selected.audioTrack.uri }] : []),
      ...(options.embedSubtitles && selected.subtitleTrack?.uri ? [{ kind: "subtitle", url: selected.subtitleTrack.uri }] : [])
    ];
    const probed = await Promise.all(playlists.map(async ({ kind, url }) => ({
      kind,
      descriptor: await this.dependencies.probe({
        ...descriptor.candidate,
        id: `${descriptor.candidate.id}:download-${kind}`,
        requestId: `${descriptor.candidate.requestId}:download-${kind}`,
        url
      })
    })));
    if (descriptor.encrypted || probed.some((item) => item.descriptor.encrypted)) {
      throw new KinoBridgeError("UNSUPPORTED_ENCRYPTION", "Encrypted or DRM-protected HLS cannot be downloaded");
    }
    const media = probed.find((item) => item.kind === "video")!.descriptor;
    return StreamDescriptorSchema.parse({
      ...descriptor,
      ...(media.durationSeconds === undefined ? {} : { durationSeconds: media.durationSeconds }),
      encrypted: false
    });
  }

  private assertUsableDescriptor(descriptor: StreamDescriptor): void {
    if (descriptor.encrypted) throw new KinoBridgeError("UNSUPPORTED_ENCRYPTION", "Encrypted or DRM-protected HLS cannot be downloaded");
    if (descriptor.classification !== "master" && descriptor.classification !== "video") throw new KinoBridgeError("INVALID_DOWNLOAD_SOURCE", "Offline downloads require a video or master playlist");
  }

  private emitSnapshot(id?: string): void {
    this.emit("offlineState", this.snapshot(), id);
  }

  private async cleanupPartials(item: OfflineQueueItem): Promise<void> {
    const directory = resolve(item.options.outputDirectory.replace(/^~(?=$|\/)/, homedir()));
    const base = sanitizeFilename(item.options.filename.replace(/\.(?:mkv|mp4)$/i, ""));
    const pattern = new RegExp(`^\\.${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.[a-f0-9]{16}\\.part\\.(?:mkv|mp4)$`);
    try {
      for (const name of await readdir(directory)) {
        if (pattern.test(name)) await rm(resolve(directory, name), { force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
