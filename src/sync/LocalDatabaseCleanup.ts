function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isRootFile(path: string): boolean {
  return !normalizePath(path).includes("/");
}

function baseName(path: string): string {
  const normalized = normalizePath(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function findDuplicatePublicPaths(paths: string[]): string[] {
  const grouped = new Map<string, string[]>();
  for (const path of paths) {
    const name = baseName(path);
    const group = grouped.get(name) ?? [];
    group.push(path);
    grouped.set(name, group);
  }

  return paths.filter((path) => {
    if (!isRootFile(path)) return false;
    const name = baseName(path);
    return (grouped.get(name) ?? []).some((otherPath) => !isRootFile(otherPath));
  });
}
