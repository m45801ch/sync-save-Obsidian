# 整理本地資料庫 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with checkpoints.

**Goal:** 新增僅掃描本地 Vault 並將重複的 `public/` 檔案移入回收桶的同步模式。

**Architecture:** 以純函式掃描器分析所有本地檔案相對路徑；`SyncService` 對新模式走獨立本機流程，完全跳過雲端 provider 與 manifest。設定 UI 將新模式加入既有同步方向選單，並沿用同步摘要事件。

**Tech Stack:** TypeScript、Obsidian Vault adapter、Vitest、esbuild。

## Global Constraints

- 新模式的值固定為 `local-cleanup`。
- 僅移動 `public/` 或 `public/` 子資料夾中的檔案。
- 非 `public/` 檔案不得被移動、刪除或覆寫。
- 一律使用既有本機回收桶設定，不永久刪除。
- 新模式不得呼叫 provider connect、disconnect、list、upload、download 或 delete。

---

### Task 1: 建立本機重複掃描器

**Files:**
- Create: `src/sync/LocalDatabaseCleanup.ts`
- Test: `src/sync/LocalDatabaseCleanup.test.ts`

**Interfaces:**
- Produces `findDuplicatePublicPaths(paths: string[]): string[]`。

- [ ] **Step 1: Write the failing test**

測試四個規則：所有路徑可遞迴輸入；以 basename 判斷；只回傳 public 路徑；沒有同名不回傳。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/sync/LocalDatabaseCleanup.test.ts`

Expected: FAIL because `LocalDatabaseCleanup.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

建立 basename 分組，對每組確認存在至少一個非 `public/` 路徑，再回傳所有 `public/` 或 `public/.../` 路徑；使用 `/` 正規化 Windows 分隔符。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/sync/LocalDatabaseCleanup.test.ts`

Expected: all scanner tests PASS。

### Task 2: 接入本機同步模式

**Files:**
- Modify: `src/sync/SyncPlanner.ts`
- Modify: `src/sync/SyncService.ts`
- Test: `src/sync/SyncService.test.ts`

**Interfaces:**
- `SyncMode` gains `local-cleanup`。
- `SyncService.sync()` detects `local-cleanup` before provider connection and calls a private local cleanup method。

- [ ] **Step 1: Write the failing service test**

建立包含 `public/note.md` 與 `Projects/note.md` 的 vault，執行 `local-cleanup`，驗證 `trashSystem:public/note.md` 被呼叫、分類檔仍存在、provider calls 為空，並驗證摘要數量。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run src/sync/SyncService.test.ts`

Expected: FAIL because `local-cleanup` is not a valid mode and sync still connects to provider。

- [ ] **Step 3: Write minimal implementation**

加入模式型別；在 `sync()` 啟動事件後，若模式為 `local-cleanup`，建立本機摘要、掃描 `vault.getFiles()`、逐一使用設定回收桶移動 public 檔、發送 `sync-file` 與 `sync-summary`，最後結束，不執行 provider 連線與 manifest。

- [ ] **Step 4: Run focused and regression tests**

Run: `npm test -- --run src/sync/SyncService.test.ts`

Expected: all SyncService tests PASS。

### Task 3: 加入設定選項與文檔

**Files:**
- Modify: `src/ui/SettingsTab.ts`
- Modify: `main.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: `src/ui/SettingsTab.test.ts` only if existing UI test helpers support select options

- [ ] **Step 1: Add the new option**

在同步方向 options 加入 `{ value: "local-cleanup", label: "整理本地資料庫（僅本機）" }`，並更新說明文字，明確表示不連線雲端、只移動 public 同名檔。

- [ ] **Step 2: Preserve existing settings behavior**

確保刪除目的地與同步模式顯示邏輯不會把 local-cleanup 誤判成雲端刪除模式。

- [ ] **Step 3: Document the mode**

在 README 與 CHANGELOG 說明掃描範圍、basename 比對、public 回收與非 public 保留規則。

### Task 4: 驗證與交付準備

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `main.js`

- [ ] **Step 1: Run full verification**

Run: `npm test -- --run; npm run build; git diff --check`

Expected: all tests PASS, build succeeds, no whitespace errors。

- [ ] **Step 2: Commit**

Run: `git add ...; git commit -m "feat: add local database cleanup mode"`
