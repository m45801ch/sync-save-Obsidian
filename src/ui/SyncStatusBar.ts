import SyncSavePlugin from "../../main";

export class SyncStatusBar {
  private statusBar: HTMLElement;
  private dotEl: HTMLSpanElement;
  private textEl: HTMLSpanElement;
  private lastUpdate = 0;
  private plugin: SyncSavePlugin;

  constructor(statusBar: HTMLElement, plugin: SyncSavePlugin) {
    this.statusBar = statusBar;
    this.plugin = plugin;

    const el = statusBar.createEl("span", { cls: "sync-status-bar" });

    this.dotEl = el.createEl("span", { cls: "sync-status-dot idle" });
    this.textEl = el.createEl("span", { text: "同步備份" });

    this.setIdle();
  }

  setIdle(): void {
    this.dotEl.className = "sync-status-dot idle";
    const s = this.plugin.settings;
    if (s.showLastSyncInStatusBar && s.lastSuccessSyncTime > 0) {
      const timeStr = new Date(s.lastSuccessSyncTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      this.textEl.setText(`上次同步 ${timeStr}`);
    } else {
      this.textEl.setText("同步備份");
    }
  }

  setSyncing(progress?: { current: number; total: number }, providerName?: string): void {
    this.dotEl.className = "sync-status-dot syncing";
    const provStr = providerName ? `[${providerName}] ` : "";
    if (progress) {
      this.textEl.setText(`${provStr}同步中 ${progress.current}/${progress.total}`);
    } else {
      this.textEl.setText(`${provStr}同步中…`);
    }
  }

  setSuccess(message: string): void {
    this.dotEl.className = "sync-status-dot success";
    this.textEl.setText(message || "已同步");
    this.lastUpdate = Date.now();
    setTimeout(() => {
      if (Date.now() - this.lastUpdate >= 5000) {
        this.setIdle();
      }
    }, 5000);
  }

  setError(message: string): void {
    this.dotEl.className = "sync-status-dot error";
    this.textEl.setText(message || "同步失敗");
    this.lastUpdate = Date.now();
    setTimeout(() => {
      if (Date.now() - this.lastUpdate >= 10000) {
        this.setIdle();
      }
    }, 10000);
  }
}
