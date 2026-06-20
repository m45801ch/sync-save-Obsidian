import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface DropboxConfig {
  accessToken: string;
  refreshToken?: string;
  appFolder: boolean;
}

export class DropboxProvider extends CloudProvider {
  readonly name = "Dropbox";
  readonly icon = "droplet";

  private config: DropboxConfig;
  private connected = false;

  constructor(config: DropboxConfig) {
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

  async listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    const path = this.config.appFolder ? "" : `/${prefix}`;
    const body = { path: path || "", recursive: true, include_media_info: false };

    const resp = await this.request("https://api.dropboxapi.com/2/files/list_folder", body);
    if (!resp.ok) throw new Error(`Dropbox list failed: ${resp.status}`);

    const data = await resp.json();
    const files: { path: string; mtime: number; size: number }[] = [];

    for (const entry of data.entries || []) {
      if (entry[".tag"] !== "file") continue;
      const filePath = entry.path_lower?.replace(/^\//, "") || "";
      if (filePath.startsWith(prefix.replace(/^\//, ""))) {
        files.push({
          path: filePath,
          mtime: new Date(entry.server_modified || entry.client_modified).getTime(),
          size: entry.size || 0,
        });
      }
    }

    return files;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const dropboxPath = this.config.appFolder ? `/${path}` : `/${path}`;

    const resp = await this.request(
      "https://content.dropboxapi.com/2/files/download",
      undefined,
      { "Dropbox-API-Arg": JSON.stringify({ path: dropboxPath }) }
    );

    if (!resp.ok) throw new Error(`Dropbox download failed: ${resp.status}`);

    const content = await resp.arrayBuffer();
    const apiResult = JSON.parse(resp.headers.get("dropbox-api-result") || "{}");

    return {
      path,
      content,
      mtime: new Date(apiResult.server_modified || apiResult.client_modified).getTime(),
      size: content.byteLength,
    };
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    const dropboxPath = this.config.appFolder ? `/${path}` : `/${path}`;

    const resp = await this.request(
      "https://content.dropboxapi.com/2/files/upload",
      content,
      {
        "Dropbox-API-Arg": JSON.stringify({
          path: dropboxPath,
          mode: "overwrite",
          mute: true,
        }),
        "Content-Type": "application/octet-stream",
      }
    );

    if (!resp.ok) throw new Error(`Dropbox upload failed: ${resp.status}`);
  }

  async deleteFile(path: string): Promise<void> {
    const dropboxPath = this.config.appFolder ? `/${path}` : `/${path}`;
    const resp = await this.request("https://api.dropboxapi.com/2/files/delete_v2", {
      path: dropboxPath,
    });
    if (!resp.ok) throw new Error(`Dropbox delete failed: ${resp.status}`);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const resp = await this.request(
        "https://api.dropboxapi.com/2/users/get_current_account",
        null
      );
      if (resp.ok) {
        const data = await resp.json();
        return { success: true, message: `Connected as ${data.email || data.name?.display_name || "user"}` };
      }
      return { success: false, message: `Status: ${resp.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    return {
      Type: this.config.appFolder ? "App Folder" : "Full Dropbox",
      Token: `${this.config.accessToken.substring(0, 8)}...`,
    };
  }

  private async request(url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      ...extraHeaders,
    };

    if (body && !extraHeaders?.["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    return fetch(url, {
      method: "POST",
      headers,
      body: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined,
    });
  }
}
