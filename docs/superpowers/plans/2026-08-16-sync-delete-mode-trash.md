# 備份並同步刪除模式 + 雲端垃圾桶清除 — 實作計劃

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增同步方向「備份並同步刪除」，將本機已刪除的檔案搬移到雲端垃圾桶資料夾（非真刪除），並提供保留天數設定、獨立清除定時器與手動清除。

**Architecture:** 沿用現有 `SyncService` 模式分派架構，新增 `sync-delete` 模式分支。垃圾桶採用方案 A（日期資料夾重新上傳）：下載原檔 → 上傳到 `.sync-trash/YYYY-MM-DD/<path>` → 刪除原檔。清除邏輯以 `provider.listFiles("")` 取得完整清單，篩出 `.sync-trash/` 下超過保留天數的檔案並永久刪除。不修改 `CloudProvider` 介面。

**Tech Stack:** TypeScript、Obsidian Plugin API、esbuild（`npm run build`）。

## Global Constraints

- `syncMode` 型別新增值：`"sync-delete"`
- 垃圾桶根目錄固定為：`.sync-trash`
- 垃圾桶檔案路徑格式：`.sync-trash/YYYY-MM-DD/<原始相對路徑>`
- 保留天數設定欄位名：`trashRetentionDays`（預設 30，單位天）
- 清除間隔設定欄位名：`trashCleanupIntervalHours`（預設 24，單位小時，0 = 停用）
- 設定檔改動後必須呼叫 `this.plugin.saveSettings()`
- 驗證指令一律使用：`npm run build`（tsc type check + esbuild production）
- 專案無自動化測試框架；驗證方式為 `npm run build` 通過 + Obsidian 手動驗證

---

## 檔案結構

| 檔案 | 責任 |
|------|------|
| `src/sync/SyncService.ts` | 核心同步引擎：新增 `sync-delete` 分支、`moveToTrash`、`cleanupTrash`、`isTrashPath`、`getTrashDateFolder`、垃圾桶排除 |
| `main.ts` | 設定欄位與預設值、`cleanupTrashNow()`、`restartTrashCleanupTimer()`、清除指令、`onload`/`onunload` 定時器管理 |
| `src/ui/SettingsTab.ts` | 同步模式下拉新增選項與說明、`renderTrashSettings()` 垃圾桶設定區塊、`display()` 串接 |

---

### Task 1: SyncService — 垃圾桶核心與 sync-delete 模式

**Files:**
- Modify: `src/sync/SyncService.ts`

**Interfaces:**
- Produces:
  - `SyncOptions.syncMode` 型別新增 `"sync-delete"`
  - `SyncOptions.trashRetentionDays?: number`
  - `SyncService.cleanupTrash(): Promise<void>`（公開，供 main.ts 呼叫）
  - `SyncService.isTrashPath(path: string): boolean`（內部）
  - 垃圾桶路徑常數 `.sync-trash`（內部）

- [ ] **Step 1: 更新 SyncOptions 型別**

將 `src/sync/SyncService.ts` 第 31 行的：

```ts
  syncMode?: "bidirectional" | "upload-only" | "download-only";
```

取代為：

```ts
  syncMode?: "bidirectional" | "upload-only" | "download-only" | "sync-delete";
  trashRetentionDays?: number;
```

- [ ] **Step 2: 新增垃圾桶常數**

在 `src/sync/SyncService.ts` 第 3 行 `import` 之後、`export type SyncEventType` 之前，插入：

```ts
const TRASH_ROOT = ".sync-trash";
```

- [ ] **Step 3: 修改 sync() 的模式分派，支援 sync-delete**

將 `src/sync/SyncService.ts` 第 142-143 行的：

```ts
      } else {
        this.emit({
          type: "sync-progress",
          message: `Found ${localFiles.length} local files, ${remoteFiles.length} remote files`,
```

取代為：

```ts
      } else {
        const deleteSynced = mode === "sync-delete";
        this.emit({
          type: "sync-progress",
          message: deleteSynced
            ? `備份並同步刪除：本機 ${localFiles.length} 個檔案，雲端 ${remoteFiles.length} 個檔案`
            : `Found ${localFiles.length} local files, ${remoteFiles.length} remote files`,
```

