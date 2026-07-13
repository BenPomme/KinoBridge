#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(packageRoot, "public/manifest.json"), "utf8"));
if (typeof manifest.key !== "string") throw new Error("Extension manifest has no stable public key");
const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
const alphabet = "abcdefghijklmnop";
let id = "";
for (const byte of digest) id += alphabet[byte >> 4] + alphabet[byte & 15];
process.stdout.write(`${id}\n`);
