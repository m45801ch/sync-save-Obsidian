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

  it("treats a legacy version 1 manifest as an empty baseline", async () => {
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

    expect(plan.actions).toMatchObject([{ type: "download", path: "remote.md" }]);
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
