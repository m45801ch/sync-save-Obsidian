import { App, Notice, Plugin, PluginManifest, TFile } from "obsidian";
import { SyncService, SyncEvent } from "./src/sync/SyncService";
import { S3Provider } from "./src/providers/S3Provider";
import { WebDAVProvider } from "./src/providers/WebDAVProvider";
import { DropboxProvider } from "./src/providers/DropboxProvider";
import { OneDriveProvider } from "./src/providers/OneDriveProvider";
import { GoogleDriveProvider } from "./src/providers/GoogleDriveProvider";
import { BoxProvider } from "./src/providers/BoxProvider";
import { Encryption } from "./src/sync/Encryption";
import { CloudProvider } from "./src/sync/CloudProvider";
import { SyncStatusBar } from "./src/ui/SyncStatusBar";
import { SyncSaveSettingsTab } from "./src/ui/SettingsTab";

export interface SyncLogEntry {
  type: string;
  message: string;
  timestamp: number;
}

interface SyncSaveSettings {
  activeProvider: string | null;
  enabledProviders: string[];
  s3: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string };
  webdav: { url: string; username: string; password: string; path: string };
  dropbox: { accessToken: string; appFolder: boolean };
  onedrive: { accessToken: string; useAppFolder: boolean };
  googledrive: { authType: string; accessToken: string; clientId: string; clientSecret: string; refreshToken: string; codeVerifier?: string };
  box: { authType: string; accessToken: string; clientId: string; clientSecret: string; refreshToken: string; authHelperUrl?: string };
  encryptionPassword: string;
  syncOnSave: boolean;
  syncInterval: number;
  skipHidden: boolean;
  skipPaths: string[];
  syncConfig: boolean;
  conflictStrategy: string;
  syncMode: string;
  showLastSyncInStatusBar: boolean;
  lastSuccessSyncTime: number;
}

const DEFAULT_SETTINGS: SyncSaveSettings = {
  activeProvider: "s3",
  enabledProviders: [],
  s3: { endpoint: "", region: "us-east-1", accessKeyId: "", secretAccessKey: "", bucket: "", prefix: "" },
  webdav: { url: "", username: "", password: "", path: "SyncSave" },
  dropbox: { accessToken: "", appFolder: true },
  onedrive: { accessToken: "", useAppFolder: true },
  googledrive: { authType: "developer", accessToken: "", clientId: "", clientSecret: "", refreshToken: "", codeVerifier: "" },
  box: { authType: "one_click", accessToken: "", clientId: "", clientSecret: "", refreshToken: "", authHelperUrl: "" },
  encryptionPassword: "",
  syncOnSave: false,
  syncInterval: 0,
  skipHidden: true,
  skipPaths: [],
  syncConfig: false,
  conflictStrategy: "keep-newer",
  syncMode: "bidirectional",
  showLastSyncInStatusBar: true,
  lastSuccessSyncTime: 0,
};

