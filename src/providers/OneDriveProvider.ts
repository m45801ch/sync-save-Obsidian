import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface OneDriveConfig {
  accessToken: string;
  useAppFolder: boolean;
}

export class OneDriveProvider extends CloudProvider {
  readonly name = "OneDrive";
  readonly icon = "cloud";

  private config: OneDriveConfig;
  private connected = false;

  constructor(config: OneDriveConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<boolean> {
    if (!this.config.accessToken) return false;
    const result = await this.testConnection();
    this.connected = result.success;
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private get basePath(): string {
    return this.config.useAppFolder
      ? "/drive/special/approot"
      : "/drive/root";
  }

  async listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    const url = `https://graph.microsoft.com/v1.0/me${this.basePath}:/${prefix}:/children`;
    const files: { path: string; mtime: number; size: number }[] = [];
    let nextUrl: string | null = url;

    while (nextUrl) {
      const resp: Response = await this.request("GET", nextUrl);
      if (!resp.ok) throw new Error(`OneDrive list failed: ${resp.status}`);

      const data: any = await resp.json();

      for (const item of data.value || []) {
        if (item.folder) continue;
        files.push({
          path: item.name,
          mtime: new Date(item.lastModifiedDateTime).getTime(),
          size: item.size || 0,
        });
      }

      nextUrl = data["@odata.nextLink"] || null;
    }

    return files;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const url = `https://graph.microsoft.com/v1.0/me${this.basePath}:/${path}:/content`;
    const resp: Response = await this.request("GET", url);

    if (!resp.ok) throw new Error(`OneDrive download failed: ${resp.status}`);

    const content = await resp.arrayBuffer();
    const mtime = resp.headers.get("last-modified");

    return {
      path,
      content,
      mtime: mtime ? new Date(mtime).getTime() : Date.now(),
      size: content.byteLength,
    };
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    const url = `https://graph.microsoft.com/v1.0/me${this.basePath}:/${path}:/content`;
    const resp: Response = await this.request("PUT", url, content);

    if (!resp.ok && resp.status !== 201 && resp.status !== 200) {
      throw new Error(`OneDrive upload failed: ${resp.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const url = `https://graph.microsoft.com/v1.0/me${this.basePath}:/${path}`;
    const resp: Response = await this.request("DELETE", url);
    if (!resp.ok) throw new Error(`OneDrive delete failed: ${resp.status}`);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const resp: Response = await this.request("GET", "https://graph.microsoft.com/v1.0/me");
      if (resp.ok) {
        const data = await resp.json();
        return { success: true, message: `Connected as ${data.userPrincipalName || data.displayName || "user"}` };
      }
      return { success: false, message: `Status: ${resp.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    return {
      Mode: this.config.useAppFolder ? "App Folder" : "Full OneDrive",
    };
  }

  private async request(method: string, url: string, body?: ArrayBuffer): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
    };

    if (body || method === "PUT") {
      headers["Content-Type"] = "application/octet-stream";
    }

    return fetch(url, { method, headers, body: body || undefined });
  }
}
