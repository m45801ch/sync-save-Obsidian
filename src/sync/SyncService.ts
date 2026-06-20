import { CloudProvider, SyncFile, SyncManifest } from "./CloudProvider";
import { Encryption } from "./Encryption";
import { App, TFile, TFolder, Vault, Notice } from "obsidian";

export type SyncEventType =
  | "sync-start"
  | "sync-progress"
  | "sync-complete"
  | "sync-error"
  | "sync-file"
  | "conflict";

export interface SyncEvent {
  type: SyncEventType;
  message: string;
  progress?: { current: number; total: number };
  file?: string;
}

export interface SyncOptions {
  provider: CloudProvider;
  encryption: Encryption;
  vaultName: string;
  syncOnSave: boolean;
  syncInterval: number;
  skipHidden: boolean;
  skipPaths: string[];
  conflictStrategy: "keep-newer" | "keep-larger" | "ask" | "smart";
  syncConfig: boolean;
  syncMode?: "bidirectional" | "upload-only" | "download-only";
}

type SyncListener = (event: SyncEvent) => void;

export class SyncService {
  private provider: CloudProvider;
  private encryption: Encryption;
  private options: SyncOptions;
  private isSyncing = false;
  private listeners: SyncListener[] = [];
  private lastSyncTime = 0;
  private syncTimer: number | null = null;
  private vault: Vault;

  constructor(vault: Vault, options: SyncOptions) {
    this.vault = vault;
    this.options = options;
    this.provider = options.provider;
    this.encryption = options.encryption;
  }