export default class SyncSavePlugin extends Plugin {
  settings: SyncSaveSettings;
  syncLog: SyncLogEntry[] = [];
  syncStatusBar: SyncStatusBar;
  private ribbonIcon: HTMLElement;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new SyncSaveSettingsTab(this.app, this));

    this.syncStatusBar = new SyncStatusBar(this.addStatusBarItem(), this);

    this.ribbonIcon = this.addRibbonIcon("sync", "同步備份", () => {
      this.manualSync();
    });
    this.ribbonIcon.addClass("sync-ribbon-icon");

    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => this.manualSync(),
    });

    this.addCommand({
      id: "sync-open-settings",
      name: "開啟同步設定",
      callback: () => {
        (this.app as any).setting.open();
        (this.app as any).setting.openTabById(this.manifest.id);
      },
    });

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.settings.syncOnSave && file instanceof TFile) {
          this.manualSync();
        }
      })
    );

    this.registerObsidianProtocolHandler("sync-save-auth", (params) => {
      const { provider, access_token, refresh_token } = params;
      if (!provider) {
        new Notice("同步備份：無效的授權協議回調");
        return;
      }

      if (provider === "box") {
        if (access_token && refresh_token) {
          this.settings.box.accessToken = access_token;
          this.settings.box.refreshToken = refresh_token;
          this.settings.box.authType = "oauth2";
          this.settings.box.clientId = "";
          this.settings.box.clientSecret = "";
          this.saveSettings();
          new Notice("同步備份：Box 雲端一鍵授權成功！");
          
          // 重新整理目前顯示的設定頁面
          const setting = (this.app as any).setting;
          if (setting && setting.activeTab && setting.activeTab.id === this.manifest.id) {
            setting.activeTab.display();
          }
        } else {
          new Notice("同步備份：Box 一鍵授權失敗，未取得金鑰");
        }
      }
    });

    if (this.settings.syncInterval > 0) {
      this.restartAutoSync();
    }

    this.log("同步備份已載入");
  }

  onunload(): void {
    const provider = this.getProvider();
    provider?.disconnect();
  }

  getProvider(providerId?: string): CloudProvider | null {
    const s = this.settings;
    const target = providerId || s.activeProvider;
    switch (target) {
      case "s3":
        return new S3Provider(s.s3);
      case "webdav":
        return new WebDAVProvider(s.webdav);
      case "dropbox":
        return new DropboxProvider(s.dropbox);
      case "onedrive":
        return new OneDriveProvider(s.onedrive);
      case "googledrive":
        return new GoogleDriveProvider(s.googledrive, () => this.saveSettings());
      case "box":
        return new BoxProvider(s.box, () => this.saveSettings());
      default:
        return null;
    }
  }

  private isCurrentlySyncing = false;

  async manualSync(): Promise<void> {
    if (this.isCurrentlySyncing) {
      new Notice("同步目前正在進行中，請稍候...");
      return;
    }

    const enabled = this.settings.enabledProviders;
    if (!enabled || enabled.length === 0) {
      new Notice("同步備份：尚未啟用任何雲端服務");
      return;
    }

    this.isCurrentlySyncing = true;
    const encryption = new Encryption(this.settings.encryptionPassword);

    try {
      for (const providerId of enabled) {
        const provider = this.getProvider(providerId);
        if (!provider) continue;

        // 建立每個雲端的獨立 SyncService
        const syncService = new SyncService(this.app.vault, {
          provider,
          encryption,
          vaultName: this.app.vault.getName(),
          syncOnSave: this.settings.syncOnSave,
          syncInterval: this.settings.syncInterval,
          skipHidden: this.settings.skipHidden,
          skipPaths: this.settings.skipPaths,
          conflictStrategy: this.settings.conflictStrategy as any,
          syncConfig: this.settings.syncConfig,
          syncMode: this.settings.syncMode as any,
        });

        // 綁定狀態監聽，在日誌中標註當前是哪個雲端
        syncService.on((event: SyncEvent) => {
          const modifiedEvent = {
            ...event,
            message: `[${providerId.toUpperCase()}] ${event.message}`
          };
          this.handleSyncEvent(modifiedEvent);
        });

        this.log(`開始同步雲端：${providerId.toUpperCase()}`);
        await syncService.sync();
      }
    } catch (e) {
      this.log(`多雲端同步發生非預期錯誤: ${e}`);
    } finally {
      this.isCurrentlySyncing = false;
    }
  }

  async testConnection(): Promise<void> {
    const provider = this.getProvider();
    if (!provider) {
      new Notice("同步備份：尚未選擇雲端服務");
      return;
    }

    this.syncStatusBar.setSyncing();
    const result = await provider.testConnection();

    if (result.success) {
      this.syncStatusBar.setSuccess("已連線");
      new Notice(`同步備份：${result.message}`);
    } else {
      this.syncStatusBar.setError("連線失敗");
      new Notice(`同步備份：${result.message}`);
    }

    this.log(`連線測試：${result.message}`);
  }

  restartAutoSync(): void {
    if (this.settings.syncInterval > 0) {
      this.registerInterval(
        window.setInterval(() => {
          this.manualSync();
        }, this.settings.syncInterval * 60 * 1000)
      );
    }
  }

  private handleSyncEvent(event: SyncEvent): void {
    switch (event.type) {
      case "sync-start":
        this.syncStatusBar.setSyncing();
        this.ribbonIcon.addClass("syncing");
        this.log("同步開始");
        break;

      case "sync-progress":
        this.syncStatusBar.setSyncing(event.progress);
        break;

      case "sync-file":
        this.log(event.message);
        break;

      case "sync-complete":
        this.settings.lastSuccessSyncTime = Date.now();
        this.saveSettings();
        this.syncStatusBar.setSuccess("同步完成");
        this.ribbonIcon.removeClass("syncing");
        new Notice("同步備份：同步完成");
        this.log("同步成功完成");
        break;

      case "sync-error":
        this.syncStatusBar.setError("錯誤");
        this.ribbonIcon.removeClass("syncing");
        new Notice(`同步備份：${event.message}`);
        this.log(event.message);
        break;
    }
  }

  private log(message: string): void {
    this.syncLog.push({
      type: message.startsWith("同步成功") || message.startsWith("同步完成") ? "sync-complete" : message.startsWith("同步開始") ? "sync-start" : message.startsWith("同步失敗") || message.startsWith("連線測試") ? "sync-error" : "sync-file",
      message,
      timestamp: Date.now(),
    });

    if (this.syncLog.length > 200) {
      this.syncLog = this.syncLog.slice(-100);
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() || {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      s3: { ...DEFAULT_SETTINGS.s3, ...data.s3 },
      webdav: { ...DEFAULT_SETTINGS.webdav, ...data.webdav },
      dropbox: { ...DEFAULT_SETTINGS.dropbox, ...data.dropbox },
      onedrive: { ...DEFAULT_SETTINGS.onedrive, ...data.onedrive },
      googledrive: { ...DEFAULT_SETTINGS.googledrive, ...data.googledrive },
      box: { ...DEFAULT_SETTINGS.box, ...data.box },
    };

    // 遷移設定：如果沒有自訂 Box 金鑰，預設強制切換為「一鍵連結」
    if (!this.settings.box.clientId && !this.settings.box.clientSecret) {
      this.settings.box.authType = "one_click";
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
