import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(packageRoot, "dist");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(resolve(packageRoot, "public"), dist, { recursive: true });

const options = {
  entryPoints: {
    "service-worker": resolve(packageRoot, "src/service-worker.ts"),
    popup: resolve(packageRoot, "src/popup.ts")
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  logLevel: "info"
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching KinoBridge extension sources...");
} else {
  await build(options);
}
