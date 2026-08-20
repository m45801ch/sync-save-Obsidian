export type SyncMode =
  | "bidirectional"
  | "upload-only"
  | "download-only"
  | "upload-delete"
  | "download-delete";

export type ConflictStrategy = "keep-newer" | "keep-larger" | "smart";

export interface FileSnapshot {
  path: string;
  mtime: number;
  size: number;
  hash?: string;
}

export interface ManifestFileState {
  localMtime: number;
  remoteMtime: number;
  size: number;
  hash: string;
}

export type SyncActionType =
  | "upload"
  | "download"
  | "move-remote-to-trash"
  | "delete-local"
  | "create-conflict-copy"
  | "skip";

export interface SyncAction {
  type: SyncActionType;
  path: string;
  source?: "local" | "remote";
  targetPath?: string;
  reason: string;
}

export interface SyncPlan {
  actions: SyncAction[];
  destructivePathCount: number;
  comparableExistingPathCount: number;
}

function conflictPath(path: string, now: Date): string {
  const dot = path.lastIndexOf(".");
  const base = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
  const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  return `${base}.conflict-${now.toISOString().replace(/[:.]/g, "-")}${ext}`;
}

export function buildSyncPlan(input: {
  local: FileSnapshot[];
  remote: FileSnapshot[];
  manifestFiles: Record<string, ManifestFileState>;
  mode: SyncMode;
  conflictStrategy: ConflictStrategy;
  now: Date;
}): SyncPlan {
  const localByPath = new Map(input.local.map((entry) => [entry.path, entry]));
  const remoteByPath = new Map(input.remote.map((entry) => [entry.path, entry]));
  const paths = new Set([...localByPath.keys(), ...remoteByPath.keys()]);
  const conflictStrategy = input.conflictStrategy ?? "keep-newer";
  const actions: SyncAction[] = [];
  const add = (type: SyncActionType, path: string, reason: string, targetPath?: string, source?: "local" | "remote") =>
    actions.push({ type, path, reason, targetPath, source });
  const resolveConflict = (path: string, local: FileSnapshot, remote: FileSnapshot) => {
    if (conflictStrategy === "smart") {
      const localIsNewer = local.mtime > remote.mtime;
      const remoteIsNewer = remote.mtime > local.mtime;
      if (localIsNewer || remoteIsNewer) {
        const winner = localIsNewer ? "local" : "remote";
        add("create-conflict-copy", path, "both sides changed after last sync", conflictPath(path, input.now), winner === "local" ? "remote" : "local");
        add(winner === "local" ? "upload" : "download", path, `smart conflict keeps ${winner} original`);
        return;
      }
    } else {
      const localWins = conflictStrategy === "keep-newer"
        ? local.mtime > remote.mtime || (local.mtime === remote.mtime && local.size > remote.size)
        : local.size > remote.size || (local.size === remote.size && local.mtime > remote.mtime);
      const remoteWins = conflictStrategy === "keep-newer"
        ? remote.mtime > local.mtime || (local.mtime === remote.mtime && remote.size > local.size)
        : remote.size > local.size || (local.size === remote.size && remote.mtime > local.mtime);
      if (localWins || remoteWins) {
        add(localWins ? "upload" : "download", path, `${conflictStrategy} resolved conflict`);
        return;
      }
    }

    add("create-conflict-copy", path, "same mtime and size with different hash", conflictPath(path, input.now), "remote");
    add("upload", path, "smart conflict keeps local original");
  };

  for (const path of paths) {
    const local = localByPath.get(path);
    const remote = remoteByPath.get(path);
    const previous = input.manifestFiles[path];

    if (local && !remote) {
      if (input.mode === "download-delete" && previous) add("delete-local", path, "remote deleted after last sync");
      else if (input.mode !== "download-only") add("upload", path, "local-only file");
      continue;
    }
    if (!local && remote) {
      if (input.mode === "upload-delete" && previous) add("move-remote-to-trash", path, "local deleted after last sync");
      else if (input.mode !== "upload-only") add("download", path, "remote-only file");
      continue;
    }
    if (!local || !remote || local.hash === remote.hash) continue;

    if (input.mode === "upload-only") {
      add("upload", path, "upload-only mode keeps local source");
      continue;
    }
    if (input.mode === "download-only") {
      add("download", path, "download-only mode keeps remote source");
      continue;
    }

    const localChanged = !previous || local.hash !== previous.hash;
    const remoteChanged = !previous || remote.hash !== previous.hash;
    if (localChanged && !remoteChanged) add("upload", path, "local changed after last sync");
    else if (!localChanged && remoteChanged) add("download", path, "remote changed after last sync");
    else if (localChanged && remoteChanged) resolveConflict(path, local, remote);
  }

  const comparableExistingPaths = new Set(
    [...paths].filter((path) => input.manifestFiles[path] || (localByPath.has(path) && remoteByPath.has(path))),
  );
  const destructivePaths = new Set(
    actions
      .filter((action) =>
        action.type === "move-remote-to-trash" ||
        action.type === "delete-local" ||
        (action.type === "upload" && remoteByPath.has(action.path)) ||
        (action.type === "download" && localByPath.has(action.path)),
      )
      .map((action) => action.path),
  );

  return {
    actions,
    destructivePathCount: destructivePaths.size,
    comparableExistingPathCount: comparableExistingPaths.size,
  };
}
