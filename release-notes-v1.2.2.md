## Sync Save v1.2.2

### 同名檔案清理與同步摘要

- 雙向同步、增量拉取與增量拉取帶刪除會偵測新加入 `public/` 的檔案。
- 若其他資料夾已有相同檔名，保留分類檔，並將 `public/` 檔案移至設定的本機回收桶。
- 雲端的同名 `public/` 檔案移至 `.sync-trash/`，避免重複下載。
- 同步完成或被大量變更保護阻擋後，顯示同步數量、成功數量、失敗數量與丟入回收桶數量。

### 安裝

下載 release assets 中的 `main.js`、`manifest.json`、`styles.css`，以及方便安裝的 `sync-save-release.zip`，放入 `.obsidian/plugins/sync-save/` 後重新載入外掛。
