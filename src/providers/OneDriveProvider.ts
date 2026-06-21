import { requestUrl, RequestUrlResponse } from "obsidian";
import { CloudProvider, SyncFile } from "../sync/CloudProvider";

const DEFAULT_ONEDRIVE_CLIENT_ID = "7b4ca8e0-871f-48c1-8a90-7babce6c812c";

interface OneDriveConfig {
  authType: string;
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  useAppFolder: boolean;
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

export class OneDriveProvider extends CloudProvider {
  readonly name = "OneDrive";
  readonly icon = "cloud";

  private config: OneDriveConfig;
  private connected = false;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private onTokenRefreshed?: () => void;

  constructor(config: OneDriveConfig, onTokenRefreshed?: () => void) {
    super();
    this.config = config;
    this.onTokenRefreshed = onTokenRefreshed;
  }

  private getRedirectUri(): string {
    return this.config.useAppFolder
      ? "obsidian://sync-save-cb-onedrive"
      : "obsidian://sync-save-cb-onedrivefull";
  }

  private async exchangeCodeForToken(code: string, codeVerifier?: string): Promise<{ success: boolean; message: string }> {
    try {
      const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("client_id", this.config.clientId || DEFAULT_ONEDRIVE_CLIENT_ID);
      
      const verifier = codeVerifier || this.config.codeVerifier;
      if (verifier) {
        params.append("code_verifier", verifier);
      }
      params.append("redirect_uri", this.getRedirectUri());

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
      console.error("OneDrive OAuth token exchange failed", e);
      return { success: false, message: `授權失敗：連線異常 (${(e as any).message || e})` };
    }
  }

  private async refreshOAuth2Token(): Promise<boolean> {
    if (!this.config.refreshToken) return false;

    try {
      const url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
      const params = new URLSearchParams();
      params.append("grant_type", "refresh_token");
      params.append("refresh_token", this.config.refreshToken);
      params.append("client_id", this.config.clientId || DEFAULT_ONEDRIVE_CLIENT_ID);
      params.append("redirect_uri", this.getRedirectUri());

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
      console.error("OneDrive OAuth token refresh failed", e);
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
          throw new Error("無法更新 OneDrive 存取權權杖，請重新啟用驗證授權。");
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
      console.error("OneDrive connect failed to refresh token", e);
      throw new Error(`無法連線至 OneDrive：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.accessToken && !this.config.accessToken) {
      throw new Error("無法連線至 OneDrive：存取權杖為空，請先進行授權驗證。");
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
    const token = this.accessToken || this.config.accessToken;
    return {
      Mode: this.config.useAppFolder ? "App Folder" : "Full OneDrive",
      Token: token ? `${token.substring(0, 8)}...` : "None",
    };
  }

  private async request(method: string, url: string, body?: ArrayBuffer): Promise<Response> {
    await this.checkAndRefreshToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken || this.config.accessToken}`,
    };

    if (body || method === "PUT") {
      headers["Content-Type"] = "application/octet-stream";
    }

    const response = await requestUrl({
      url,
      method,
      headers,
      body: body || undefined,
      throw: false,
    });

    return new RequestUrlResponseWrapper(response) as unknown as Response;
  }
}
