import { lstat } from "node:fs/promises";
import type { Player } from "@kinobridge/shared";
import { requireDependency } from "./diagnostics.js";
import { KinoBridgeError } from "./errors.js";
import type { OfflineStore } from "./offline-store.js";
import { spawnSafe } from "./process.js";

async function assertRegularFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new KinoBridgeError("UNSAFE_LIBRARY_PATH", "Offline title is not a regular media file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new KinoBridgeError("LIBRARY_FILE_MISSING", "Offline media file no longer exists");
    throw error;
  }
}

export function localPlayerArguments(player: Player, path: string): string[] {
  switch (player) {
    case "mpv": return ["--force-window=yes", "--", path];
    case "vlc": return ["--", path];
    case "iina": return [path];
  }
}

export async function playOffline(store: OfflineStore, id: string, player: Player): Promise<void> {
  const entry = store.getLibraryEntry(id);
  if (!entry) throw new KinoBridgeError("LIBRARY_NOT_FOUND", "Offline title was not found");
  await assertRegularFile(entry.outputPath);
  const executable = await requireDependency(player);
  const child = spawnSafe(executable, localPlayerArguments(player, entry.outputPath));
  child.stdout.resume();
  child.stderr.resume();
}

export async function revealOffline(store: OfflineStore, id: string): Promise<void> {
  const entry = store.getLibraryEntry(id);
  if (!entry) throw new KinoBridgeError("LIBRARY_NOT_FOUND", "Offline title was not found");
  await assertRegularFile(entry.outputPath);
  const child = spawnSafe("/usr/bin/open", ["-R", entry.outputPath]);
  child.stdout.resume();
  child.stderr.resume();
}
