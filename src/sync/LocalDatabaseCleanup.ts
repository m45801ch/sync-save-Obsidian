const PUBLIC_PREFIX = "public/";

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isUnderPublic(path: string): boolean {
  return normalizePath(path).startsWith(PUBLIC_PREFIX);
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
    if (!isUnderPublic(path)) return false;
    const name = baseName(path);
    return (grouped.get(name) ?? []).some((otherPath) => !isUnderPublic(otherPath));
  });
}
