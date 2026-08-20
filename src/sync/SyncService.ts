import { Vault } from "obsidian";
import { CloudProvider, SyncFile, SyncManifest } from "./CloudProvider";
import { Encryption } from "./Encryption";
import {
  buildSyncPlan,
  ConflictStrategy,
  FileSnapshot,
  SyncAction,
  SyncMode,
  SyncPlan,
} from "./SyncPlanner";

const MANIFEST_PATH = ".sync-manifest.json";
const TRASH_ROOT = ".sync-trash";
const CONFLICT_COPY_PATTERN = /\.conflict-\d{4}-\d{2}-\d{2}T/;

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
  providerId?: string;
}

export interface SyncOptions {
  provider: CloudProvider;
  encryption: Encryption;
  vaultName: string;
  syncOnSave: boolean;
  syncInterval: number;
  skipHidden: boolean;
  skipPaths: string[];
  conflictStrategy: ConflictStrategy;
  syncConfig: boolean;
  syncMode?: SyncMode;
  localDeleteDestination?: "system-trash" | "obsidian-trash";
  largeChangeThreshold?: number;
  trashRetentionDays?: number;
}

interface LocalFileSnapshot extends FileSnapshot {
  content: () => Promise<ArrayBuffer>;
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
  private plannedLocal = new Map<string, LocalFileSnapshot>();
  private plannedRemote = new Map<string, FileSnapshot>();

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
      if (!await this.provider.connect()) {
        throw new Error("Failed to connect to cloud provider");
      }