  on(event: SyncListener): void {
    this.listeners.push(event);
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  getProvider(): CloudProvider {
    return this.provider;
  }

  isActive(): boolean {
    return this.isSyncing;
  }

  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  async sync(): Promise<void> {
    if (this.isSyncing) {
      this.emit({ type: "sync-error", message: "Sync already in progress" });
      return;
    }

    this.isSyncing = true;
    this.emit({ type: "sync-start", message: "Starting sync..." });

    try {
      const connected = await this.provider.connect();
      if (!connected) {
        throw new Error("Failed to connect to cloud provider");
      }

      const localFiles = await this.getLocalFiles();
      const remoteFiles = await this.provider.listFiles("");
      const manifest = await this.loadManifest();

      const mode = this.options.syncMode || "bidirectional";

      if (mode === "upload-only") {
        this.emit({
          type: "sync-progress",
          message: `單向備份開始（僅上傳）`,
          progress: { current: 0, total: localFiles.length },
        });

        const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
        let processed = 0;
        for (const localFile of localFiles) {
          processed++;
          const remoteFile = remoteMap.get(localFile.path);
          if (!remoteFile || localFile.stat.mtime > remoteFile.mtime) {
            await this.uploadFile(localFile.path, localFile);
            this.emit({
              type: "sync-file",
              message: `已備份上傳：${localFile.path}`,
              file: localFile.path,
              progress: { current: processed, total: localFiles.length },
            });
          }
        }
      } else if (mode === "download-only") {
        this.emit({
          type: "sync-progress",
          message: `單向還原開始（僅下載）`,
          progress: { current: 0, total: remoteFiles.length },
        });

        const localMap = new Map(localFiles.map((f) => [f.path, f]));
        let processed = 0;
        for (const remoteFile of remoteFiles) {
          if (remoteFile.path === ".sync-manifest.json") continue;
          if (this.shouldSkip(remoteFile.path)) continue;
          processed++;
          const localFile = localMap.get(remoteFile.path);
          if (!localFile || remoteFile.mtime > localFile.stat.mtime) {
            await this.downloadFile(remoteFile.path);
            this.emit({
              type: "sync-file",
              message: `已下載還原：${remoteFile.path}`,
              file: remoteFile.path,
              progress: { current: processed, total: remoteFiles.length },
            });
          }
        }
      } else {
        this.emit({
          type: "sync-progress",
          message: `Found ${localFiles.length} local files, ${remoteFiles.length} remote files`,
          progress: { current: 0, total: localFiles.length + remoteFiles.length },
        });

        const remoteMap = new Map(remoteFiles.map((f) => [f.path, f]));
        const localMap = new Map(localFiles.map((f) => [f.path, f]));

        let processed = 0;
        const total = localFiles.length + remoteFiles.length;

        for (const [localPath, localFile] of localMap) {
          const remoteFile = remoteMap.get(localPath);
          processed++;

          if (!remoteFile) {
            await this.uploadFile(localPath, localFile);
            this.emit({
              type: "sync-file",
              message: `Uploaded: ${localPath}`,
              file: localPath,
              progress: { current: processed, total },
            });
          } else {
            const manifestFile = manifest?.files[localPath];
            const lastMtime = manifestFile ? manifestFile.mtime : (manifest?.timestamp || 0);

            const localChanged = localFile.stat.mtime > lastMtime;
            const remoteChanged = remoteFile.mtime > lastMtime;

            const isConflict = manifest !== null && localChanged && remoteChanged && localFile.stat.size !== remoteFile.size;

            if (isConflict) {
              this.emit({
                type: "conflict",
                message: `Conflict detected: ${localPath}`,
                file: localPath,
              });

              const strategy = this.options.conflictStrategy;
              if (strategy === "keep-larger") {
                if (localFile.stat.size > remoteFile.size) {
                  await this.uploadFile(localPath, localFile);
                  this.emit({ type: "sync-file", message: `Conflict resolved (larger wins): Uploaded ${localPath}`, file: localPath });
                } else {
                  await this.downloadFile(localPath);
                  this.emit({ type: "sync-file", message: `Conflict resolved (larger wins): Downloaded ${localPath}`, file: localPath });
                }
              } else if (strategy === "smart") {
                const extIdx = localPath.lastIndexOf(".");
                const base = extIdx !== -1 ? localPath.substring(0, extIdx) : localPath;
                const ext = extIdx !== -1 ? localPath.substring(extIdx) : "";
                const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                const conflictPath = `${base}.conflict-${timestamp}${ext}`;

                await this.downloadFileToPath(localPath, conflictPath);
                await this.uploadFile(localPath, localFile);

                this.emit({
                  type: "sync-file",
                  message: `智慧合併：本機與雲端皆被修改，已將雲端版本存為副本：${conflictPath}`,
                  file: localPath,
                });
              } else {
                if (localFile.stat.mtime > remoteFile.mtime) {
                  await this.uploadFile(localPath, localFile);
                  this.emit({ type: "sync-file", message: `Conflict resolved (newer wins): Uploaded ${localPath}`, file: localPath });
                } else {
                  await this.downloadFile(localPath);
                  this.emit({ type: "sync-file", message: `Conflict resolved (newer wins): Downloaded ${localPath}`, file: localPath });
                }
              }
            } else if (localFile.stat.mtime > remoteFile.mtime) {
              await this.uploadFile(localPath, localFile);
              this.emit({
                type: "sync-file",
                message: `Updated: ${localPath}`,
                file: localPath,
                progress: { current: processed, total },
              });
            } else if (localFile.stat.mtime < remoteFile.mtime) {
              await this.downloadFile(localPath);
              this.emit({
                type: "sync-file",
                message: `Downloaded: ${localPath}`,
                file: localPath,
                progress: { current: processed, total },
              });
            }
          }
        }

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
      }

      const updatedLocalFiles = await this.getLocalFiles();
      await this.saveManifest(updatedLocalFiles);

      this.lastSyncTime = Date.now();
      this.emit({ type: "sync-complete", message: "Sync completed successfully" });
    } catch (error) {
      this.emit({
        type: "sync-error",
        message: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.isSyncing = false;
      try {
        await this.provider.disconnect();
      } catch {}
    }
  }

  private async getLocalFiles(): Promise<{ path: string; stat: { mtime: number; size: number }; content: ArrayBuffer }[]> {
    const files: { path: string; stat: { mtime: number; size: number }; content: ArrayBuffer }[] = [];
    const allFiles = this.vault.getFiles();

    for (const file of allFiles) {
      if (this.shouldSkip(file.path)) continue;

      const stat = await this.vault.adapter.stat(file.path);
      if (!stat) continue;

      const content = await this.vault.readBinary(file);
      files.push({
        path: file.path,
        stat: { mtime: stat.mtime, size: stat.size },
        content,
      });
    }

    return files;
  }

  private shouldSkip(path: string): boolean {
    const segments = path.replace(/\\/g, "/").split("/");
    for (const seg of segments) {
      if (this.options.skipHidden && seg.startsWith(".")) return true;
      if (seg.startsWith("_") && !this.options.syncConfig) return true;
    }
    if (path.startsWith(".obsidian/") && !this.options.syncConfig) return true;
    for (const pattern of this.options.skipPaths) {
      if (path.match(pattern)) return true;
    }
    return false;
  }

  private async loadManifest(): Promise<SyncManifest | null> {
    try {
      const raw = await this.provider.downloadFile(".sync-manifest.json");
      if (!raw) return null;

      let data: ArrayBuffer = raw.content;
      if (this.encryption.isEnabled()) {
        const decrypted = await this.encryption.decrypt(data);
        if (!decrypted) return null;
        data = decrypted;
      }

      const decoder = new TextDecoder();
      return JSON.parse(decoder.decode(data));
    } catch {
      return null;
    }
  }

  private async uploadFile(path: string, file: { content: ArrayBuffer; stat: { mtime: number } }): Promise<void> {
    let data = file.content;
    if (this.encryption.isEnabled()) {
      data = await this.encryption.encrypt(data);
    }
    await this.provider.uploadFile(path, data, file.stat.mtime);
  }

  private async downloadFile(path: string): Promise<void> {
    await this.downloadFileToPath(path, path);
  }

  private async downloadFileToPath(remotePath: string, localPath: string): Promise<void> {
    let remote = await this.provider.downloadFile(remotePath);
    if (!remote) return;

    let data = remote.content;
    if (this.encryption.isEnabled()) {
      const decrypted = await this.encryption.decrypt(data);
      if (decrypted) data = decrypted;
    }

    const dir = localPath.substring(0, localPath.lastIndexOf("/"));
    if (dir) {
      const dirExists = await this.vault.adapter.exists(dir);
      if (!dirExists) {
        const existingDir = this.vault.getAbstractFileByPath(dir);
        if (!existingDir) {
          await this.vault.createFolder(dir);
        }
      }
    }

    const fileExists = await this.vault.adapter.exists(localPath);
    if (fileExists) {
      const existing = this.vault.getAbstractFileByPath(localPath);
      if (existing instanceof TFile) {
        await this.vault.modifyBinary(existing, data);
      } else {
        await this.vault.adapter.writeBinary(localPath, data);
      }
    } else {
      await this.vault.createBinary(localPath, data);
    }
  }

  private async saveManifest(localFiles: { path: string; stat: { mtime: number; size: number } }[]): Promise<void> {
    const filesRecord: Record<string, { mtime: number; size: number; hash: string }> = {};
    for (const file of localFiles) {
      filesRecord[file.path] = {
        mtime: file.stat.mtime,
        size: file.stat.size,
        hash: "",
      };
    }
    const manifest: SyncManifest = {
      version: 1,
      files: filesRecord,
      timestamp: Date.now(),
      vaultName: this.vault.getName(),
    };

    const encoder = new TextEncoder();
    let data = encoder.encode(JSON.stringify(manifest)).buffer;
    if (this.encryption.isEnabled()) {
      const encrypted = await this.encryption.encrypt(data);
      if (encrypted) data = encrypted;
    }
    await this.provider.uploadFile(".sync-manifest.json", data, Date.now());
  }

  startAutoSync(): void {
    if (this.options.syncInterval <= 0) return;

    this.syncTimer = window.setInterval(() => {
      this.sync();
    }, this.options.syncInterval * 60 * 1000);
  }

  stopAutoSync(): void {
    if (this.syncTimer !== null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }
}
