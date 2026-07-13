import { describe, expect, it } from "vitest";
import {
  WidgetWindowController,
  findWidgetWindow,
  type WidgetWindowView,
  type WidgetWindowsApi
} from "../src/widget-window.js";

const widgetUrl = "chrome-extension://kinobridge/popup.html";

class FakeWindows implements WidgetWindowsApi {
  windows: WidgetWindowView[] = [];
  creates = 0;
  updates: Array<{ id: number; info: chrome.windows.UpdateInfo }> = [];
  getAllDelay = 0;

  async getAll(): Promise<WidgetWindowView[]> {
    if (this.getAllDelay) await new Promise((resolve) => setTimeout(resolve, this.getAllDelay));
    return this.windows;
  }

  async create(data: chrome.windows.CreateData): Promise<WidgetWindowView> {
    this.creates += 1;
    const created = { id: 100 + this.creates, state: "normal" as const, tabs: [{ url: String(data.url) }] };
    this.windows = [...this.windows, created];
    return created;
  }

  async update(id: number, info: chrome.windows.UpdateInfo): Promise<WidgetWindowView> {
    this.updates.push({ id, info });
    const current = this.windows.find((window) => window.id === id) ?? { id };
    const updated = { ...current, ...(info.state ? { state: info.state } : {}) };
    this.windows = this.windows.map((window) => window.id === id ? updated : window);
    return updated;
  }
}

describe("persistent companion window", () => {
  it("matches only the exact widget URL, including a pending extension tab", () => {
    const exact = { id: 3, tabs: [{ pendingUrl: widgetUrl }] };
    expect(findWidgetWindow([
      { id: 1, tabs: [{ url: `${widgetUrl}?copy=1` }] },
      { id: 2, tabs: [{ url: "chrome-extension://other/popup.html" }] },
      exact
    ], widgetUrl)).toBe(exact);
  });

  it("creates one fixed-size popup when no widget exists", async () => {
    const windows = new FakeWindows();
    const result = await new WidgetWindowController(windows, widgetUrl).show();
    expect(result?.id).toBe(101);
    expect(windows.creates).toBe(1);
    expect(windows.updates).toEqual([]);
  });

  it("focuses the existing widget without changing a user-selected normal state", async () => {
    const windows = new FakeWindows();
    windows.windows = [{ id: 7, state: "maximized", tabs: [{ url: widgetUrl }] }];
    await new WidgetWindowController(windows, widgetUrl).show();
    expect(windows.creates).toBe(0);
    expect(windows.updates).toEqual([{ id: 7, info: { focused: true } }]);
  });

  it("restores a minimized widget only after an explicit show request", async () => {
    const windows = new FakeWindows();
    windows.windows = [{ id: 8, state: "minimized", tabs: [{ url: widgetUrl }] }];
    const controller = new WidgetWindowController(windows, widgetUrl);
    expect(windows.updates).toEqual([]);
    await controller.show();
    expect(windows.updates).toEqual([
      { id: 8, info: { state: "normal" } },
      { id: 8, info: { focused: true } }
    ]);
  });

  it("deduplicates concurrent activation requests", async () => {
    const windows = new FakeWindows();
    windows.getAllDelay = 10;
    const controller = new WidgetWindowController(windows, widgetUrl);
    const first = controller.show();
    const second = controller.show();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(windows.creates).toBe(1);
  });

  it("recreates the widget only after the user has closed it and explicitly opens it again", async () => {
    const windows = new FakeWindows();
    const controller = new WidgetWindowController(windows, widgetUrl);
    await controller.show();
    windows.windows = [];
    expect(windows.creates).toBe(1);
    await controller.show();
    expect(windows.creates).toBe(2);
  });
});
