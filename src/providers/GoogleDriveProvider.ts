import { requestUrl, RequestUrlResponse } from "obsidian";
import { CloudProvider, SyncFile } from "../sync/CloudProvider";

const DEFAULT_GOOGLE_CLIENT_ID = "147064468840-cqaqbijf1g60e6k2sonu18rr8jt30gkh.apps.googleusercontent.com";
const DEFAULT_GOOGLE_CLIENT_SECRET = "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";

interface GoogleDriveConfig {
  authType: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  codeVerifier?: string;
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

export class GoogleDriveProvider extends CloudProvider {
  readonly name = "Google Drive";
  readonly icon = "drive";

  private config: GoogleDriveConfig;
  private connected = false;
  private rootFolderId: string | null = null;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private readonly apiBase = "https://www.googleapis.com/drive/v3";
  private readonly uploadBase = "https://www.googleapis.com/upload/drive/v3";

  private onTokenRefreshed?: () => void;
  private remoteDir: string;

  constructor(config: GoogleDriveConfig, remoteBaseDir: string, onTokenRefreshed?: () => void) {
    super();
    this.config = config;
    this.remoteDir = remoteBaseDir || "SyncSaveObsidian";
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async exchangeCodeForToken(code: string, codeVerifier?: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = "https://oauth2.googleapis.com/token";
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("client_id", this.config.clientId || DEFAULT_GOOGLE_CLIENT_ID);
      params.append("client_secret", this.config.clientSecret || DEFAULT_GOOGLE_CLIENT_SECRET);
      
      const verifier = codeVerifier || this.config.codeVerifier;
      if (verifier) {
        params.append("code_verifier", verifier);
      }
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
      console.error("Google Drive OAuth token exchange failed", e);
      return { success: false, message: `授權失敗：連線異常 (${(e as any).message || e})` };
    }
  }