- [ ] **Step 4: 修改第二個迴圈（雲端有、本機沒有）**

將 `src/sync/SyncService.ts` 第 236-249 行的：

```ts
        for (const remotePath of remoteFiles) {
          if (remotePath.path === ".sync-manifest.json") continue;
          if (this.shouldSkip(remotePath.path)) continue;
          if (!localMap.has(remotePath.path)) {
            processed++;
            await this.downloadFile(remotePath.path);
            this.emit({
              type: "sync-file",
              message: `Downloaded (new): ${remotePath.path}`,
              file: remotePath.path,
              progress: { current: processed, total },
            });
          }
        }
```

取代為：

```ts
        for (const remotePath of remoteFiles) {
          if (remotePath.path === ".sync-manifest.json") continue;
          if (this.shouldSkip(remotePath.path)) continue;
          if (!localMap.has(remotePath.path)) {
            processed++;
            if (deleteSynced && manifest?.files?.[remotePath.path]) {
              await this.moveToTrash(remotePath.path);
              this.emit({
                type: "sync-file",
                message: `本機已刪除，已移至雲端垃圾桶：${remotePath.path}`,
                file: remotePath.path,
                progress: { current: processed, total },
              });
            } else {
              await this.downloadFile(remotePath.path);
              this.emit({
                type: "sync-file",
                message: `Downloaded (new): ${remotePath.path}`,
                file: remotePath.path,
                progress: { current: processed, total },
              });
            }
          }
        }
```

- [ ] **Step 5: sync-delete 模式同步結束後自動清除垃圾桶**

將 `src/sync/SyncService.ts` 第 252-253 行的：

```ts
      const updatedLocalFiles = await this.getLocalFiles();
      await this.saveManifest(updatedLocalFiles);
```

取代為：

```ts
      const updatedLocalFiles = await this.getLocalFiles();
      await this.saveManifest(updatedLocalFiles);

      if (mode === "sync-delete") {
        await this.cleanupTrash();
      }
```

- [ ] **Step 6: shouldSkip 排除垃圾桶路徑**

將 `src/sync/SyncService.ts` 第 291-297 行的：

```ts
  private shouldSkip(path: string): boolean {
    const segments = path.replace(/\\/g, "/").split("/");
    for (const seg of segments) {
      if (this.options.skipHidden && seg.startsWith(".")) return true;
      if (seg.startsWith("_") && !this.options.syncConfig) return true;
    }
    if (path.startsWith(".obsidian/") && !this.options.syncConfig) return true;
```

取代為：

```ts
  private shouldSkip(path: string): boolean {
    const segments = path.replace(/\\/g, "/").split("/");
    for (const seg of segments) {
      if (this.options.skipHidden && seg.startsWith(".")) return true;
      if (seg.startsWith("_") && !this.options.syncConfig) return true;
    }
    if (this.isTrashPath(path)) return true;
    if (path.startsWith(".obsidian/") && !this.options.syncConfig) return true;
```

- [ ] **Step 7: 新增垃圾桶輔助方法**

在 `src/sync/SyncService.ts` 的 `saveManifest` 方法（第 369 行起）之前、`downloadFileToPath`（第 367 行）結束後，插入以下方法：

```ts
  private isTrashPath(path: string): boolean {
    return path === TRASH_ROOT || path.startsWith(TRASH_ROOT + "/");
  }

  private getTrashDateFolder(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  private async moveToTrash(path: string): Promise<void> {
    const remote = await this.provider.downloadFile(path);
    if (!remote) return;

    let data = remote.content;
    if (this.encryption.isEnabled()) {
      const decrypted = await this.encryption.decrypt(data);
      if (decrypted) data = decrypted;
    }

    const trashPath = `${TRASH_ROOT}/${this.getTrashDateFolder()}/${path}`;
    await this.uploadFile(trashPath, { content: data, stat: { mtime: Date.now() } });
    await this.provider.deleteFile(path);
  }

  async cleanupTrash(): Promise<void> {
    const retentionDays = this.options.trashRetentionDays ?? 30;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    let trashFiles: { path: string; mtime: number; size: number }[];
    try {
      trashFiles = await this.provider.listFiles("");
    } catch {
      trashFiles = [];
    }

    const toDelete: string[] = [];
    for (const f of trashFiles) {
      if (!this.isTrashPath(f.path)) continue;
      const segs = f.path.split("/");
      if (segs.length < 2) continue;
      const dateTs = new Date(`${segs[1]}T00:00:00`).getTime();
      if (isNaN(dateTs)) continue;
      if (dateTs < cutoff) toDelete.push(f.path);
    }

    for (const path of toDelete) {
      try {
        await this.provider.deleteFile(path);
        this.emit({ type: "sync-file", message: `已清除垃圾桶檔案：${path}` });
      } catch (e) {
        this.emit({
          type: "sync-error",
          message: `清除垃圾桶失敗：${path} (${e instanceof Error ? e.message : String(e)})`,
        });
      }
    }
  }
```