      const plan = await this.createPlan();
      this.emit({
        type: "sync-progress",
        message: `Planned ${plan.actions.length} sync actions`,
        progress: { current: 0, total: plan.actions.length },
      });
      const percentage = plan.comparableExistingPathCount === 0
        ? 0
        : (plan.destructivePathCount / plan.comparableExistingPathCount) * 100;
      const threshold = this.options.largeChangeThreshold;
      if (threshold && threshold > 0 && threshold < 100 && percentage > threshold) {
        const actionCounts = plan.actions.reduce((counts, action) => {
          counts[action.type] = (counts[action.type] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>);
        const actions = Object.entries(actionCounts).map(([type, count]) => `${type}=${count}`).join(", ");
        this.emit({
          type: "sync-error",
          message: `同步未執行：大量變更保護已阻擋 ${plan.destructivePathCount} 個破壞性動作（${plan.comparableExistingPathCount} 個既有檔案中的 ${percentage.toFixed(1)}%）。動作：${actions}`,
        });
        return;
      }
      await this.executePlan(plan);

      if (this.getSyncMode() === "upload-delete") await this.cleanupTrash();

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

  async createPlan(): Promise<SyncPlan> {
    const listedRemote = await this.provider.listFiles("");
    const listedManifest = listedRemote.find((file) => file.path === MANIFEST_PATH);
    const remote = listedRemote.filter((file) =>
      file.path !== MANIFEST_PATH && !this.isTrashPath(file.path) && !this.shouldSkip(file.path),
    );
    const local = await this.getLocalFiles();
    const manifest = await this.loadManifest(listedManifest);
    const manifestFiles = manifest?.files ?? {};
    const localByPath = new Map(local.map((file) => [file.path, file]));
    const remoteByPath = new Map(remote.map((file) => [file.path, file]));

    for (const file of local) {
      if (!remoteByPath.has(file.path)) continue;
      const previous = manifestFiles[file.path];
      if (previous && previous.localMtime === file.mtime && previous.size === file.size) {
        file.hash = previous.hash;
      } else {
        file.hash = await Encryption.hashFile(await file.content());
      }
    }

    const remoteSnapshots: FileSnapshot[] = [];
    for (const file of remote) {
      const snapshot: FileSnapshot = { ...file };
      if (localByPath.has(file.path)) {
        const previous = manifestFiles[file.path];
        if (previous && previous.remoteMtime === file.mtime && (previous.remoteSize ?? previous.size) === file.size) {
          snapshot.hash = previous.hash;
        } else {
          const downloaded = await this.downloadRemoteBodyVerified(file.path, file.size);
          snapshot.hash = await Encryption.hashFile(await this.decryptOrThrow(downloaded.content));
        }
      }
      remoteSnapshots.push(snapshot);
    }

    this.plannedLocal = localByPath;
    this.plannedRemote = new Map(remoteSnapshots.map((file) => [file.path, file]));

    return buildSyncPlan({
      local,
      remote: remoteSnapshots,
      manifestFiles,
      mode: this.getSyncMode(),
      conflictStrategy: this.options.conflictStrategy,
      now: new Date(),
    });
  }

  static async findConflictCopies(vault: Vault): Promise<string[]> {
    return vault.getFiles()
      .map((file) => file.path)
      .filter((path) => CONFLICT_COPY_PATTERN.test(path));
  }

  async findConflictCopies(): Promise<string[]> {
    return SyncService.findConflictCopies(this.vault);
  }

  async executePlan(plan: SyncPlan): Promise<void> {
    const order: Record<SyncAction["type"], number> = {
      "create-conflict-copy": 0,
      upload: 1,
      download: 1,
      "move-remote-to-trash": 2,
      "delete-local": 2,
      skip: 3,
    };
    const actions = plan.actions
      .map((action, index) => ({ action, index }))
      .sort((left, right) => order[left.action.type] - order[right.action.type] || left.index - right.index)
      .map(({ action }) => action);

    let current = 0;
    for (const action of actions) {
      await this.executeAction(action);
      current++;
      this.emit({
        type: "sync-file",
        message: `${action.type}: ${action.path}`,
        file: action.path,
        progress: { current, total: actions.length },
      });
    }

    await this.saveManifest();
  }

  private async executeAction(action: SyncAction): Promise<void> {
    if (action.type === "skip") return;

    if (action.type === "create-conflict-copy") {
      if (!action.targetPath) throw new Error(`missing conflict target: ${action.path}`);
      this.emit({ type: "conflict", message: `Conflict detected: ${action.path}`, file: action.path });
      if (action.source === "local") {
        const local = this.requireLocal(action.path);
        await this.writeVerifiedToPath(action.targetPath, await local.content());
      } else {
        const remote = this.requireRemote(action.path);
        await this.downloadVerifiedToPath(action.path, action.targetPath, remote.size);
      }
      return;
    }

    if (action.type === "upload") {
      const local = this.requireLocal(action.path);
      await this.uploadContent(action.path, await local.content(), local.mtime);
      return;
    }

    if (action.type === "download") {
      const remote = this.requireRemote(action.path);
      await this.downloadVerifiedToPath(action.path, action.path, remote.size);
      return;
    }

    if (action.type === "move-remote-to-trash") {
      const remote = this.requireRemote(action.path);
      await this.moveToTrash(action.path, remote.size);
      return;
    }

    if (this.options.localDeleteDestination === "obsidian-trash") {
      await this.vault.adapter.trashLocal(action.path);
    } else {
      await this.vault.adapter.trashSystem(action.path);
    }
  }

  private requireLocal(path: string): LocalFileSnapshot {
    const file = this.plannedLocal.get(path);
    if (!file) throw new Error(`missing planned local file: ${path}`);
    return file;
  }

  private requireRemote(path: string): FileSnapshot {
    const file = this.plannedRemote.get(path);
    if (!file) throw new Error(`missing planned remote file: ${path}`);
    return file;
  }

  private getSyncMode(): SyncMode {
    const mode = this.options.syncMode as SyncMode | "sync-delete" | undefined;
    return mode === "sync-delete" ? "upload-delete" : mode ?? "bidirectional";
  }

  private async getLocalFiles(): Promise<LocalFileSnapshot[]> {
    const files: LocalFileSnapshot[] = [];
    for (const file of this.vault.getFiles()) {
      if (this.shouldSkip(file.path)) continue;
      const stat = await this.vault.adapter.stat(file.path);
      if (!stat) continue;
      files.push({
        path: file.path,
        mtime: stat.mtime,
        size: stat.size,
        content: () => this.vault.readBinary(file),
      });
    }
    return files;
  }

  private shouldSkip(path: string): boolean {
    const segments = path.replace(/\\/g, "/").split("/");
    for (const segment of segments) {
      if (this.options.skipHidden && segment.startsWith(".")) return true;
      if (segment.startsWith("_") && !this.options.syncConfig) return true;
    }
    if (this.isTrashPath(path)) return true;
    if (path.startsWith(".obsidian/") && !this.options.syncConfig) return true;
    return this.options.skipPaths.some((pattern) => path.match(pattern));
  }

  private async loadManifest(listedManifest?: FileSnapshot): Promise<SyncManifest | null> {
    if (!listedManifest) return null;

    const raw = await this.downloadRemoteBodyVerified(MANIFEST_PATH, listedManifest.size);
    const data = await this.decryptOrThrow(raw.content);
    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder().decode(data));
    } catch (error) {
      throw new Error(`invalid sync manifest: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid sync manifest");
    }
    if (parsed.version === 1) {
      return {
        version: 2,
        files: {},
        timestamp: parsed.timestamp,
        vaultName: parsed.vaultName,
      };
    }
    if (parsed.version !== 2 || !parsed.files || typeof parsed.files !== "object" || Array.isArray(parsed.files)) {
      throw new Error("invalid sync manifest");
    }
    for (const [path, entry] of Object.entries(parsed.files)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !Number.isFinite((entry as any).localMtime) ||
        !Number.isFinite((entry as any).remoteMtime) ||
        !Number.isFinite((entry as any).size) ||
        (entry as any).remoteSize !== undefined && !Number.isFinite((entry as any).remoteSize) ||
        typeof (entry as any).hash !== "string"
      ) {
        throw new Error(`invalid sync manifest entry: ${path}`);
      }
    }
    return parsed as SyncManifest;
  }

  private async uploadContent(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    const data = this.encryption.isEnabled() ? await this.encryption.encrypt(content) : content;
    await this.provider.uploadFile(path, data, mtime);
  }

  private async downloadRemoteBodyVerified(path: string, expectedSize: number): Promise<SyncFile> {
    const remote = await this.provider.downloadFile(path);
    if (remote.content.byteLength !== expectedSize || remote.size !== expectedSize) {
      throw new Error(`download size mismatch: ${path}`);
    }
    return remote;
  }

  private async decryptOrThrow(content: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.encryption.isEnabled()) return content;
    const decrypted = await this.encryption.decrypt(content);
    if (!decrypted) throw new Error("decryption failed");
    return decrypted;
  }

  private async downloadVerifiedToPath(remotePath: string, localPath: string, expectedSize: number): Promise<void> {
    const remote = await this.downloadRemoteBodyVerified(remotePath, expectedSize);
    await this.writeVerifiedToPath(localPath, await this.decryptOrThrow(remote.content));
  }

  private async writeVerifiedToPath(path: string, data: ArrayBuffer): Promise<void> {
    await this.ensureParentFolder(path);
    const tempPath = `${path}.sync-save-tmp-${Date.now()}`;
    try {
      await this.vault.createBinary(tempPath, data);
      const tempStat = await this.vault.adapter.stat(tempPath);
      if (!tempStat || tempStat.size !== data.byteLength) {
        throw new Error(`temporary write mismatch: ${path}`);
      }
      await this.replacePathAtomically(tempPath, path);
    } catch (error) {
      if (await this.vault.adapter.exists(tempPath)) await this.vault.adapter.remove(tempPath);
      throw error;
    }
  }

  private async replacePathAtomically(tempPath: string, targetPath: string): Promise<void> {
    try {
      await this.vault.adapter.rename(tempPath, targetPath);
    } catch (error) {
      if (await this.vault.adapter.exists(tempPath)) await this.vault.adapter.remove(tempPath);
      throw error;
    }
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const slash = path.lastIndexOf("/");
    if (slash < 0) return;
    const directory = path.slice(0, slash);
    if (!await this.vault.adapter.exists(directory) && !this.vault.getAbstractFileByPath(directory)) {
      await this.vault.createFolder(directory);
    }
  }

  private isTrashPath(path: string): boolean {
    return path === TRASH_ROOT || path.startsWith(`${TRASH_ROOT}/`);
  }

  private getTrashDateFolder(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  private async moveToTrash(path: string, expectedSize: number): Promise<void> {
    const remote = await this.downloadRemoteBodyVerified(path, expectedSize);
    const trashPath = `${TRASH_ROOT}/${this.getTrashDateFolder()}/${path}`;
    await this.provider.uploadFile(trashPath, remote.content, remote.mtime);
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
    for (const file of trashFiles) {
      if (!this.isTrashPath(file.path)) continue;
      const segments = file.path.split("/");
      if (segments.length < 2) continue;
      const dateTimestamp = new Date(`${segments[1]}T00:00:00`).getTime();
      if (isNaN(dateTimestamp)) continue;
      if (dateTimestamp < cutoff) toDelete.push(file.path);
    }

    for (const path of toDelete) {
      try {
        await this.provider.deleteFile(path);
        this.emit({ type: "sync-file", message: `已清除垃圾桶檔案：${path}` });
      } catch (error) {
        this.emit({
          type: "sync-error",
          message: `清除垃圾桶失敗：${path} (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
  }

  private async saveManifest(): Promise<void> {
    const local = await this.getLocalFiles();
    const remote = (await this.provider.listFiles(""))
      .filter((file) => file.path !== MANIFEST_PATH && !this.isTrashPath(file.path));
    const remoteByPath = new Map(remote.map((file) => [file.path, file]));
    const files: SyncManifest["files"] = {};

    for (const localFile of local) {
      const remoteFile = remoteByPath.get(localFile.path);
      if (!remoteFile) continue;
      files[localFile.path] = {
        localMtime: localFile.mtime,
        remoteMtime: remoteFile.mtime,
        size: localFile.size,
        remoteSize: remoteFile.size,
        hash: await Encryption.hashFile(await localFile.content()),
      };
    }

    const manifest: SyncManifest = {
      version: 2,
      files,
      timestamp: Date.now(),
      vaultName: this.options.vaultName,
    };
    const content = new TextEncoder().encode(JSON.stringify(manifest)).buffer;
    await this.uploadContent(MANIFEST_PATH, content, manifest.timestamp);
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
