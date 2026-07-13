#!/usr/bin/env node
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const extensionId = argument("--extension-id");
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  process.stderr.write("Usage: pnpm --filter @kinobridge/native-helper install-host -- --extension-id <32-letter-id> [--host-path /absolute/helper]\n");
  process.exit(2);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suppliedHostPath = argument("--host-path");
let hostPath;
if (suppliedHostPath) {
  hostPath = resolve(suppliedHostPath);
  if (hostPath !== suppliedHostPath) throw new Error("--host-path must be absolute");
  await access(hostPath, constants.X_OK);
} else {
  const sourceBundle = resolve(packageRoot, "dist/native-host.bundle.mjs");
  await access(sourceBundle, constants.R_OK);
  const installDirectory = resolve(homedir(), "Library/Application Support/KinoBridge");
  await mkdir(installDirectory, { recursive: true, mode: 0o700 });
  const installedBundle = resolve(installDirectory, "native-host.bundle.mjs");
  await copyFile(sourceBundle, installedBundle);
  await chmod(installedBundle, 0o600);
  const logDirectory = resolve(homedir(), "Library/Logs/KinoBridge");
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const logPath = resolve(logDirectory, "helper.log");
  await writeFile(logPath, "", { flag: "a", mode: 0o600 });
  await chmod(logPath, 0o600);
  hostPath = resolve(installDirectory, "kinobridge-native-host");
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
  const launcher = `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(installedBundle)} 2>>${quote(logPath)}\n`;
  await writeFile(hostPath, launcher, { mode: 0o755 });
  await chmod(hostPath, 0o755);
}

const manifestDirectory = resolve(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts");
const manifestPath = resolve(manifestDirectory, "com.kinobridge.helper.json");
await mkdir(manifestDirectory, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify({
  name: "com.kinobridge.helper",
  description: "KinoBridge native media helper",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
}, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${manifestPath}\n`);
