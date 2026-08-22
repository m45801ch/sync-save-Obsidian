import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { CloudProvider, SyncFile } from "./CloudProvider";
import { Encryption } from "./Encryption";
import { SyncEvent, SyncOptions, SyncService } from "./SyncService";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function copyBuffer(data: ArrayBuffer): ArrayBuffer {
  return data.slice(0);
}

function createVault(initial: Record<string, string | ArrayBuffer>) {
  const files = new Map<string, { content: ArrayBuffer; mtime: number }>();
  const calls: string[] = [];
  for (const [path, content] of Object.entries(initial)) {
    files.set(path, {
      content: typeof content === "string" ? encoder.encode(content).buffer : copyBuffer(content),
      mtime: 1,
    });
  }

  const fileFor = (path: string) => Object.assign(new TFile(), { path });
  const vault = {
    adapter: {
      exists: async (path: string) => files.has(path),
      stat: async (path: string) => {
        const file = files.get(path);
        return file ? { type: "file", ctime: file.mtime, mtime: file.mtime, size: file.content.byteLength } : null;
      },
      rename: async (from: string, to: string) => {
        calls.push(`rename:${from}:${to}`);
        const file = files.get(from);
        if (!file) throw new Error(`missing source: ${from}`);
        files.set(to, file);
        files.delete(from);
      },
      remove: async (path: string) => {
        calls.push(`remove:${path}`);
        files.delete(path);
      },
      trashSystem: async (path: string) => {
        calls.push(`trashSystem:${path}`);
        return files.delete(path);
      },
      trashLocal: async (path: string) => {
        calls.push(`trashLocal:${path}`);
        files.delete(path);
      },
    },
    getFiles: () => [...files.keys()].map(fileFor),
    getAbstractFileByPath: (path: string) => files.has(path) ? fileFor(path) : null,
    readBinary: async (file: { path: string }) => copyBuffer(files.get(file.path)!.content),
    createBinary: async (path: string, content: ArrayBuffer) => {
      calls.push(`createBinary:${path}`);
      if (files.has(path)) throw new Error(`already exists: ${path}`);
      files.set(path, { content: copyBuffer(content), mtime: Date.now() });
      return fileFor(path);
    },
    modifyBinary: async (file: { path: string }, content: ArrayBuffer) => {
      calls.push(`modifyBinary:${file.path}`);
      files.set(file.path, { content: copyBuffer(content), mtime: Date.now() });
    },
    createFolder: async () => undefined,
    getName: () => "test-vault",
    readText: (path: string) => decoder.decode(files.get(path)!.content),
    readBytes: (path: string) => copyBuffer(files.get(path)!.content),
    calls,
  };

  return vault;
}

type FakeProvider = CloudProvider & { calls: string[] };

function createProvider(input: {
  listed: { path: string; mtime: number; size: number }[];
  downloaded: SyncFile | SyncFile[];
}): FakeProvider {
  const listed = input.listed.map((file) => ({ ...file }));
  const downloaded = new Map(
    (Array.isArray(input.downloaded) ? input.downloaded : [input.downloaded])
      .map((file) => [file.path, file]),
  );
  const calls: string[] = [];

  return new class extends CloudProvider {
    readonly name = "fake";
    readonly icon = "fake";
    readonly calls = calls;

    async connect() { calls.push("connect"); return true; }
    async disconnect() { calls.push("disconnect"); }
    isConnected() { return true; }
    async listFiles() { calls.push("list"); return listed.map((file) => ({ ...file })); }
    async downloadFile(path: string) {
      calls.push(`download:${path}`);
      const file = downloaded.get(path);
      if (file) return { ...file, content: copyBuffer(file.content) };
      throw new Error(`not found: ${path}`);
    }
    async uploadFile(path: string, content: ArrayBuffer, mtime: number) {
      calls.push(`upload:${path}`);
      const file = { path, content: copyBuffer(content), mtime, size: content.byteLength };
      downloaded.set(path, file);
      const index = listed.findIndex((entry) => entry.path === path);
      const metadata = { path, mtime, size: content.byteLength };
      if (index >= 0) listed[index] = metadata;
      else listed.push(metadata);
    }
    async deleteFile(path: string) {
      calls.push(`delete:${path}`);
      downloaded.delete(path);
      const index = listed.findIndex((entry) => entry.path === path);
      if (index >= 0) listed.splice(index, 1);
    }
    async testConnection() { return { success: true, message: "ok" }; }
    getSettingsDisplay() { return {}; }
  }();
}

