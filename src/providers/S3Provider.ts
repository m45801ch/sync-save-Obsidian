import { CloudProvider, SyncFile } from "../sync/CloudProvider";

interface S3Config {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
}

export class S3Provider extends CloudProvider {
  readonly name = "S3-Compatible";
  readonly icon = "cloud";

  private config: S3Config;
  private connected = false;

  constructor(config: S3Config) {
    super();
    this.config = config;
  }

  async connect(): Promise<boolean> {
    try {
      await this.testConnection();
      this.connected = true;
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listFiles(prefix: string): Promise<{ path: string; mtime: number; size: number }[]> {
    const fullPrefix = this.config.prefix + prefix;
    const url = this.buildUrl(`?list-type=2&prefix=${encodeURIComponent(fullPrefix)}`);
    const resp = await this.signedRequest("GET", url);

    if (!resp.ok) throw new Error(`S3 list failed: ${resp.status}`);

    const xml = await resp.text();
    const files: { path: string; mtime: number; size: number }[] = [];

    const contentMatch = xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g);
    for (const match of contentMatch) {
      const content = match[1];
      const key = content.match(/<Key>(.*?)<\/Key>/);
      const lastModified = content.match(/<LastModified>(.*?)<\/LastModified>/);
      const size = content.match(/<Size>(.*?)<\/Size>/);

      if (key) {
        const path = key[1].replace(this.config.prefix, "");
        files.push({
          path,
          mtime: lastModified ? new Date(lastModified[1]).getTime() : 0,
          size: size ? parseInt(size[1]) : 0,
        });
      }
    }

    return files;
  }

  async downloadFile(path: string): Promise<SyncFile> {
    const url = this.buildUrl(encodeURI(this.config.prefix + path));
    const resp = await this.signedRequest("GET", url);

    if (!resp.ok) throw new Error(`S3 download failed: ${resp.status}`);

    const content = await resp.arrayBuffer();
    const mtime = resp.headers.get("last-modified");
    const size = parseInt(resp.headers.get("content-length") || "0");

    return {
      path,
      content,
      mtime: mtime ? new Date(mtime).getTime() : Date.now(),
      size,
    };
  }

  async uploadFile(path: string, content: ArrayBuffer, mtime: number): Promise<void> {
    const url = this.buildUrl(encodeURI(this.config.prefix + path));
    const resp = await this.signedRequest("PUT", url, content, {
      "Content-Type": "application/octet-stream",
    });

    if (!resp.ok) throw new Error(`S3 upload failed: ${resp.status}`);
  }

  async deleteFile(path: string): Promise<void> {
    const url = this.buildUrl(encodeURI(this.config.prefix + path));
    const resp = await this.signedRequest("DELETE", url);
    if (!resp.ok) throw new Error(`S3 delete failed: ${resp.status}`);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const url = this.buildUrl("");
      const resp = await this.signedRequest("GET", url);
      if (resp.status === 200 || resp.status === 403) {
        return { success: true, message: `Connected to ${this.config.bucket}` };
      }
      return { success: false, message: `Unexpected status: ${resp.status}` };
    } catch (error) {
      return { success: false, message: `Connection failed: ${error}` };
    }
  }

  getSettingsDisplay(): Record<string, string> {
    return {
      Endpoint: this.config.endpoint,
      Bucket: this.config.bucket,
      Region: this.config.region,
      Prefix: this.config.prefix || "(none)",
    };
  }

  private buildUrl(path: string): string {
    const base = this.config.endpoint.replace(/\/+$/, "");
    return `${base}/${this.config.bucket}/${path}`;
  }

  private async signedRequest(
    method: string,
    url: string,
    body?: ArrayBuffer,
    headers?: Record<string, string>
  ): Promise<Response> {
    const date = new Date().toUTCString();
    const reqHeaders: Record<string, string> = {
      ...headers,
      Host: new URL(url).host,
      "x-amz-date": date,
    };

    const authHeader = await this.signRequest(method, url, reqHeaders, body);
    reqHeaders["Authorization"] = authHeader;

    return fetch(url, {
      method,
      headers: reqHeaders,
      body: body || undefined,
    });
  }

  private async signRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: ArrayBuffer
  ): Promise<string> {
    const urlObj = new URL(url);
    const service = "s3";
    const algorithm = "AWS4-HMAC-SHA256";
    const dateShort = this.getDateShort();

    const credential = `${this.config.accessKeyId}/${dateShort}/${this.config.region}/${service}/aws4_request`;
    const signedHeaders = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
      .join(";");

    const enc = new TextEncoder();
    const payload = body ? await this.sha256Hex(body) : await this.sha256Hex(new Uint8Array());
    const canonicalRequest = `${method}\n${urlObj.pathname}\n${urlObj.search}\n${Object.entries(headers)
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([k, v]) => `${k.toLowerCase()}:${v}`)
      .join("\n")}\n\n${signedHeaders}\n${payload}`;

    const stringToSign = `${algorithm}\n${headers["x-amz-date"]}\n${dateShort}/${this.config.region}/${service}/aws4_request\n${await this.sha256Hex(enc.encode(canonicalRequest))}`;

    const signature = await this.calculateSignature(stringToSign, dateShort);
    return `${algorithm} Credential=${credential},SignedHeaders=${signedHeaders},Signature=${signature}`;
  }

  private getDateShort(): string {
    return new Date().toISOString().substring(0, 10).replace(/-/g, "");
  }

  private async sha256Hex(data: BufferSource): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  private async hmacSha256(key: BufferSource, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  }

  private async calculateSignature(stringToSign: string, dateShort: string): Promise<string> {
    const enc = new TextEncoder();
    const kDate = await this.hmacSha256(enc.encode(`AWS4${this.config.secretAccessKey}`), dateShort);
    const kRegion = await this.hmacSha256(kDate, this.config.region);
    const kService = await this.hmacSha256(kRegion, "s3");
    const kSigning = await this.hmacSha256(kService, "aws4_request");

    const signature = await crypto.subtle.sign(
      "HMAC",
      await crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
      new TextEncoder().encode(stringToSign)
    );

    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
