import { requestUrl, RequestUrlResponse } from "obsidian";
import { CloudProvider, SyncFile } from "../sync/CloudProvider";

const DEFAULT_DROPBOX_CLIENT_ID = "fwetpaegys8iwjf";

interface DropboxConfig {
  authType: string;
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  appFolder: boolean;
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

export class DropboxProvider extends CloudProvider {
  readonly name = "Dropbox";
  readonly icon = "droplet";

  private config: DropboxConfig;
  private connected = false;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private onTokenRefreshed?: () => void;
  private remoteBaseDir: string;

  constructor(config: DropboxConfig, remoteBaseDir: string, onTokenRefreshed?: () => void) {
    super();
    this.config = config;
    this.remoteBaseDir = remoteBaseDir || "SyncSaveObsidian";
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private async exchangeCodeForToken(code: string, codeVerifier?: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = "https://api.dropbox.com/oauth2/token";
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("client_id", this.config.clientId || DEFAULT_DROPBOX_CLIENT_ID);
      
      const verifier = codeVerifier || this.config.codeVerifier;
      if (verifier) {
        params.append("code_verifier", verifier);
      }
      params.append("redirect_uri", "obsidian://sync-save-auth");

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
      console.error("Dropbox OAuth token exchange failed", e);
      return { success: false, message: `授權失敗：連線異常 (${(e as any).message || e})` };
    }
  }

  private async refreshOAuth2Token(): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const url = "https://api.dropbox.com/oauth2/token";
      const params = new URLSearchParams();
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", this.config.refreshToken);
      params.append("client_id", this.config.clientId || DEFAULT_DROPBOX_CLIENT_ID);

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
      console.error("Dropbox OAuth token refresh failed", e);
      return false;
    }
  }

  async authorizeWithCode(code: string, codeVerifier?: string): Promise<{ success: boolean; message: string }> {
    return this.exchangeCodeForToken(code, codeVerifier);
  }

  private async checkAndRefreshToken(): Promise<void> {
    if (this.config.authType === "oauth2" && this.config.refreshToken) {
      if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
        const success = await this.refreshOAuth2Token();
        if (!success) {
          throw new Error("無法更新 Dropbox 存取權權杖，請重新啟用驗證授權。");
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
      console.error("Dropbox connect failed to refresh token", e);
      throw new Error(`無法連線至 Dropbox：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.accessToken && !this.config.accessToken) {
      throw new Error("無法連線至 Dropbox：存取權杖為空，請先設定權杖或進行 OAuth2 授權。");
    }
    const result = await this.testConnection();
    this.connected = result.success;
    return this.connected;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    const basePath = this.remoteBaseDir ? "/" + this.remoteBaseDir.replace(/^\/+|\/+$/g, "") : "";
    const body = { path: basePath, recursive: true, include_media_info: false };

    const resp = await this.request("https://api.dropboxapi.com/2/files/list_folder", body);
    if (resp.status === 409 || resp.status === 404) {
      return [];
    }
    if (!resp.ok) throw new Error(`Dropbox list failed: ${resp.status}`);

    const data = await resp.json();
    const files: { path: string; mtime: number; size: number }[] = [];

    const prefixPath = basePath ? basePath.toLowerCase() + "/" : "";
    for (const entry of data.entries || []) {
      if (entry[".tag"] !== "file") continue;
      const filePathLower = entry.path_lower || "";
      if (!prefixPath || filePathLower.startsWith(prefixPath)) {
        const displayPath = entry.path_display || entry.path_lower || "";
        const relativePath = displayPath.substring(basePath.length).replace(/^\//, "");
        files.push({
          path: relativePath,
          mtime: new Date(entry.server_modified || entry.client_modified).getTime(),
          size: entry.size || 0,
        });
      }
    }

    return files;
  }

  private escapeHeaderValue(str: string): string {
    return str.replace(/[^\x00-\x7F]/g, (char) => {
      return '\\u' + ('0000' + char.charCodeAt(0).toString(16)).slice(-4);
    });
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const basePath = this.remoteBaseDir ? "/" + this.remoteBaseDir.replace(/^\/+|\/+$/g, "") : "";
    const dropboxPath = basePath ? `${basePath}/${path.replace(/^\/+/, "")}` : `/${path.replace(/^\/+/, "")}`;

    const resp = await this.request(
      "https://content.dropboxapi.com/2/files/download",
      undefined,
      { "Dropbox-API-Arg": this.escapeHeaderValue(JSON.stringify({ path: dropboxPath })) }
    );

    if (!resp.ok) {
      let details = "";
      try {
        const text = (resp as any).res?.text || JSON.stringify(await resp.json());
        details = ` - ${text}`;
      } catch (e) {
        details = ` - Status: ${resp.status}`;
      }
      throw new Error(`Dropbox download failed: ${resp.status}${details}`);
    }

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
    const basePath = this.remoteBaseDir ? "/" + this.remoteBaseDir.replace(/^\/+|\/+$/g, "") : "";
    const dropboxPath = basePath ? `${basePath}/${path.replace(/^\/+/, "")}` : `/${path.replace(/^\/+/, "")}`;

    const resp = await this.request(
      "https://content.dropboxapi.com/2/files/upload",
      content,
      {
        "Dropbox-API-Arg": this.escapeHeaderValue(JSON.stringify({
          path: dropboxPath,
          mode: "overwrite",
          mute: true,
        })),
        "Content-Type": "application/octet-stream",
      }
    );

    if (!resp.ok) {
      let details = "";
      try {
        const text = (resp as any).res?.text || JSON.stringify(await resp.json());
        details = ` - ${text}`;
      } catch (e) {
        details = ` - Status: ${resp.status}`;
      }
      throw new Error(`Dropbox upload failed: ${resp.status}${details}`);
    }
  }

  async deleteFile(path: string): Promise<void> {
    const basePath = this.remoteBaseDir ? "/" + this.remoteBaseDir.replace(/^\/+|\/+$/g, "") : "";
    const dropboxPath = basePath ? `${basePath}/${path.replace(/^\/+/, "")}` : `/${path.replace(/^\/+/, "")}`;
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
    const token = this.accessToken || this.config.accessToken;
    return {
      Type: this.config.appFolder ? "App Folder" : "Full Dropbox",
      Token: token ? `${token.substring(0, 8)}...` : "None",
    };
  }

  private async request(url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<Response> {
    await this.checkAndRefreshToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken || this.config.accessToken}`,
      ...extraHeaders,
    };

    if (body && !extraHeaders?.["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const response = await requestUrl({
      url,
      method: "POST",
      headers,
      body: body instanceof ArrayBuffer ? body : body ? JSON.stringify(body) : undefined,
      throw: false,
    });

    return new RequestUrlResponseWrapper(response) as unknown as Response;
  }
}
