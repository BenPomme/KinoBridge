import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { KinoBridgeError } from "./errors.js";

export function spawnSafe(executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio = {}): ChildProcessWithoutNullStreams {
  if (!executable || executable.includes("\0")) throw new KinoBridgeError("INVALID_EXECUTABLE", "Executable path is invalid");
  for (const argument of args) if (argument.includes("\0")) throw new KinoBridgeError("INVALID_ARGUMENT", "Process argument contains a null byte");
  return spawn(executable, [...args], { ...options, shell: false, windowsHide: true });
}

export async function waitForExit(child: ChildProcessWithoutNullStreams, label: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new KinoBridgeError("PROCESS_START_FAILED", `${label} could not start: ${error.message}`)));
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new KinoBridgeError("PROCESS_FAILED", `${label} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`)));
  });
}
