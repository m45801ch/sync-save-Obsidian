import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface WebDAVConfig {
  url: string;
  username: string;
  password: string;
  path: string;
}

export class WebDAVProvider extends CloudProvider {
  readonly name = "WebDAV";
  readonly icon = "server";

  private config: WebDAVConfig;
  private connected = false;

  constructor(config: WebDAVConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<boolean> {
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
    const url = this.buildUrl(prefix);
    const resp = await this.request("PROPFIND", url);

    if (!resp.ok) throw new Error(`WebDAV list failed: ${resp.status}`);

    const xml = await resp.text();
    const files: { path: string; mtime: number; size: number }[] = [];

    const responseMatch = xml.matchAll(/<D:response>([\s\S]*?)<\/D:response>/g);
    for (const match of responseMatch) {
      const respBlock = match[1];
      const href = respBlock.match(/<D:href>(.*?)<\/D:href>/);
      const isCollection = respBlock.includes("<D:collection") ||
        respBlock.includes("<lp1:collection");
      const lastMod = respBlock.match(/<D:getlastmodified>(.*?)<\/D:getlastmodified>/);
      const contentLength = respBlock.match(/<D:getcontentlength>(.*?)<\/D:getcontentlength>/);

      if (href && !isCollection) {
        let filePath = decodeURIComponent(href[1]);
        const basePath = this.config.path;
        if (filePath.startsWith(basePath)) {
          filePath = filePath.substring(basePath.length).replace(/^\//, "");
        }

        if (filePath) {
          files.push({
            path: filePath,
            mtime: lastMod ? new Date(lastMod[1]).getTime() : Date.now(),
            size: contentLength ? parseInt(contentLength[1]) : 0,
          });
        }
      }
    }

    return files;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const url = this.buildUrl(path);
    const resp = await this.request("GET", url);

    if (!resp.ok) throw new Error(`WebDAV download failed: ${resp.status}`);

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
    const url = this.buildUrl(path);
    const resp = await this.request("PUT", url, content);

    if (!resp.ok && resp.status !== 201 && resp.status !== 204) {
      throw new Error(`WebDAV upload failed: ${resp.status}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const url = this.buildUrl(path);
    const resp = await this.request("DELETE", url);
    if (!resp.ok) throw new Error(`WebDAV delete failed: ${resp.status}`);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const url = this.buildUrl("");
      const resp = await this.request("PROPFIND", url);
      if (resp.ok || resp.status === 207) {
        return { success: true, message: `Connected to ${this.config.url}` };
      }
      return { success: false, message: `Status: ${resp.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    return {
      URL: this.config.url,
      Path: this.config.path,
      Username: this.config.username,
    };
  }

  private buildUrl(path: string): string {
    const base = this.config.url.replace(/\/+$/, "");
    const dir = this.config.path.replace(/^\/+|\/+$/g, "");
    const cleanPath = path.replace(/^\/+/, "");
    return `${base}/${dir}/${cleanPath}`;
  }

  private async request(method: string, url: string, body?: ArrayBuffer): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: "Basic " + btoa(`${this.config.username}:${this.config.password}`),
      "User-Agent": "SyncSave-Obsidian/1.0",
    };

    if (method === "PUT") {
      headers["Content-Type"] = "application/octet-stream";
    }
    if (method === "PROPFIND") {
      headers["Depth"] = "1";
      headers["Content-Type"] = "application/xml";
    }

    return fetch(url, { method, headers, body: body || undefined });
  }
}
