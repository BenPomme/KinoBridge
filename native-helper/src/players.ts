import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PlaybackOptions } from "@kinobridge/shared";
import { requireDependency } from "./diagnostics.js";
import { KinoBridgeError } from "./errors.js";
import { spawnSafe } from "./process.js";
import { buildTopBottomToSbsFilter } from "./stereo.js";

export interface PlayerHandle {
  child: ChildProcessWithoutNullStreams;
  stop(): void;
  cleanup(): Promise<void>;
}

export interface ExternalPlaybackResources {
  audioUrl?: string;
  subtitleUrl?: string;
}

function languageList(languages: string[]): string {
  return languages.map((language) => language.replace(/[^A-Za-z0-9_-]/g, "")).filter(Boolean).join(",");
}

async function sendMpvCommand(socketPath: string, command: unknown): Promise<void> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(socketPath);
        socket.once("error", reject);
        socket.once("connect", () => socket.end(`${JSON.stringify({ command })}\n`, resolve));
      });
      return;
    } catch (error) {
      lastError = error as Error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new KinoBridgeError("MPV_IPC_FAILED", `Could not connect to mpv IPC: ${lastError?.message ?? "unknown error"}`);
}

async function launchMpv(localUrl: string, options: PlaybackOptions, resources: ExternalPlaybackResources): Promise<PlayerHandle> {
  const executable = await requireDependency("mpv");
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "kinobridge-mpv-"));
  const socketPath = join(runtimeDirectory, "control.sock");
  const filter = buildTopBottomToSbsFilter(options);
  const args = [
    "--idle=yes",
    "--force-window=yes",
    "--no-terminal",
    `--input-ipc-server=${socketPath}`,
    `--alang=${languageList(options.audioLanguages)}`,
    `--slang=${languageList(options.subtitleLanguages)}`,
    options.subtitlesEnabled ? "--sub-visibility=yes" : "--sub-visibility=no",
    ...(resources.audioUrl ? [`--audio-file=${resources.audioUrl}`] : []),
    ...(resources.subtitleUrl ? [`--sub-file=${resources.subtitleUrl}`] : []),
    ...(filter ? [`--vf=lavfi=[${filter}]`] : []),
    ...(options.outputProfile === "xreal-sbs" ? ["--fullscreen=yes"] : [])
  ];
  const child = spawnSafe(executable, args);
  child.stdout.resume();
  child.stderr.resume();
  try {
    await sendMpvCommand(socketPath, ["loadfile", localUrl, "replace"]);
  } catch (error) {
    child.kill("SIGTERM");
    await rm(runtimeDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    child,
    stop: () => child.kill("SIGTERM"),
    cleanup: () => rm(runtimeDirectory, { recursive: true, force: true })
  };
}

async function launchVlc(localUrl: string, options: PlaybackOptions): Promise<PlayerHandle> {
  if (options.outputProfile === "xreal-sbs") throw new KinoBridgeError("PLAYER_UNSUPPORTED", "VLC fallback supports 2D playback only");
  const executable = await requireDependency("vlc");
  const child = spawnSafe(executable, [
    "--no-video-title-show",
    `--audio-language=${languageList(options.audioLanguages)}`,
    `--sub-language=${languageList(options.subtitleLanguages)}`,
    ...(options.subtitlesEnabled ? [] : ["--sub-track=-1"]),
    localUrl
  ]);
  child.stdout.resume();
  child.stderr.resume();
  return { child, stop: () => child.kill("SIGTERM"), cleanup: async () => {} };
}

async function launchIina(localUrl: string, options: PlaybackOptions): Promise<PlayerHandle> {
  if (options.outputProfile === "xreal-sbs") throw new KinoBridgeError("PLAYER_UNSUPPORTED", "IINA integration currently supports 2D playback only");
  const executable = await requireDependency("iina");
  const child = spawnSafe(executable, ["--no-stdin", localUrl]);
  child.stdout.resume();
  child.stderr.resume();
  return { child, stop: () => child.kill("SIGTERM"), cleanup: async () => {} };
}

export async function launchPlayer(localUrl: string, options: PlaybackOptions, resources: ExternalPlaybackResources = {}): Promise<PlayerHandle> {
  if (options.player === "mpv") return launchMpv(localUrl, options, resources);
  if (options.player === "vlc") return launchVlc(localUrl, options);
  return launchIina(localUrl, options);
}
