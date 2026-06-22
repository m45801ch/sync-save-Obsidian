import { requestUrl, RequestUrlResponse } from "obsidian";
import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface WebDAVConfig {
  url: string;
  username: string;
  password: string;
  path: string;
}

class RequestUrlResponseWrapper {
  constructor(private res: RequestUrlResponse) {}
  get ok() {
    return this.res.status >= 200 && this.res.status < 300;
  }
  get status() {
    return this.res.status;
  }
  get headers() {
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(this.res.headers)) {
      map.set(k.toLowerCase(), v);
    }
    return {
      get: (name: string) => map.get(name.toLowerCase()) || null
    };
  }
  async text() {
    if (typeof this.res.text === "string") {
      return this.res.text;
    }
    // Fallback if text is not directly string (unlikely for requestUrl)
    return new TextDecoder().decode(this.res.arrayBuffer);
  }
  async arrayBuffer() {
    return this.res.arrayBuffer;
  }
}

export class WebDAVProvider extends CloudProvider {
  readonly name = "WebDAV";
  readonly icon = "server";

  private config: WebDAVConfig;
  private connected = false;
  private remoteDir: string;

  constructor(config: WebDAVConfig, remoteBaseDir: string) {
    super();
    this.config = config;
    this.remoteDir = remoteBaseDir || config.path || "SyncSave";
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
        const basePath = this.remoteDir;
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

  private async ensureParentFolders(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    parts.pop(); // 移除檔名本身，只留下資料夾結構
    
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const url = this.buildUrl(currentPath);
      const checkResp = await this.request("PROPFIND", url);
      if (checkResp.status === 404) {
        await this.request("MKCOL", url);
      }
    }
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    await this.ensureParentFolders(path);
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
      
      // 如果路徑不存在 (404)，自動發送 MKCOL 建立資料夾
      if (resp.status === 404) {
        const createResp = await this.request("MKCOL", url);
        if (createResp.ok || createResp.status === 201) {
          return { success: true, message: `Connected to ${this.config.url} (已自動建立同步資料夾)` };
        }
        return { success: false, message: `同步資料夾不存在且自動建立失敗：MKCOL 狀態碼 ${createResp.status}` };
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
    const dir = this.remoteDir.replace(/^\/+|\/+$/g, "");
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

    const response = await requestUrl({
      url,
      method,
      headers,
      body: body || undefined,
      throw: false
    });

    return new RequestUrlResponseWrapper(response) as unknown as Response;
  }
}
