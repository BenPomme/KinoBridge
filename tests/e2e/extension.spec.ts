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

test("loads the MV3 worker and safe popup UI", async () => {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  expect(worker.url()).toContain(extensionId);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.getByText("KinoBridge", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable Kino CDN detection" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play externally" })).toBeDisabled();

  const html = await page.locator("body").textContent();
  expect(html).not.toMatch(/token=|cookie=|signature=/i);
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
