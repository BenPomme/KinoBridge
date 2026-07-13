export interface WidgetTabView {
  url?: string | undefined;
  pendingUrl?: string | undefined;
}

export interface WidgetWindowView {
  id?: number | undefined;
  state?: string | undefined;
  tabs?: WidgetTabView[] | undefined;
}

export interface WidgetWindowsApi {
  getAll(queryOptions: chrome.windows.QueryOptions): Promise<WidgetWindowView[]>;
  create(createData: chrome.windows.CreateData): Promise<WidgetWindowView | undefined>;
  update(windowId: number, updateInfo: chrome.windows.UpdateInfo): Promise<WidgetWindowView>;
}

export function findWidgetWindow(windows: WidgetWindowView[], widgetUrl: string): WidgetWindowView | undefined {
  return windows.find((window) => window.tabs?.some((tab) => tab.url === widgetUrl || tab.pendingUrl === widgetUrl));
}

export class WidgetWindowController {
  private opening: Promise<WidgetWindowView | undefined> | undefined;

  constructor(
    private readonly windows: WidgetWindowsApi,
    private readonly widgetUrl: string
  ) {}

  show(): Promise<WidgetWindowView | undefined> {
    if (this.opening) return this.opening;
    this.opening = this.showInternal().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async showInternal(): Promise<WidgetWindowView | undefined> {
    const existing = findWidgetWindow(
      await this.windows.getAll({ populate: true, windowTypes: ["popup"] }),
      this.widgetUrl
    );
    if (existing?.id !== undefined) {
      if (existing.state === "minimized") {
        await this.windows.update(existing.id, { state: "normal" });
      }
      return this.windows.update(existing.id, { focused: true });
    }
    return this.windows.create({
      url: this.widgetUrl,
      type: "popup",
      width: 430,
      height: 760,
      focused: true
    });
  }
}
