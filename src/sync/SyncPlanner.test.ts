import { describe, expect, it } from "vitest";
import { buildSyncPlan } from "./SyncPlanner";

const file = (path: string, mtime: number, size: number, hash = "h") => ({ path, mtime, size, hash });
const plan = (mode: any, local: any[], remote: any[], files = {}) =>
  buildSyncPlan({ local, remote, manifestFiles: files, mode, conflictStrategy: "keep-newer", now: new Date("2026-08-20T00:00:00Z") });

describe("buildSyncPlan", () => {
  it("uploads a local-only file in upload-only mode", () => {
    expect(plan("upload-only", [file("a.md", 2, 1)], []).actions).toMatchObject([{ type: "upload", path: "a.md" }]);
  });

  it("downloads a remote-only file in download-only mode", () => {
    expect(plan("download-only", [], [file("a.md", 2, 1)]).actions).toMatchObject([{ type: "download", path: "a.md" }]);
  });

  it("restores a missing side rather than deleting in bidirectional mode", () => {
    expect(plan("bidirectional", [], [file("a.md", 2, 1)], { "a.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "h" } }).actions)
      .toMatchObject([{ type: "download", path: "a.md" }]);
  });

  it("moves a previously synced missing local file to remote trash in upload-delete mode", () => {
    expect(plan("upload-delete", [], [file("a.md", 2, 1)], { "a.md": { localMtime: 1, remoteMtime: 2, size: 1, hash: "h" } }).actions)
      .toMatchObject([{ type: "move-remote-to-trash", path: "a.md" }]);
  });

  it("deletes a previously synced missing remote file locally in download-delete mode", () => {
    expect(plan("download-delete", [file("a.md", 2, 1)], [], { "a.md": { localMtime: 2, remoteMtime: 1, size: 1, hash: "h" } }).actions)
      .toMatchObject([{ type: "delete-local", path: "a.md" }]);
  });

  it("skips equal content even when mtimes differ", () => {
    expect(plan("bidirectional", [file("a.md", 5, 1, "same")], [file("a.md", 9, 1, "same")]).actions).toEqual([]);
  });

  it("does not silently overwrite same-size different-content changes", () => {
    const actions = plan("bidirectional", [file("a.md", 5, 4, "local")], [file("a.md", 5, 4, "remote")], {
      "a.md": { localMtime: 1, remoteMtime: 1, size: 4, hash: "base" },
    }).actions;
    expect(actions.map((action) => action.type)).toContain("create-conflict-copy");
  });

  it("uses size when keep-newer timestamps tie", () => {
    const actions = buildSyncPlan({
      local: [file("a.md", 5, 7, "local")], remote: [file("a.md", 5, 3, "remote")],
      manifestFiles: { "a.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "base" } },
      mode: "bidirectional", conflictStrategy: "keep-newer", now: new Date("2026-08-20T00:00:00Z"),
    }).actions;
    expect(actions).toMatchObject([{ type: "upload", path: "a.md" }]);
  });

  it("does not count pure creation as destructive", () => {
    const result = plan("upload-only", [file("new.md", 2, 1)], []);
    expect(result.destructivePathCount).toBe(0);
  });

  it("counts a planned remote-trash move as destructive", () => {
    const result = plan("upload-delete", [], [file("old.md", 2, 1)], {
      "old.md": { localMtime: 1, remoteMtime: 1, size: 1, hash: "h" },
    });
    expect(result).toMatchObject({ destructivePathCount: 1, comparableExistingPathCount: 1 });
  });
});
