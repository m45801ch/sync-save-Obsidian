import { requestUrl, RequestUrlResponse } from "obsidian";
import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface BoxConfig {
  authType: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  authHelperUrl?: string;
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
  async json() {
    return this.res.json;
  }
  async arrayBuffer() {
    return this.res.arrayBuffer;
  }
}

export class BoxProvider extends CloudProvider {
  readonly name = "Box";
  readonly icon = "box";

  private config: BoxConfig;
  private connected = false;
  private rootFolderId: string | null = null;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private readonly apiBase = "https://api.box.com/2.0";
  private readonly uploadBase = "https://upload.box.com/api/2.0";

  private onTokenRefreshed?: () => void;
  private remoteDir: string;

  constructor(config: BoxConfig, remoteBaseDir: string, onTokenRefreshed?: () => void) {
    super();
    this.config = config;
    this.remoteDir = remoteBaseDir || "SyncSaveObsidian";
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async fetchClientCredentialsToken(): Promise<boolean> {
    if (!this.config.clientId || !this.config.clientSecret) {
      return false;
    }

    try {
      const url = "https://api.box.com/oauth2/token";
      const params = new URLSearchParams();
      params.append("grant_type", "client_credentials");
      params.append("client_id", this.config.clientId);
      params.append("client_secret", this.config.clientSecret);

      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        throw: false,
      });

      if (resp.status === 200) {
        const data = resp.json;
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
        return true;
      }
      return false;
    } catch (e) {
      console.error("Box client credentials token fetch failed", e);
      return false;
    }
  }

  private async exchangeCodeForToken(code: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = "https://api.box.com/oauth2/token";
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("client_id", this.config.clientId);
      params.append("client_secret", this.config.clientSecret);
      params.append("redirect_uri", "http://localhost");

      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        throw: false,
      });

      if (resp.status === 200) {
        const data = resp.json;
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
        this.config.refreshToken = data.refresh_token;
        this.config.accessToken = data.access_token;
        if (this.onTokenRefreshed) {
          this.onTokenRefreshed();
        }
        return { success: true, message: "授權成功！已成功取得存取與刷新權杖。" };
      }
      
      const errData = resp.json;
      const errMsg = errData?.error_description || errData?.error || `HTTP 狀態碼 ${resp.status}`;
      return { success: false, message: `授權失敗：${errMsg}` };
    } catch (e) {
      console.error("Box OAuth token exchange failed", e);
      return { success: false, message: `授權失敗：連線異常 (${(e as any).message || e})` };
    }
  }

  private async refreshOAuth2Token(): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      if (this.config.clientId && this.config.clientSecret) {
        const url = "https://api.box.com/oauth2/token";
        const params = new URLSearchParams();
        params.append("grant_type", "refresh_token");
        params.append("refresh_token", this.config.refreshToken);
        params.append("client_id", this.config.clientId);
        params.append("client_secret", this.config.clientSecret);

        const resp = await requestUrl({
          url,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
          throw: false,
        });

        if (resp.status === 200) {
          const data = resp.json;
          this.accessToken = data.access_token;
          this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
          this.config.refreshToken = data.refresh_token;
          this.config.accessToken = data.access_token;
          if (this.onTokenRefreshed) {
            this.onTokenRefreshed();
          }
          return true;
        }
      } else {
        const helperUrl = this.config.authHelperUrl || "https://sync-save-obsidian.vercel.app";
        const url = `${helperUrl}/api/box/refresh`;
        const resp = await requestUrl({
          url: `${url}?refresh_token=${encodeURIComponent(this.config.refreshToken)}`,
          method: "GET",
          throw: false,
        });

        if (resp.status === 200) {
          const data = resp.json;
          this.accessToken = data.access_token;
          this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
          this.config.refreshToken = data.refresh_token;
          this.config.accessToken = data.access_token;
          if (this.onTokenRefreshed) {
            this.onTokenRefreshed();
          }
          return true;
        }
      }
      return false;
    } catch (e) {
      console.error("Box OAuth token refresh failed", e);
      return false;
    }
  }

  async authorizeWithCode(code: string): Promise<{ success: boolean; message: string }> {
    if (!this.config.clientId || !this.config.clientSecret) {
      return { success: false, message: "請先輸入 Client ID 與 Client Secret" };
    }
    return this.exchangeCodeForToken(code);
  }

  private async checkAndRefreshToken(): Promise<void> {
    if (this.config.authType === "client_credentials") {
      if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
        const success = await this.fetchClientCredentialsToken();
        if (!success) {
          throw new Error("無法取得 Box 存取權杖，請檢查 Client ID 與 Client Secret。");
        }
      }
    } else if (this.config.authType === "oauth2" || this.config.authType === "one_click") {
      if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
        const success = await this.refreshOAuth2Token();
        if (!success) {
          throw new Error("無法更新 Box 存取權權杖，請重新啟用驗證授權（一鍵登入）。");
        }
      }
    } else {
      this.accessToken = this.config.accessToken;
    }
  }

  async connect(): Promise<boolean> {
    try {
      await this.checkAndRefreshToken();
    } catch (e) {
      console.error("Box connect failed to refresh token", e);
      throw new Error(`無法連線至 Box：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.accessToken) {
      throw new Error("無法連線至 Box：存取權杖為空，請先進行授權驗證。");
    }
    const result = await this.testConnection();
    this.connected = result.success;
    if (!this.connected) {
      throw new Error(`無法連線至 Box：${result.message}`);
    }
    this.rootFolderId = await this.ensureRootFolder();
    if (!this.rootFolderId) {
      throw new Error("無法連線至 Box：無法建立或取得 'SyncSaveObsidian' 根目錄。");
    }
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rootFolderId = null;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listFiles(_prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    if (!this.rootFolderId) return [];
    const allFiles: { path: string; mtime: number; size: number }[] = [];
    const folderMap: Record<string, string> = { "": this.rootFolderId };
    const queue = [""];
    while (queue.length > 0) {
      const currentPath = queue.shift()!;
      const folderId = folderMap[currentPath];
      const entries = await this.listFolderItems(folderId);
      for (const item of entries) {
        const itemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
        if (item.type === "folder") {
          folderMap[itemPath] = item.id;
          queue.push(itemPath);
        } else {
          allFiles.push({ path: itemPath, mtime: new Date(item.modified_at).getTime(), size: item.size || 0 });
        }
      }
    }
    return allFiles;
  }

  private async listFolderItems(folderId: string): Promise<{ type: string; id: string; name: string; modified_at: string; size: number }[]> {
    const items: any[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const resp = await this.request("GET", `${this.apiBase}/folders/${folderId}/items?limit=${limit}&offset=${offset}&fields=name,modified_at,size`);
      if (!resp.ok) throw new Error(`Box list failed: ${resp.status}`);
      const data = await resp.json();
      for (const entry of data.entries || []) {
        items.push({ type: entry.type, id: entry.id, name: entry.name, modified_at: entry.modified_at, size: entry.size || 0 });
      }
      if (data.entries?.length < limit) break;
      offset += limit;
    }
    return items;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) throw new Error(`File not found: ${path}`);
    const resp = await this.request("GET", `${this.apiBase}/files/${fileId}/content`);
    if (!resp.ok) throw new Error(`Box download failed: ${resp.status}`);
    const content = await resp.arrayBuffer();
    const metaResp = await this.request("GET", `${this.apiBase}/files/${fileId}?fields=modified_at,size`);
    const meta = await metaResp.json();
    return { path, content, mtime: new Date(meta.modified_at || Date.now()).getTime(), size: content.byteLength };
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    if (!this.rootFolderId) throw new Error("Not connected");
    const existingId = await this.resolveFileId(path);
    const parentId = await this.ensureParentFolders(path);
    const fileName = path.split("/").pop() || path;
    const contentModifiedAt = new Date(mtime).toISOString().split(".")[0] + "Z";
    
    if (existingId) {
      const resp = await this.uploadRequest("POST", `${this.uploadBase}/files/${existingId}/content`, content, fileName, {
        content_modified_at: contentModifiedAt
      });
      if (!resp.ok) {
        const details = await resp.json().catch(() => null);
        throw new Error(`Box upload failed: ${resp.status} - ${JSON.stringify(details)}`);
      }
    } else {
      const resp = await this.uploadRequest("POST", `${this.uploadBase}/files/content`, content, fileName, {
        name: fileName,
        parent: { id: parentId },
        content_modified_at: contentModifiedAt
      });
      if (!resp.ok) {
        const details = await resp.json().catch(() => null);
        throw new Error(`Box upload failed: ${resp.status} - ${JSON.stringify(details)}`);
      }
    }
  }

  async deleteFile(path: string): Promise<void> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) return;
    const resp = await this.request("DELETE", `${this.apiBase}/files/${fileId}`);
    if (!resp.ok && resp.status !== 404) throw new Error(`Box delete failed: ${resp.status}`);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const resp = await this.request("GET", `${this.apiBase}/users/me`);
      if (resp.ok) {
        const data = await resp.json();
        return { success: true, message: `已連線為 ${data.login || data.name || "使用者"}` };
      }
      if (resp.status === 401) {
        if (this.config.authType === "client_credentials") {
          return { success: false, message: "憑證無效或未授權 — 請確認 Client ID 與 Client Secret，且該 App 已由 Box 管理員核准" };
        }
        if (this.config.authType === "oauth2" || this.config.authType === "one_click") {
          return { success: false, message: "授權已失效或過期 — 請重新啟用驗證（進行一鍵授權登入）" };
        }
        return { success: false, message: "權杖已過期或無效 — 請重新產生 Developer Token" };
      }
      if (resp.status === 403) return { success: false, message: "無存取權限 — 請確認 App 已啟用「Read and write all files」範圍" };
      return { success: false, message: `狀態碼：${resp.status}` };
    } catch (error) {
      return { success: false, message: `連線失敗：${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    if (this.config.authType === "client_credentials") {
      return { 
        Auth: "用戶端認證",
        "Client ID": this.config.clientId ? "已設定" : "未設定"
      };
    }
    if (this.config.authType === "oauth2") {
      return { 
        Auth: "OAuth2 驗證",
        "Client ID": this.config.clientId ? "已設定" : "未設定"
      };
    }
    return { Auth: this.config.accessToken ? "開發者權杖" : "無權杖" };
  }

  private async ensureRootFolder(): Promise<string | null> {
    const rootName = this.remoteDir || "SyncSaveObsidian";
    const resp = await this.request("GET", `${this.apiBase}/folders/0/items?limit=200&fields=name,id`);
    if (!resp.ok) return null;
    const data = await resp.json();
    for (const entry of data.entries || []) {
      if (entry.type === "folder" && entry.name === rootName) return entry.id;
    }
    const createResp = await this.request("POST", `${this.apiBase}/folders`, { name: rootName, parent: { id: "0" } });
    if (!createResp.ok) {
      const errData = await createResp.json();
      if (errData?.context_info?.conflicts?.length > 0) return errData.context_info.conflicts[0].id;
      return null;
    }
    const created = await createResp.json();
    return created.id;
  }

  private async ensureParentFolders(path: string): Promise<string> {
    if (!this.rootFolderId) throw new Error("未連線");
    const parts = path.split("/");
    parts.pop();
    let currentParentId = this.rootFolderId;
    for (const part of parts) {
      const children = await this.listFolderItems(currentParentId);
      const found = children.find((c) => c.type === "folder" && c.name === part);
      if (found) {
        currentParentId = found.id;
      } else {
        const createResp = await this.request("POST", `${this.apiBase}/folders`, { name: part, parent: { id: currentParentId } });
        if (!createResp.ok) throw new Error(`無法建立資料夾：${part}`);
        const created = await createResp.json();
        currentParentId = created.id;
      }
    }
    return currentParentId;
  }

  private async resolveFileId(path: string): Promise<string | null> {
    if (!this.rootFolderId) return null;
    const parts = path.split("/");
    const fileName = parts.pop();
    if (!fileName) return null;
    const parentId = await this.ensureParentFolders(path);
    const children = await this.listFolderItems(parentId);
    const found = children.find((c) => c.type === "file" && c.name === fileName);
    return found?.id || null;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    fileContent?: ArrayBuffer,
    fileName?: string
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.accessToken}`,
      ...extraHeaders,
    };

    let finalBody: string | ArrayBuffer | undefined;

    if (fileContent && fileName) {
      const boundary = `boundary${Date.now()}`;
      const encoder = new TextEncoder();
      const parts: Uint8Array[] = [];
      const attrs = body ? JSON.stringify(body) : "{}";
      parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\nContent-Type: application/json\r\n\r\n${attrs}\r\n`));
      parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      parts.push(new Uint8Array(fileContent));
      parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

      let totalLength = 0;
      for (const part of parts) {
        totalLength += part.length;
      }
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const part of parts) {
        combined.set(part, offset);
        offset += part.length;
      }
      finalBody = combined.buffer;
      headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
    } else if (body) {
      headers["Content-Type"] = "application/json";
      finalBody = JSON.stringify(body);
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: finalBody,
      throw: false,
    });

    return new RequestUrlResponseWrapper(response) as unknown as Response;
  }

  private async uploadRequest(
    method: string,
    url: string,
    fileContent: ArrayBuffer,
    fileName: string,
    attributes: Record<string, unknown>
  ): Promise<Response> {
    return this.request(method, url, attributes, undefined, fileContent, fileName);
  }
}
