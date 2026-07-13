import { expect, test, chromium, type BrowserContext } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const extensionPath = resolve("extension/dist");
const extensionId = "dkbpgionmjfdebegdnooaacggijpaekc";
let context: BrowserContext;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "kinobridge-playwright-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
});

test.afterAll(async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
});

test("loads the MV3 worker and safe companion UI", async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(worker.url()).toContain(extensionId);
  const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.action?.default_popup).toBeUndefined();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText("KinoBridge", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Minimize KinoBridge widget" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Kino CDN detection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play externally" })).toBeDisabled();
  await expect(page.getByLabel("Soundtrack")).toHaveValue("");
  await expect(page.getByLabel("Soundtrack").locator("option")).toHaveText(["Automatic: Original, then English"]);
  await expect(page.getByLabel("Subtitles", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Subtitles", { exact: true }).locator("option")).toHaveText(["Automatic: English"]);
  await expect(page.getByRole("heading", { name: "Offline downloads" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Offline library" })).toBeVisible();

  const html = await page.locator("body").textContent();
  expect(html).not.toMatch(/token=|cookie=|signature=/i);
});

test("companion popup window survives focus changes until explicitly closed", async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const controller = await context.newPage();
  await controller.goto("about:blank");
  const widgetPagePromise = context.waitForEvent("page");
  const windowId = await worker.evaluate(async (url) => {
    const created = await chrome.windows.create({ url, type: "popup", width: 430, height: 760, focused: true });
    return created?.id;
  }, `chrome-extension://${extensionId}/popup.html`);
  expect(windowId).toBeDefined();
  const widget = await widgetPagePromise;
  await widget.waitForLoadState("domcontentloaded");
  await controller.bringToFront();
  expect(widget.isClosed()).toBe(false);
  await expect(widget.getByText("KinoBridge", { exact: true }).first()).toBeVisible();
  await worker.evaluate(async (id) => {
    if (id !== undefined) await chrome.windows.remove(id);
  }, windowId);
  await expect.poll(() => widget.isClosed()).toBe(true);
});

test("renders persistent offline queue and library controls without exposing access context", async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  await worker.evaluate(async () => chrome.storage.local.set({
    "offline-state": {
      queue: [{
        id: "job-fixture",
        source: { title: "Queued Movie", pageUrl: "https://zerkalo.xyz/item/view/12345/s0e1" },
        options: { outputDirectory: "~/Downloads", filename: "Queued Movie", container: "mkv" },
        quality: "1080p",
        state: "interrupted",
        createdAt: 1,
        updatedAt: 2,
        error: "Fresh authorized stream access is required"
      }],
      library: [{
        id: "library-fixture",
        title: "Downloaded Movie",
        sourcePageUrl: "https://zerkalo.xyz/item/view/54321/s0e1",
        outputPath: "/Users/test/Movies/Downloaded Movie.mkv",
        sizeBytes: 1073741824,
        durationSeconds: 7200,
        tracks: [{ type: "video", codec: "h264", width: 1920, height: 1080 }, { type: "audio", codec: "aac", language: "en" }],
        createdAt: 3
      }]
    }
  }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText("Queued Movie", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry from current Kino tab" })).toBeVisible();
  await expect(page.getByText("Downloaded Movie", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reveal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  expect(await page.locator("body").textContent()).not.toMatch(/token=|cookie=|signature=/i);
});

test("reconstructs popup state after a persistent-context restart", async () => {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
  userDataDir = await mkdtemp(join(tmpdir(), "kinobridge-playwright-restart-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(worker.url()).toContain(extensionId);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText("KinoBridge", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Kino CDN detection" })).toBeVisible();
});
