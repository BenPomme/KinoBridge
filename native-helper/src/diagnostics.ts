import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { KinoBridgeError } from "./errors.js";
import { spawnSafe } from "./process.js";

export type DependencyName = "ffmpeg" | "ffprobe" | "mpv" | "vlc" | "iina";
export interface DependencyDiagnostic {
  name: DependencyName;
  available: boolean;
  path?: string;
  version?: string;
}

const CANDIDATES: Record<DependencyName, string[]> = {
  ffmpeg: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"],
  ffprobe: ["/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"],
  mpv: ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"],
  vlc: ["/Applications/VLC.app/Contents/MacOS/VLC"],
  iina: ["/Applications/IINA.app/Contents/MacOS/iina-cli", "/Applications/IINA.app/Contents/MacOS/IINA"]
};

async function executablePath(name: DependencyName): Promise<string | undefined> {
  for (const candidate of CANDIDATES[name]) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known absolute path; PATH lookup is intentionally avoided.
    }
  }
  return undefined;
}

async function versionFor(name: DependencyName, path: string): Promise<string | undefined> {
  const args = name === "ffmpeg" || name === "ffprobe" ? ["-version"] : ["--version"];
  const child = spawnSafe(path, args);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { if (output.length < 8_192) output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { if (output.length < 8_192) output += chunk.toString("utf8"); });
  const success = await new Promise<boolean>((resolve) => {
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
  return success ? output.split(/\r?\n/, 1)[0]?.trim() : undefined;
}

export async function diagnoseDependencies(): Promise<DependencyDiagnostic[]> {
  return Promise.all((Object.keys(CANDIDATES) as DependencyName[]).map(async (name) => {
    const path = await executablePath(name);
    if (!path) return { name, available: false };
    const version = await versionFor(name, path);
    return { name, available: true, path, ...(version ? { version } : {}) };
  }));
}

export async function requireDependency(name: DependencyName): Promise<string> {
  const path = await executablePath(name);
  if (!path) throw new KinoBridgeError("DEPENDENCY_MISSING", `${name} is not installed in a supported location`);
  return path;
}
