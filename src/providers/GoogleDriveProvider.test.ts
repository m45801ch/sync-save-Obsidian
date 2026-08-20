import { describe, expect, it } from "vitest";
import { encodeGoogleDriveRequest, flattenGoogleDriveTree, GoogleDriveProvider } from "./GoogleDriveProvider";

describe("Google Drive transport", () => {
  it("sends existing-file bytes without JSON serialization", () => {
    const content = new TextEncoder().encode("original note").buffer;
    const request = encodeGoogleDriveRequest(content);

    expect(request.contentType).toBe("application/octet-stream");
    expect(new TextDecoder().decode(request.body as ArrayBuffer)).toBe("original note");
  });

  it("includes nested files with relative paths", () => {
    expect(flattenGoogleDriveTree("root", [{
      parentId: "root", files: [{ id: "folder", name: "notes", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z" }],
    }, {
      parentId: "folder", files: [{ id: "note", name: "a.md", mimeType: "text/markdown", modifiedTime: "2026-01-02T00:00:00Z", size: "3" }],
    }])).toEqual([{ path: "notes/a.md", mtime: Date.parse("2026-01-02T00:00:00Z"), size: 3 }]);
  });

  it("lists every page in each nested folder", async () => {
    const provider = new GoogleDriveProvider({
      authType: "token",
      accessToken: "token",
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    }, "SyncSaveObsidian");
    const urls: string[] = [];
    const responses = [
      { files: [{ id: "folder", name: "notes", mimeType: "application/vnd.google-apps.folder", modifiedTime: "2026-01-01T00:00:00Z" }], nextPageToken: "root-page-2" },
      { files: [{ id: "root-file", name: "root.md", mimeType: "text/markdown", modifiedTime: "2026-01-02T00:00:00Z", size: "4" }] },
      { files: [{ id: "nested-file", name: "a.md", mimeType: "text/markdown", modifiedTime: "2026-01-03T00:00:00Z", size: "3" }] },
    ];

    (provider as any).rootFolderId = "root";
    (provider as any).request = async (_method: string, url: string) => {
      urls.push(url);
      const data = responses.shift();
      if (!data) throw new Error("Unexpected request");
      return { ok: true, status: 200, json: async () => data };
    };

    await expect(provider.listFiles("")).resolves.toEqual([
      { path: "root.md", mtime: Date.parse("2026-01-02T00:00:00Z"), size: 4 },
      { path: "notes/a.md", mtime: Date.parse("2026-01-03T00:00:00Z"), size: 3 },
    ]);
    expect(urls.map((url) => decodeURIComponent(new URL(url).searchParams.get("q") || ""))).toEqual([
      "'root' in parents and trashed=false",
      "'root' in parents and trashed=false",
      "'folder' in parents and trashed=false",
    ]);
    expect(new URL(urls[1]).searchParams.get("pageToken")).toBe("root-page-2");
  });

  it("does not create folders while looking up a missing download", async () => {
    const provider = new GoogleDriveProvider({
      authType: "token",
      accessToken: "token",
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    }, "SyncSaveObsidian");
    const methods: string[] = [];

    (provider as any).rootFolderId = "root";
    (provider as any).request = async (method: string) => {
      methods.push(method);
      if (method !== "GET") throw new Error("Read operation created a folder");
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    };

    await expect(provider.downloadFile("notes/a.md")).rejects.toThrow("File not found: notes/a.md");
    expect(methods).toEqual(["GET"]);
  });

  it("does not create folders while looking up a missing delete target", async () => {
    const provider = new GoogleDriveProvider({
      authType: "token",
      accessToken: "token",
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    }, "SyncSaveObsidian");
    const methods: string[] = [];

    (provider as any).rootFolderId = "root";
    (provider as any).request = async (method: string) => {
      methods.push(method);
      if (method !== "GET") throw new Error("Delete lookup created a folder");
      return { ok: true, status: 200, json: async () => ({ files: [] }) };
    };

    await expect(provider.deleteFile("notes/a.md")).resolves.toBeUndefined();
    expect(methods).toEqual(["GET"]);
  });

  it("does not resolve parent folders again when overwriting an existing file", async () => {
    const provider = new GoogleDriveProvider({
      authType: "token",
      accessToken: "token",
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    }, "SyncSaveObsidian");
    const methods: string[] = [];
    const requests = [
      { method: "GET", data: { files: [{ id: "notes" }] } },
      { method: "GET", data: { files: [{ id: "note" }] } },
      { method: "PATCH", data: {} },
      { method: "PATCH", data: {} },
    ];

    (provider as any).rootFolderId = "root";
    (provider as any).request = async (method: string) => {
      methods.push(method);
      const request = requests.shift();
      if (!request || request.method !== method) {
        throw new Error(`Unexpected ${method} request`);
      }
      return { ok: true, status: 200, json: async () => request.data };
    };

    await expect(provider.uploadFile("notes/a.md", new ArrayBuffer(0), Date.parse("2026-01-03T00:00:00Z"))).resolves.toBeUndefined();
    expect(methods).toEqual(["GET", "GET", "PATCH", "PATCH"]);
  });
});
