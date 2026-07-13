#!/usr/bin/env node
import { diagnoseDependencies } from "./diagnostics.js";

if (process.argv[2] !== "diagnose") {
  process.stderr.write("Usage: kinobridge-native-helper diagnose\n");
  process.exitCode = 2;
} else {
  const diagnostics = await diagnoseDependencies();
  process.stdout.write(`${JSON.stringify({ platform: process.platform, architecture: process.arch, dependencies: diagnostics }, null, 2)}\n`);
  if (!diagnostics.find((item) => item.name === "ffmpeg")?.available || !diagnostics.find((item) => item.name === "ffprobe")?.available) process.exitCode = 1;
}