- [ ] **Step 8: 驗證型別**

Run: `npm run build`
Expected: tsc 無錯誤，esbuild 產出 `main.js`

- [ ] **Step 9: Commit**

```bash
git add src/sync/SyncService.ts
git commit -m "feat: add sync-delete mode with cloud trash folder"
```

---

### Task 2: main.ts — 設定欄位、清除指令與獨立定時器

**Files:**
- Modify: `main.ts`

**Interfaces:**
- Consumes:
  - `SyncService` 選項 `trashRetentionDays: number`
  - `SyncService.cleanupTrash(): Promise<void>`
- Produces:
  - `SyncSaveSettings.trashRetentionDays: number`
  - `SyncSaveSettings.trashCleanupIntervalHours: number`
  - `SyncSavePlugin.cleanupTrashNow(): Promise<void>`（公開，供 SettingsTab 按鈕與指令呼叫）
  - `SyncSavePlugin.restartTrashCleanupTimer(): void`

- [ ] **Step 1: 設定介面新增欄位**

在 `main.ts` 第 53 行 `syncMode: string;` 之後插入：

```ts
  trashRetentionDays: number;
  trashCleanupIntervalHours: number;
```

- [ ] **Step 2: DEFAULT_SETTINGS 新增預設值**

在 `main.ts` 第 83 行 `syncMode: "bidirectional",` 之後插入：

```ts
  trashRetentionDays: 30,
  trashCleanupIntervalHours: 24,
```

- [ ] **Step 3: manualSync 傳遞 trashRetentionDays**

將 `main.ts` 第 332 行的：

```ts
          syncMode: this.settings.syncMode as any,
```

取代為：

```ts
          syncMode: this.settings.syncMode as any,
          trashRetentionDays: this.settings.trashRetentionDays,
```

- [ ] **Step 4: 新增「清除雲端垃圾桶」指令**

在 `main.ts` 第 113-120 行 `sync-open-settings` 指令之後插入：

```ts
    this.addCommand({
      id: "sync-clean-trash",
      name: "清除雲端垃圾桶",
      callback: () => this.cleanupTrashNow(),
    });
```

- [ ] **Step 5: onload 啟動清除定時器**

將 `main.ts` 第 256-258 行的：

```ts
    if (this.settings.syncInterval > 0) {
      this.restartAutoSync();
    }
```

取代為：

```ts
    if (this.settings.syncInterval > 0) {
      this.restartAutoSync();
    }
    if (this.settings.trashCleanupIntervalHours > 0) {
      this.restartTrashCleanupTimer();
    }
```

- [ ] **Step 6: onunload 清除定時器**

將 `main.ts` 第 263-266 行的：

```ts
  onunload(): void {
    const provider = this.getProvider();
    provider?.disconnect();
  }
```

取代為：

```ts
  onunload(): void {
    const provider = this.getProvider();
    provider?.disconnect();
    if (this.trashCleanupTimer !== null) {
      window.clearInterval(this.trashCleanupTimer);
      this.trashCleanupTimer = null;
    }
  }
```

- [ ] **Step 7: 新增 cleanupTrashNow 與 restartTrashCleanupTimer**

在 `main.ts` 第 398 行 `restartAutoSync` 方法之後、第 400 行 `handleSyncEvent` 之前，插入：

