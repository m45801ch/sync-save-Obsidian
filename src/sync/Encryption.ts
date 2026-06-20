export class Encryption {
  private password: string;
  private algorithm = "aes-256-gcm";
  private saltLength = 32;
  private ivLength = 16;
  private tagLength = 16;

  constructor(password: string) {
    this.password = password;
  }

  private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    const salt = crypto.getRandomValues(new Uint8Array(this.saltLength));
    const iv = crypto.getRandomValues(new Uint8Array(this.ivLength));
    const key = await this.deriveKey(salt);

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: this.tagLength * 8 },
      key,
      data
    );

    const header = new Uint8Array(2 + this.saltLength + this.ivLength);
    header[0] = 0x01;
    header[1] = 0x00;
    header.set(salt, 2);
    header.set(iv, 2 + this.saltLength);

    const result = new Uint8Array(header.length + encrypted.byteLength);
    result.set(header);
    result.set(new Uint8Array(encrypted), header.length);
    return result.buffer;
  }

  async decrypt(data: ArrayBuffer): Promise<ArrayBuffer | null> {
    try {
      const view = new Uint8Array(data);
      if (view[0] !== 0x01) return null;

      const salt = view.slice(2, 2 + this.saltLength);
      const iv = view.slice(2 + this.saltLength, 2 + this.saltLength + this.ivLength);
      const ciphertext = view.slice(2 + this.saltLength + this.ivLength);

      const key = await this.deriveKey(salt);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, tagLength: this.tagLength * 8 },
        key,
        ciphertext
      );
      return decrypted;
    } catch {
      return null;
    }
  }

  static async hashFile(data: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex;
  }

  isEnabled(): boolean {
    return this.password.length > 0;
  }
}