function createService(
  vault: ReturnType<typeof createVault>,
  provider: CloudProvider,
  overrides: Partial<SyncOptions> = {},
) {
  return new SyncService(vault as any, {
    provider,
    encryption: new Encryption(""),
    vaultName: "test-vault",
    syncOnSave: false,
    syncInterval: 0,
    skipHidden: false,
    skipPaths: [],
    conflictStrategy: "keep-newer",
    syncConfig: true,
    syncMode: "bidirectional",
    localDeleteDestination: "system-trash",
    largeChangeThreshold: 50,
    ...overrides,
  });
}

function manifestFile(version: 1 | 2, files: Record<string, unknown>): SyncFile {
  const content = encoder.encode(JSON.stringify({
    version,
    files,
    timestamp: 1,
    vaultName: "test-vault",
  })).buffer;
  return { path: ".sync-manifest.json", mtime: 1, size: content.byteLength, content };
}

describe("SyncService", () => {
  it("does not mutate when destructive change percentage exceeds the threshold", async () => {
    const manifest = manifestFile(2, {
      "a.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "a" },
      "b.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "b" },
    });
    const vault = createVault({ "a.md": "a", "b.md": "b" });
    const provider = createProvider({
      listed: [{ path: manifest.path, mtime: manifest.mtime, size: manifest.size }],
      downloaded: manifest,
    });
    const service = createService(vault, provider, {
      syncMode: "download-delete",
      largeChangeThreshold: 50,
    });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.calls).toEqual([]);
    expect(provider.calls.filter((call) => call.startsWith("upload:") || call.startsWith("delete:"))).toEqual([]);
    expect(events.filter((event) => event.type === "sync-error")).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("同步未執行"),
      }),
    ]);
  });

  it("moves a newly pulled public duplicate to the local recycle bin and reports counts", async () => {
    const manifest = manifestFile(2, {});
    const publicFile = { path: "public/note.md", mtime: 2, size: 8, content: encoder.encode("new note").buffer };
    const vault = createVault({ "Projects/note.md": "categorized" });
    const provider = createProvider({
      listed: [
        { path: manifest.path, mtime: manifest.mtime, size: manifest.size },
        { path: publicFile.path, mtime: publicFile.mtime, size: publicFile.size },
      ],
      downloaded: [manifest, publicFile],
    });
    const service = createService(vault, provider, {
      syncMode: "download-only",
      largeChangeThreshold: 0,
    });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await service.sync();

    expect(vault.calls).toContain("trashSystem:public/note.md");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-summary",
      summary: { total: 3, success: 3, failed: 0, trashed: 2 },
    }));
  });

  it("整理本地資料庫只移動根目錄重複檔，不接觸雲端或分類檔", async () => {
    const vault = createVault({
      "note.md": "public copy",
      "image.png": encoder.encode("public image").buffer,
      "Projects/note.md": "categorized copy",
      "Media/archive/image.png": encoder.encode("categorized image").buffer,
    });
    const provider = createProvider({ listed: [], downloaded: [] });
    const service = createService(vault, provider, {
      syncMode: "local-cleanup" as any,
      largeChangeThreshold: 50,
    });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await service.sync();

    expect(vault.calls).toEqual([
      "trashSystem:note.md",
      "trashSystem:image.png",
    ]);
    expect(vault.getFiles().map((file) => file.path)).toEqual([
      "Projects/note.md",
      "Media/archive/image.png",
    ]);
    expect(provider.calls).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-summary",
      summary: { total: 4, success: 2, failed: 0, trashed: 2 },
    }));
  });

  it("reports the planned action count before blocking a large change", async () => {
    const manifest = manifestFile(2, {
      "a.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "a" },
      "b.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "b" },
    });
    const vault = createVault({ "a.md": "a", "b.md": "b" });
    const provider = createProvider({
      listed: [{ path: manifest.path, mtime: manifest.mtime, size: manifest.size }],
      downloaded: manifest,
    });
    const service = createService(vault, provider, {
      syncMode: "download-delete",
      largeChangeThreshold: 50,
    });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await service.sync();

    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-progress",
      message: expect.stringContaining("Planned 2 sync actions"),
      progress: { current: 0, total: 2 },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("因大量變更保護-同步未執行"),
    }));
    expect(events.some((event) => event.type === "sync-complete")).toBe(false);
  });

  it("finds only timestamped conflict copies", async () => {
    const vault = createVault({
      "note.conflict-2026-08-20T00-00-00-000Z.md": "conflict",
      "note.conflict-copy.md": "not a conflict copy",
      "plain.md": "plain",
    });
    const provider = createProvider({ listed: [], downloaded: [] });

    await expect(createService(vault, provider).findConflictCopies()).resolves.toEqual([
      "note.conflict-2026-08-20T00-00-00-000Z.md",
    ]);
  });

  it("scans conflict copies without a cloud provider", async () => {
    const vault = createVault({
      "note.conflict-2026-08-20T00-00-00-000Z.md": "conflict",
      "plain.md": "plain",
    });

    await expect(SyncService.findConflictCopies(vault as any)).resolves.toEqual([
      "note.conflict-2026-08-20T00-00-00-000Z.md",
    ]);
  });

  it("does not overwrite an existing local file when remote byte length differs from listed metadata", async () => {
    const vault = createVault({ "a.md": "safe local content" });
    const provider = createProvider({
      listed: [{ path: "a.md", mtime: 2, size: 20 }],
      downloaded: { path: "a.md", mtime: 2, size: 2, content: encoder.encode("{}").buffer },
    });
    const service = createService(vault, provider);
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe local content");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("download size mismatch"),
    }));
    expect(provider.calls).not.toContain("upload:.sync-manifest.json");
  });

  it("does not make overwrite decisions when the manifest cannot be parsed", async () => {
    const invalidManifest = {
      path: ".sync-manifest.json",
      mtime: 1,
      size: 1,
      content: encoder.encode("{").buffer,
    };
    const remote = { path: "a.md", mtime: 2, size: 3, content: encoder.encode("new").buffer };
    const vault = createVault({ "a.md": "safe" });
    const provider = createProvider({
      listed: [
        { path: invalidManifest.path, mtime: invalidManifest.mtime, size: invalidManifest.size },
        { path: remote.path, mtime: remote.mtime, size: remote.size },
      ],
      downloaded: [invalidManifest, remote],
    });
    const service = createService(vault, provider);
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("invalid sync manifest"),
    }));
    expect(provider.calls).not.toContain("upload:.sync-manifest.json");
  });

  it("does not make overwrite decisions when manifest size verification fails", async () => {
    const invalidManifest = {
      path: ".sync-manifest.json",
      mtime: 1,
      size: 2,
      content: encoder.encode("{}").buffer,
    };
    const remote = { path: "a.md", mtime: 2, size: 3, content: encoder.encode("new").buffer };
    const vault = createVault({ "a.md": "safe" });
    const provider = createProvider({
      listed: [
        { path: invalidManifest.path, mtime: invalidManifest.mtime, size: 20 },
        { path: remote.path, mtime: remote.mtime, size: remote.size },
      ],
      downloaded: [invalidManifest, remote],
    });
    const service = createService(vault, provider);
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("download size mismatch: .sync-manifest.json"),
    }));
    expect(provider.calls).not.toContain("upload:.sync-manifest.json");
  });

  it("does not make overwrite decisions when manifest decryption fails", async () => {
    const encryptedManifest = {
      path: ".sync-manifest.json",
      mtime: 1,
      size: 3,
      content: encoder.encode("bad").buffer,
    };
    const vault = createVault({ "a.md": "safe" });
    const provider = createProvider({
      listed: [{ path: encryptedManifest.path, mtime: encryptedManifest.mtime, size: encryptedManifest.size }],
      downloaded: encryptedManifest,
    });
    const encryption = new Encryption("enabled");
    encryption.decrypt = async () => null;
    encryption.encrypt = async (data: ArrayBuffer) => data;
    const service = createService(vault, provider, { encryption });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("decryption failed"),
    }));
    expect(provider.calls).not.toContain("upload:a.md");
    expect(provider.calls).not.toContain("upload:.sync-manifest.json");
  });

  it("blocks upload-delete actions for every malformed v2 manifest entry field", async () => {
    const malformedEntries = [
      { localMtime: "bad", remoteMtime: 1, size: 3, hash: "old" },
      { localMtime: 1, remoteMtime: "bad", size: 3, hash: "old" },
      { localMtime: 1, remoteMtime: 1, size: "bad", hash: "old" },
      { localMtime: 1, remoteMtime: 1, size: 3, hash: 42 },
    ];

    for (const malformedEntry of malformedEntries) {
      const manifest = manifestFile(2, { "old.md": malformedEntry });
      const old = { path: "old.md", mtime: 2, size: 3, content: encoder.encode("old").buffer };
      const vault = createVault({});
      const provider = createProvider({
        listed: [
          { path: manifest.path, mtime: manifest.mtime, size: manifest.size },
          { path: old.path, mtime: old.mtime, size: old.size },
        ],
        downloaded: [manifest, old],
      });
      const service = createService(vault, provider, { syncMode: "upload-delete" });
      const events: SyncEvent[] = [];
      service.on((event) => events.push(event));

      await expect(service.sync()).resolves.toBeUndefined();

      expect(provider.calls).not.toContain("delete:old.md");
      expect(provider.calls.some((call) => call.startsWith("upload:.sync-trash/"))).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({
        type: "sync-error",
        message: expect.stringContaining("invalid sync manifest entry: old.md"),
      }));
    }
  });

  it("blocks download-delete actions for non-finite v2 manifest entry numbers", async () => {
    const numericFields = ["localMtime", "remoteMtime", "size"] as const;

    for (const nonFiniteField of numericFields) {
      const values = { localMtime: "1", remoteMtime: "1", size: "4" };
      values[nonFiniteField] = "1e400";
      const content = encoder.encode(
        `{"version":2,"files":{"gone.md":{"localMtime":${values.localMtime},"remoteMtime":${values.remoteMtime},"size":${values.size},"hash":"gone"}},"timestamp":1,"vaultName":"test-vault"}`,
      ).buffer;
      const manifest = { path: ".sync-manifest.json", mtime: 1, size: content.byteLength, content };
      const vault = createVault({ "gone.md": "gone" });
      const provider = createProvider({
        listed: [{ path: manifest.path, mtime: manifest.mtime, size: manifest.size }],
        downloaded: manifest,
      });
      const service = createService(vault, provider, { syncMode: "download-delete" });
      const events: SyncEvent[] = [];
      service.on((event) => events.push(event));

      await expect(service.sync()).resolves.toBeUndefined();

      expect(vault.getFiles().map((file) => file.path)).toContain("gone.md");
      expect(vault.calls).not.toContain("trashSystem:gone.md");
      expect(vault.calls).not.toContain("trashLocal:gone.md");
      expect(events).toContainEqual(expect.objectContaining({
        type: "sync-error",
        message: expect.stringContaining("invalid sync manifest entry: gone.md"),
      }));
    }
  });

  it("preserves the target and removes only the temp file when temporary stat verification fails", async () => {
    const vault = createVault({ "a.md": "safe" });
    const originalStat = vault.adapter.stat;
    vault.adapter.stat = async (path: string) => {
      const stat = await originalStat(path);
      return stat && path.includes(".sync-save-tmp-") ? { ...stat, size: stat.size + 1 } : stat;
    };
    const provider = createProvider({
      listed: [{ path: "a.md", mtime: 2, size: 3 }],
      downloaded: { path: "a.md", mtime: 2, size: 3, content: encoder.encode("new").buffer },
    });
    const service = createService(vault, provider, { largeChangeThreshold: 0 });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe");
    expect(vault.getFiles().map((file) => file.path)).toEqual(["a.md"]);
    expect(vault.calls.filter((call) => call.startsWith("remove:"))).toHaveLength(1);
    expect(vault.calls).not.toContain("remove:a.md");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("temporary write mismatch: a.md"),
    }));
  });

  it("preserves the target and removes only the temp file when atomic rename fails", async () => {
    const vault = createVault({ "a.md": "safe" });
    vault.adapter.rename = async (from: string, to: string) => {
      vault.calls.push(`rename:${from}:${to}`);
      throw new Error("rename failed");
    };
    const provider = createProvider({
      listed: [{ path: "a.md", mtime: 2, size: 3 }],
      downloaded: { path: "a.md", mtime: 2, size: 3, content: encoder.encode("new").buffer },
    });
    const service = createService(vault, provider, { largeChangeThreshold: 0 });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(vault.readText("a.md")).toBe("safe");
    expect(vault.getFiles().map((file) => file.path)).toEqual(["a.md"]);
    expect(vault.calls.filter((call) => call.startsWith("remove:"))).toHaveLength(1);
    expect(vault.calls).not.toContain("remove:a.md");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("rename failed"),
    }));
  });

  it("does not delete the remote source when its trash upload fails", async () => {
    const manifest = manifestFile(2, {
      "old.md": { localMtime: 1, remoteMtime: 1, size: 3, hash: "old" },
    });
    const old = { path: "old.md", mtime: 2, size: 3, content: encoder.encode("old").buffer };
    const vault = createVault({});
    const provider = createProvider({
      listed: [
        { path: manifest.path, mtime: manifest.mtime, size: manifest.size },
        { path: old.path, mtime: old.mtime, size: old.size },
      ],
      downloaded: [manifest, old],
    });
    const originalUpload = provider.uploadFile.bind(provider);
    provider.uploadFile = async (path: string, content: ArrayBuffer, mtime: number) => {
      if (path.startsWith(".sync-trash/")) {
        provider.calls.push(`upload:${path}`);
        throw new Error("trash upload failed");
      }
      await originalUpload(path, content, mtime);
    };
    const service = createService(vault, provider, { syncMode: "upload-delete", largeChangeThreshold: 0 });
    const events: SyncEvent[] = [];
    service.on((event) => events.push(event));

    await expect(service.sync()).resolves.toBeUndefined();

    expect(provider.calls.some((call) => call.startsWith("upload:.sync-trash/"))).toBe(true);
    expect(provider.calls).not.toContain("delete:old.md");
    expect(provider.calls).not.toContain("upload:.sync-manifest.json");
    expect(events).toContainEqual(expect.objectContaining({
      type: "sync-error",
      message: expect.stringContaining("trash upload failed"),
    }));
  });

  it("accepts a valid zero-byte remote file", async () => {
    const vault = createVault({});
    const provider = createProvider({
      listed: [{ path: "empty.md", mtime: 2, size: 0 }],
      downloaded: { path: "empty.md", mtime: 2, size: 0, content: new ArrayBuffer(0) },
    });

    await createService(vault, provider).sync();

    expect(vault.readBytes("empty.md").byteLength).toBe(0);
  });

  it("creates a plan without mutating local or remote files", async () => {
    const vault = createVault({});
    const provider = createProvider({
      listed: [{ path: "remote.md", mtime: 2, size: 6 }],
      downloaded: { path: "remote.md", mtime: 2, size: 6, content: encoder.encode("remote").buffer },
    });

    const plan = await createService(vault, provider).createPlan();

    expect(plan.actions).toMatchObject([{ type: "download", path: "remote.md" }]);
    expect(vault.calls).toEqual([]);
    expect(provider.calls.filter((call) => call.startsWith("upload:") || call.startsWith("delete:"))).toEqual([]);
  });

  it("uses the manifest remote size to avoid re-downloading encrypted payloads", async () => {
    const manifest = manifestFile(2, {
      "a.md": { localMtime: 2, remoteMtime: 3, size: 3, remoteSize: 20, hash: "cached" },
    });
    const vault = createVault({ "a.md": "abc" });
    const provider = createProvider({
      listed: [
        { path: manifest.path, mtime: manifest.mtime, size: manifest.size },
        { path: "a.md", mtime: 3, size: 20 },
      ],
      downloaded: [manifest, { path: "a.md", mtime: 3, size: 20, content: encoder.encode("remote").buffer }],
    });

    await createService(vault, provider).createPlan();

    expect(provider.calls).toContain("download:.sync-manifest.json");
    expect(provider.calls).not.toContain("download:a.md");
  });

  it("treats a legacy version 1 manifest as an empty baseline without importing remote-only files", async () => {
    const legacy = manifestFile(1, { "remote.md": { mtime: 1, size: 6, hash: "old" } });
    const remote = { path: "remote.md", mtime: 2, size: 6, content: encoder.encode("remote").buffer };
    const vault = createVault({});
    const provider = createProvider({
      listed: [
        { path: legacy.path, mtime: legacy.mtime, size: legacy.size },
        { path: remote.path, mtime: remote.mtime, size: remote.size },
      ],
      downloaded: [legacy, remote],
    });

    const plan = await createService(vault, provider, { syncMode: "upload-delete" }).createPlan();

    expect(plan.actions).toEqual([]);
  });

  it("executes transfers before remote trash actions even when the plan is reversed", async () => {
    const manifest = manifestFile(2, {
      "old.md": { localMtime: 1, remoteMtime: 1, size: 3, hash: "old" },
    });
    const old = { path: "old.md", mtime: 2, size: 3, content: encoder.encode("old").buffer };
    const vault = createVault({ "new.md": "new" });
    const provider = createProvider({
      listed: [
        { path: manifest.path, mtime: manifest.mtime, size: manifest.size },
        { path: old.path, mtime: old.mtime, size: old.size },
      ],
      downloaded: [manifest, old],
    });
    const service = createService(vault, provider, { syncMode: "upload-delete" });
    const plan = await service.createPlan();
    plan.actions.reverse();

    await service.executePlan(plan);

    const newUpload = provider.calls.indexOf("upload:new.md");
    const oldDelete = provider.calls.indexOf("delete:old.md");
    expect(newUpload).toBeGreaterThan(-1);
    expect(oldDelete).toBeGreaterThan(newUpload);
    expect(provider.calls.some((call) => call.startsWith("upload:.sync-trash/") && call.endsWith("/old.md"))).toBe(true);
  });

  it("uses the configured Obsidian trash adapter for local deletes", async () => {
    const manifest = manifestFile(2, {
      "gone.md": { localMtime: 1, remoteMtime: 1, size: 4, hash: "gone" },
    });
    const vault = createVault({ "gone.md": "gone" });
    const provider = createProvider({
      listed: [{ path: manifest.path, mtime: manifest.mtime, size: manifest.size }],
      downloaded: manifest,
    });
    const service = createService(vault, provider, {
      syncMode: "download-delete",
      localDeleteDestination: "obsidian-trash",
    });

    const plan = await service.createPlan();
    await service.executePlan(plan);

    expect(vault.calls).toContain("trashLocal:gone.md");
  });
});
