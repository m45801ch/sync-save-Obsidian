# 備份並同步刪除模式 + 雲端垃圾桶清除 — 設計文件

日期：2026-08-16
狀態：已核准

## 目標

在 Sync Save 外掛新增一個同步方向「備份並同步刪除」，當本機檔案被刪除時，一併將雲端檔案移除，使兩邊保持一致。雲端刪除並非真的刪除，而是將資料搬移到雲端垃圾桶資料夾。另外提供可設定的時間與定時器，自動清除雲端垃圾桶中已過期的檔案。

## 範圍

- 新增同步模式 `sync-delete`
- 雲端垃圾桶機制（日期分層資料夾）
- 垃圾桶保留天數設定 + 獨立清除定時器 + 手動清除

## 不納入範圍

- 垃圾桶的「還原」功能（從垃圾桶搬回原路徑）
- Provider 原生垃圾桶 API
- 資料夾層級的刪除同步（僅檔案層級）

## 1. 同步模式「備份並同步刪除」

`syncMode` 新增第四個選項 `sync-delete`（備份並同步刪除）。

行為比較表：

| 狀況 | 處理 |
|------|------|
| 本機有、雲端無 | 上傳 |
| 本機、雲端都有 | 同雙向同步（mtime 比較 + 衝突處理策略）|
| 雲端有、本機無，且在 manifest 中 | 移動到垃圾桶 |
| 雲端有、本機無，不在 manifest 中 | 下載回本機 |

設計要點：雲端有而本機沒有的檔案，需以 `.sync-manifest.json` 判斷是否為「先前同步過、現在本機已刪除」。只有這種情形才搬進垃圾桶；manifest 中不存在的雲端新檔視為雲端新增，下載回本機。這可避免全新裝置上啟用此模式時誤清空整份雲端資料。

## 2. 垃圾桶機制（方案 A：日期資料夾重新上傳）

- 垃圾桶路徑：`.sync-trash/YYYY-MM-DD/<原始相對路徑>`
- 移動流程（`moveToTrash(path)`）：
  1. 下載原檔內容（與既有下載流程相同，包含解密）
  2. 上傳到 `.sync-trash/<今天日期>/<path>`，mtime 設為刪除當下
  3. 刪除雲端原檔
- 上傳前若啟用加密，則沿用既有 `uploadFile` 加密流程，垃圾桶內檔案與一般備份檔格式一致
- `.sync-trash/` 前綴在同步、manifest 中一律排除（`isTrashPath` 檢查），避免被當成一般檔案下載或納入 manifest
- 不修改 `CloudProvider` 介面；所有 Provider 皆可透過既有 `downloadFile` / `uploadFile` / `deleteFile` 完成

## 3. 垃圾桶清除

### 設定

| 設定 | 型別 | 預設 | 說明 |
|------|------|------|------|
| `trashRetentionDays` | number | 30 | 垃圾桶保留天數（單位：天）|
| `trashCleanupIntervalHours` | number | 24 | 獨立清除間隔（單位：小時），0 = 停用 |

### 清除邏輯（`cleanupTrash()`）

1. 呼叫 `provider.listFiles(".sync-trash/")` 列出垃圾桶內所有檔案
2. 依日期資料夾名稱（`YYYY-MM-DD`）分組
3. 對每個日期資料夾，若其日期 < 今天 − 保留天數，則對其中每個檔案執行 `provider.deleteFile`（永久刪除），並嘗試刪除空資料夾（忽略失敗）
4. 若日期格式無法解析，視為安全：不刪除，僅回報/略過

### 清除觸發時機

1. **獨立定時器**：每 `trashCleanupIntervalHours` 小時執行一次（與自動同步間隔無關）
2. **手動**：設定頁「立即清除垃圾桶」按鈕 + 指令「清除雲端垃圾桶」
3. **同步結束後**：在 `sync-delete` 模式同步完成後自動執行一次清除

## 4. 設定 UI（SettingsTab）

- 同步模式下拉新增選項：`sync-delete` = 「備份並同步刪除 (Backup & Sync Delete)」
  - 選中時說明文字：「備份並同步刪除：以本機為鏡像來源，上傳本機新增/修改、下載雲端變更，並將本機已刪除的檔案移到雲端垃圾桶（非真刪除）。」
- 垃圾桶設定區塊：
  - 「垃圾桶保留天數」數字輸入（`trashRetentionDays`）
  - 「垃圾桶清除間隔（小時）」數字輸入（`trashCleanupIntervalHours`，0 = 停用）
  - 「立即清除垃圾桶」按鈕（觸發 `cleanupTrash` 並回報結果）

## 5. 檔案異動總覽

| 檔案 | 異動 |
|------|------|
| `src/sync/SyncService.ts` | 新增 `sync-delete` 分支、`moveToTrash`、`cleanupTrash`、`isTrashPath`、`getTrashDateFolder`；`shouldSkip` 加入垃圾桶排除 |
| `main.ts` | 新增設定欄位、DEFAULT_SETTINGS、獨立清除定時器管理、手動清除指令與清理程序 |
| `src/ui/SettingsTab.ts` | 同步模式下拉新增選項與說明、垃圾桶設定區塊、手動清除按鈕 |
| `src/sync/CloudProvider.ts` | 無修改（方案 A）|

## 6. 錯誤處理

- 移動到垃圾桶任一環節失敗：拋錯並記錄到同步 log，不刪除原檔（維持原狀）
- 清除垃圾桶時個別檔案刪除失敗：記錄錯誤，繼續處理其他檔案
- 垃圾桶路徑無法解析日期：略過不刪除
- 加密啟用時搬移/清除皆沿用既有加解密，無特殊處理

## 7. 測試

- `npm run build`（tsc type check + esbuild）
- 手動測試：
  - `sync-delete` 模式下本機刪除檔案 → 雲端原檔消失、垃圾桶出現日期資料夾與檔案
  - 全新雲端（manifest 不存在）啟用 `sync-delete` → 雲端新檔被下載而非搬移
  - 手動清除 + 定時器清除 → 過期日期資料夾被永久刪除、未過期保留
  - 垃圾桶檔案不會被同步回本機或寫入 manifest
