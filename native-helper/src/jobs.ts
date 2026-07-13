import type { DownloadOptions, PlaybackOptions, StreamCandidate, StreamDescriptor } from "@kinobridge/shared";
import { AccessBroker } from "./broker.js";
import { startDownload } from "./downloads.js";
import { KinoBridgeError, safeError } from "./errors.js";
import { launchPlayer } from "./players.js";
import { selectPlaybackResources } from "./media-selection.js";

type JobKind = "playback" | "download";
type JobState = "starting" | "running" | "completed" | "failed" | "canceled";

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  state: JobState;
  startedAt: number;
  updatedAt: number;
  progress?: unknown;
  result?: unknown;
  error?: ReturnType<typeof safeError>;
}

interface JobRecord {
  snapshot: JobSnapshot;
  broker: AccessBroker;
  cancel: () => void;
}

export type EmitEvent = (type: "progress" | "completed" | "failed" | "refreshRequired", payload: unknown) => void;

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly emit: EmitEvent) {}

  async startPlayback(id: string, descriptor: StreamDescriptor, options: PlaybackOptions): Promise<JobSnapshot> {
    this.assertNew(id);
    const broker = new AccessBroker(
      descriptor.candidate,
      () => this.emit("refreshRequired", { jobId: id, candidateId: descriptor.candidate.id }),
      this.playlistUrls(descriptor)
    );
    const selected = selectPlaybackResources(descriptor, options);
    const localUrl = await broker.start(selected.videoUrl);
    try {
      const player = await launchPlayer(localUrl, options, {
        ...(selected.audioTrack?.uri ? { audioUrl: broker.expose(selected.audioTrack.uri) } : {}),
        ...(selected.subtitleTrack?.uri ? { subtitleUrl: broker.expose(selected.subtitleTrack.uri) } : {})
      });
      const snapshot: JobSnapshot = { id, kind: "playback", state: "running", startedAt: Date.now(), updatedAt: Date.now() };
      this.jobs.set(id, { snapshot, broker, cancel: () => { player.stop(); void player.cleanup(); } });
      this.emit("progress", { jobId: id, phase: "playing" });
      player.child.once("exit", (code, signal) => {
        const record = this.jobs.get(id);
        if (!record) return;
        if (record.snapshot.state === "canceled") return;
        if (code === 0 || signal === "SIGTERM") this.finish(id, "completed", { reason: code === 0 ? "player-exited" : "player-closed" });
        else this.fail(id, new KinoBridgeError("PLAYER_FAILED", `Player exited with ${signal ?? `code ${code ?? "unknown"}`}`));
        void player.cleanup().then(() => broker.close());
      });
      return snapshot;
    } catch (error) {
      await broker.close();
      throw error;
    }
  }

  async startDownload(id: string, descriptor: StreamDescriptor, options: DownloadOptions): Promise<JobSnapshot> {
    this.assertNew(id);
    const broker = new AccessBroker(
      descriptor.candidate,
      () => this.emit("refreshRequired", { jobId: id, candidateId: descriptor.candidate.id }),
      this.playlistUrls(descriptor)
    );
    const localUrl = await broker.start(descriptor.masterUrl ?? descriptor.candidate.url);
    try {
      const handle = await startDownload(localUrl, descriptor, options, (progress) => {
        const record = this.jobs.get(id);
        if (record) {
          record.snapshot.progress = progress;
          record.snapshot.updatedAt = Date.now();
        }
        this.emit("progress", { jobId: id, ...progress });
      });
      const snapshot: JobSnapshot = { id, kind: "download", state: "running", startedAt: Date.now(), updatedAt: Date.now() };
      this.jobs.set(id, { snapshot, broker, cancel: handle.cancel });
      void handle.completed.then(
        (result) => this.finish(id, "completed", result),
        (error) => error instanceof KinoBridgeError && error.code === "CANCELED" ? undefined : this.fail(id, error)
      ).finally(() => broker.close());
      return snapshot;
    } catch (error) {
      await broker.close();
      throw error;
    }
  }

  cancel(id: string): JobSnapshot {
    const record = this.require(id);
    if (record.snapshot.state !== "running" && record.snapshot.state !== "starting") return record.snapshot;
    record.snapshot.state = "canceled";
    record.snapshot.updatedAt = Date.now();
    record.cancel();
    void record.broker.close();
    this.emit("completed", { jobId: id, canceled: true });
    return record.snapshot;
  }

  refresh(id: string, candidate: StreamCandidate): JobSnapshot {
    const record = this.require(id);
    if (record.snapshot.state !== "running") throw new KinoBridgeError("JOB_NOT_RUNNING", "Only a running job can be refreshed");
    record.broker.refresh(candidate);
    record.snapshot.updatedAt = Date.now();
    return record.snapshot;
  }

  status(id?: string): JobSnapshot | JobSnapshot[] {
    return id ? this.require(id).snapshot : [...this.jobs.values()].map((record) => record.snapshot);
  }

  private assertNew(id: string): void {
    if (this.jobs.has(id)) throw new KinoBridgeError("DUPLICATE_JOB", "A job with this ID already exists");
  }

  private playlistUrls(descriptor: StreamDescriptor): string[] {
    return [
      ...(descriptor.masterUrl ? [descriptor.masterUrl] : []),
      ...descriptor.variants.map((variant) => variant.uri),
      ...descriptor.tracks.flatMap((track) => track.uri ? [track.uri] : [])
    ];
  }

  private require(id: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record) throw new KinoBridgeError("JOB_NOT_FOUND", "Job was not found");
    return record;
  }

  private finish(id: string, state: "completed", result: unknown): void {
    const record = this.require(id);
    record.snapshot.state = state;
    record.snapshot.updatedAt = Date.now();
    record.snapshot.result = result;
    this.emit("completed", { jobId: id, result });
  }

  private fail(id: string, error: unknown): void {
    const record = this.require(id);
    record.snapshot.state = "failed";
    record.snapshot.updatedAt = Date.now();
    record.snapshot.error = safeError(error);
    this.emit("failed", { jobId: id, error: record.snapshot.error });
  }
}