  private async refreshOAuth2Token(): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const url = "https://oauth2.googleapis.com/token";
      const params = new URLSearchParams();
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", this.config.refreshToken);
      params.append("client_id", this.config.clientId || DEFAULT_GOOGLE_CLIENT_ID);
      params.append("client_secret", this.config.clientSecret || DEFAULT_GOOGLE_CLIENT_SECRET);

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
        if (data.refresh_token) {
          this.config.refreshToken = data.refresh_token;
        }
        this.config.accessToken = data.access_token;
        if (this.onTokenRefreshed) {
          this.onTokenRefreshed();
        }
        return true;
      }
      return false;
    } catch (e) {
      console.error("Google Drive OAuth token refresh failed", e);
      return false;
    }
  }

  async authorizeWithCode(code: string, codeVerifier?: string): Promise<{ success: boolean; message: string }> {
    if (!this.config.clientId && !DEFAULT_GOOGLE_CLIENT_ID) {
      return { success: false, message: "請先輸入 Client ID" };
    }
    return this.exchangeCodeForToken(code, codeVerifier);
  }

  private async checkAndRefreshToken(): Promise<void> {
    if (this.config.refreshToken) {
      if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
        const success = await this.refreshOAuth2Token();
        if (!success) {
          throw new Error("無法更新 Google Drive 存取權權杖，請重新啟用驗證授權。");
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
      console.error("Google Drive connect failed to refresh token", e);
      throw new Error(`無法連線至 Google Drive：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.accessToken) {
      throw new Error("無法連線至 Google Drive：存取權杖為空，請先設定權杖或進行 OAuth2 授權。");
    }
    const result = await this.testConnection();
    this.connected = result.success;
    if (!this.connected) {
      throw new Error(`無法連線至 Google Drive：${result.message}`);
    }
    this.rootFolderId = await this.ensureRootFolder();
    if (!this.rootFolderId) {
      throw new Error("無法連線至 Google Drive：無法建立或取得 'SyncSaveObsidian' 根目錄。");
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

  async listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    if (!this.rootFolderId) return [];

    const allFiles: { path: string; mtime: number; size: number }[] = [];
    const folders: Record<string, string> = { "": this.rootFolderId };
    let pageToken: string | null = null;

    do {
      let q = `'${this.rootFolderId}' in parents and trashed=false`;
      let url = `${this.apiBase}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime,size,parents)&pageSize=1000`;
      if (pageToken) url += `&pageToken=${pageToken}`;

      const resp = await this.request("GET", url);
      if (!resp.ok) throw new Error(`Google Drive list failed: ${resp.status}`);

      const data = await resp.json();

      for (const item of data.files || []) {
        if (item.mimeType === "application/vnd.google-apps.folder") {
          const parentPath = this.getParentPath(item.parents, folders) || "";
          folders[`${parentPath}/${item.name}`] = item.id;
        } else {
          const parentPath = this.getParentPath(item.parents, folders) || "";
          allFiles.push({
            path: `${parentPath}/${item.name}`.replace(/^\//, ""),
            mtime: new Date(item.modifiedTime).getTime(),
            size: parseInt(item.size || "0"),
          });
        }
      }

      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return allFiles;
  }

  private getParentPath(
    parents: string[] | undefined,
    folderMap: Record<string, string>
  ): string | null {
    if (!parents || parents.length === 0) return null;
    for (const [path, id] of Object.entries(folderMap)) {
      if (id === parents[0]) return path;
    }
    return null;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) throw new Error(`File not found: ${path}`);

    const resp = await this.request(
      "GET",
      `${this.apiBase}/files/${fileId}?alt=media`
    );

    if (!resp.ok) throw new Error(`Google Drive download failed: ${resp.status}`);

    const content = await resp.arrayBuffer();
    const mtime = resp.headers.get("last-modified");

    const metaResp = await this.request(
      "GET",
      `${this.apiBase}/files/${fileId}?fields=modifiedTime,size`
    );
    const meta = await metaResp.json();

    return {
      path,
      content,
      mtime: new Date(meta.modifiedTime || mtime || Date.now()).getTime(),
      size: content.byteLength,
    };
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    if (!this.rootFolderId) throw new Error("Not connected");

    const existingId = await this.resolveFileId(path);
    const parentId = await this.ensureParentFolders(path);
    const fileName = path.split("/").pop() || path;

    if (existingId) {
      const resp = await this.request(
        "PATCH",
        `${this.uploadBase}/files/${existingId}?uploadType=media`,
        content,
        { "Content-Type": "application/octet-stream" }
      );
      if (!resp.ok) throw new Error(`Google Drive upload content failed: ${resp.status}`);

      const metaResp = await this.request(
        "PATCH",
        `${this.apiBase}/files/${existingId}`,
        { modifiedTime: new Date(mtime).toISOString() }
      );
      if (!metaResp.ok) throw new Error(`Google Drive update metadata failed: ${metaResp.status}`);
    } else {
      const metadata = {
        name: fileName,
        parents: [parentId],
        modifiedTime: new Date(mtime).toISOString(),
      };

      const resp = await this.request(
        "POST",
        `${this.uploadBase}/files?uploadType=multipart`,
        metadata,
        undefined,
        content
      );
      if (!resp.ok) {
        const details = await resp.json().catch(() => null);
        throw new Error(`Google Drive upload failed: ${resp.status} - ${JSON.stringify(details)}`);
      }
    }
  }

  async deleteFile(path: string): Promise<void> {
    const fileId = await this.resolveFileId(path);
    if (!fileId) return;

    const resp = await this.request("DELETE", `${this.apiBase}/files/${fileId}`);
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Google Drive delete failed: ${resp.status}`);
    }
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const resp = await this.request(
        "GET",
        `${this.apiBase}/about?fields=user`
      );

      if (resp.ok) {
        const data = await resp.json();
        return {
          success: true,
          message: `Connected as ${data.user?.emailAddress || data.user?.displayName || "user"}`,
        };
      }

      if (resp.status === 401) {
        return { success: false, message: "Token expired or invalid — reauthorize" };
      }
      return { success: false, message: `Status: ${resp.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    if (this.config.authType === "oauth2") {
      return {
        Auth: "OAuth2 驗證",
        "Client ID": this.config.clientId ? "已設定" : "未設定"
      };
    }
    return {
      Auth: this.config.accessToken ? "開發者權杖" : "無權杖",
    };
  }

  private async ensureRootFolder(): Promise<string | null> {
    const rootName = this.remoteDir || "SyncSaveObsidian";
    const q = encodeURIComponent(`name='${rootName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const resp = await this.request("GET", `${this.apiBase}/files?q=${q}&fields=files(id,name)`);

    if (!resp.ok) return null;
    const data = await resp.json();

    if (data.files && data.files.length > 0) {
      return data.files[0].id;
    }

    const createResp = await this.request(
      "POST",
      `${this.apiBase}/files`,
      {
        name: rootName,
        mimeType: "application/vnd.google-apps.folder",
      }
    );

    if (!createResp.ok) return null;
    const created = await createResp.json();
    return created.id;
  }

  private async ensureParentFolders(path: string): Promise<string> {
    if (!this.rootFolderId) throw new Error("Not connected");

    const parts = path.split("/");
    parts.pop();

    let currentParentId = this.rootFolderId;

    for (const part of parts) {
      const q = encodeURIComponent(
        `name='${part.replace(/'/g, "\\'")}' and '${currentParentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`
      );
      const resp = await this.request("GET", `${this.apiBase}/files?q=${q}&fields=files(id,name)`);

      if (!resp.ok) throw new Error("Failed to query folder");

      const data = await resp.json();

      if (data.files && data.files.length > 0) {
        currentParentId = data.files[0].id;
      } else {
        const createResp = await this.request(
          "POST",
          `${this.apiBase}/files`,
          {
            name: part,
            mimeType: "application/vnd.google-apps.folder",
            parents: [currentParentId],
          }
        );

        if (!createResp.ok) throw new Error(`Failed to create folder: ${part}`);
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

    const q = encodeURIComponent(
      `name='${fileName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`
    );
    const resp = await this.request("GET", `${this.apiBase}/files?q=${q}&fields=files(id,name)`);

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.files?.[0]?.id || null;
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
    fileContent?: ArrayBuffer
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken || this.config.accessToken}`,
      ...extraHeaders,
    };

    let finalBody: string | ArrayBuffer | undefined;

    if (fileContent) {
      const boundary = `boundary_sync_save_${Date.now()}`;
      const encoder = new TextEncoder();
      const parts: Uint8Array[] = [];
      
      parts.push(encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(body || {})}\r\n`));
      parts.push(encoder.encode(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`));
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
      headers["Content-Type"] = `multipart/related; boundary=${boundary}`;
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
}