```ts
  private trashCleanupTimer: number | null = null;

  async cleanupTrashNow(): Promise<void> {
    if (this.isCurrentlySyncing) {
      new Notice("同步正在進行中，請稍後再試");
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
          trashRetentionDays: this.settings.trashRetentionDays,
        });

        syncService.on((event: SyncEvent) => {
          const modifiedEvent = {
            ...event,
            message: `[${providerId.toUpperCase()}] ${event.message}`,
            providerId,
          };
          this.handleSyncEvent(modifiedEvent);
        });

        this.log(`開始清除雲端垃圾桶：${providerId.toUpperCase()}`);
        await syncService.cleanupTrash();
      }
      new Notice("同步備份：垃圾桶清除完成");
    } catch (e) {
      this.log(`清除垃圾桶發生非預期錯誤: ${e}`);
    } finally {
      this.isCurrentlySyncing = false;
    }
  }

  restartTrashCleanupTimer(): void {
    if (this.trashCleanupTimer !== null) {
      window.clearInterval(this.trashCleanupTimer);
      this.trashCleanupTimer = null;
    }
    if (this.settings.trashCleanupIntervalHours > 0) {
      this.trashCleanupTimer = window.setInterval(() => {
        this.cleanupTrashNow();
      }, this.settings.trashCleanupIntervalHours * 60 * 60 * 1000);
    }
  }
```

- [ ] **Step 8: 驗證型別**

Run: `npm run build`
Expected: tsc 無錯誤，esbuild 產出 `main.js`

- [ ] **Step 9: Commit**

```bash
git add main.ts
git commit -m "feat: add trash cleanup timer, command, and settings"
```

---

### Task 3: SettingsTab — 同步模式選項與垃圾桶設定區塊

**Files:**
- Modify: `src/ui/SettingsTab.ts`

**Interfaces:**
- Consumes:
  - `this.plugin.settings.trashRetentionDays: number`
  - `this.plugin.settings.trashCleanupIntervalHours: number`
  - `this.plugin.cleanupTrashNow(): Promise<void>`
  - `this.plugin.restartTrashCleanupTimer(): void`

- [ ] **Step 1: 同步模式下拉新增 sync-delete 選項**

將 `src/ui/SettingsTab.ts` 第 855 行的：

```ts
      { value: "download-only", label: "單向回復 (Download Only / Restore)" },
```

取代為：

```ts
      { value: "download-only", label: "單向回復 (Download Only / Restore)" },
      { value: "sync-delete", label: "備份並同步刪除 (Backup & Sync Delete)" },
```

- [ ] **Step 2: 新增 sync-delete 說明文字**

將 `src/ui/SettingsTab.ts` 第 868-871 行的：

```ts
      } else if (val === "download-only") {
        modeDesc.setText("💡 單向回復：將雲端檔案單向同步下載並覆蓋至本機，不發送本機的任何修改。適合在全新裝置上進行初始還原。");
      } else {
        modeDesc.setText("💡 雙向同步：自動比對本機與雲端的最新異動，將兩端檔案同步至最新狀態。若發生衝突則套用下方的衝突處理策略。");
      }
```

取代為：

```ts
      } else if (val === "download-only") {
        modeDesc.setText("💡 單向回復：將雲端檔案單向同步下載並覆蓋至本機，不發送本機的任何修改。適合在全新裝置上進行初始還原。");
      } else if (val === "sync-delete") {
        modeDesc.setText("💡 備份並同步刪除：上傳本機新增/修改、下載雲端變更，並將本機已刪除的檔案移到雲端垃圾桶（非真刪除）。適合維持本機與雲端鏡像一致。");
      } else {
        modeDesc.setText("💡 雙向同步：自動比對本機與雲端的最新異動，將兩端檔案同步至最新狀態。若發生衝突則套用下方的衝突處理策略。");
      }
```

- [ ] **Step 3: display() 串接垃圾桶設定區塊**

將 `src/ui/SettingsTab.ts` 第 31 行的：

```ts
    this.renderRemoteBaseDirSettings();
```

取代為：

```ts
    this.renderRemoteBaseDirSettings();
    this.renderTrashSettings();
```

