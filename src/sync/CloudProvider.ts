export interface SyncFile {
  path: string;
  content: ArrayBuffer;
  mtime: number;
  size: number;
}

export interface SyncManifest {
  version: number;
  files: Record<string, { mtime: number; size: number; hash: string }>;
  timestamp: number;
  vaultName: string;
}

export abstract class CloudProvider {
  abstract readonly name: string;
  abstract readonly icon: string;

  abstract connect(): Promise<boolean>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;

  abstract listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]>;
  abstract downloadFile(path: string): Promise<SyncFile>;
  abstract uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void>;
  abstract deleteFile(path: string): Promise<void>;
  abstract testConnection(): Promise<{ success: boolean; message: string }>;

  abstract getSettingsDisplay(): Record<string, string>;
}