- [ ] **Step 4: 新增 renderTrashSettings 方法**

在 `src/ui/SettingsTab.ts` 第 948 行 `renderRemoteBaseDirSettings` 方法結束後、第 950 行 `renderAdvancedSettings` 之前，插入：

```ts
  private renderTrashSettings(): void {
    const { containerEl } = this;

    const section = containerEl.createDiv({ cls: "sync-section" });
    const title = section.createDiv({ cls: "sync-section-title" });
    title.setText("雲端垃圾桶設定");

    const card = section.createDiv({ cls: "sync-card" });

    const desc = card.createDiv({
      cls: "sync-toggle-desc",
      text: "在「備份並同步刪除」模式下，本機刪除的檔案會先搬移到雲端垃圾桶（.sync-trash/），超過保留天數後才會永久清除。",
    });
    desc.style.cssText = "font-size: 12px; color: var(--text-muted); line-height: 1.4; margin-bottom: 12px;";

    this.inputField(card, "垃圾桶保留天數", String(this.plugin.settings.trashRetentionDays), (v) => {
      this.plugin.settings.trashRetentionDays = Math.max(0, parseInt(v) || 0);
      this.plugin.saveSettings();
    }, "預設 30 天", "number");

    this.inputField(card, "垃圾桶清除間隔（小時）", String(this.plugin.settings.trashCleanupIntervalHours), (v) => {
      this.plugin.settings.trashCleanupIntervalHours = Math.max(0, parseInt(v) || 0);
      this.plugin.saveSettings();
      this.plugin.restartTrashCleanupTimer();
    }, "0 = 停用自動清除", "number");

    const btnGroup = card.createDiv();
    btnGroup.style.cssText = "display: flex; gap: 8px; margin-top: 12px;";

    const cleanBtn = btnGroup.createEl("button", {
      cls: "sync-btn sync-btn-secondary",
      text: "立即清除垃圾桶",
    });
    cleanBtn.addEventListener("click", () => {
      cleanBtn.setText("清除中...");
      this.plugin.cleanupTrashNow().finally(() => {
        cleanBtn.setText("立即清除垃圾桶");
      });
    });
  }
```

- [ ] **Step 5: 驗證型別**

Run: `npm run build`
Expected: tsc 無錯誤，esbuild 產出 `main.js`

- [ ] **Step 6: Commit**

```bash
git add src/ui/SettingsTab.ts
git commit -m "feat: add sync-delete mode option and trash settings UI"
```

---

### Task 4: 最終建置驗證

**Files:**
- 無程式碼異動

- [ ] **Step 1: 完整建置**

Run: `npm run build`
Expected: tsc 無錯誤，esbuild 成功產出 `main.js`

- [ ] **Step 2: 檢查 git 狀態**

Run: `git status`
Expected: 無未提交的程式碼異動

- [ ] **Step 3: Obsidian 手動驗證（需使用者操作）**

1. 在 Obsidian 啟用外掛 → 設定 → 同步模式選擇「備份並同步刪除」，確認說明文字顯示正確
2. 開啟「雲端垃圾桶設定」，確認保留天數與清除間隔欄位、立即清除按鈕存在
3. 執行「立即同步」後刪除一個本機檔案，再執行「立即同步」：確認雲端原檔消失、垃圾桶出現 `.sync-trash/<今天>/<檔案>`，且檔案不會被下載回本機
4. 全新雲端（無 manifest）啟用此模式同步：確認雲端既有檔案被下載而非搬移
5. 點「立即清除垃圾桶」：確認未過期檔案保留、手動把保留天數設為 0 後再清除可確認過期檔案被永久刪除
6. 執行指令「清除雲端垃圾桶」，確認可正常觸發

- [ ] **Step 4: Commit（若有 docs 更新）**

```bash
git add -A
git commit -m "chore: sync-delete mode implementation complete"
```

---

## 已知限制

- WebDAV / OneDrive 的 `listFiles` 為非遞迴，垃圾桶清除能見度與現有同步列舉行為一致（沿用既有 Provider 語意）；S3 / Dropbox / Google Drive / Box 為遞迴清單，垃圾桶清除完整可用。
