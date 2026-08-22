const PUBLIC_PREFIX = "public/";

export function isPublicPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith(PUBLIC_PREFIX) && !normalized.slice(PUBLIC_PREFIX.length).includes("/");
}

function isUnderPublic(path: string): boolean {
  return path.replace(/\\/g, "/").startsWith(PUBLIC_PREFIX);
}

function baseName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function findPublicDuplicatePaths(paths: string[], candidates: ReadonlySet<string>): string[] {
  const pathsByName = new Map<string, string[]>();
  for (const path of paths) {
    const name = baseName(path);
    const grouped = pathsByName.get(name) ?? [];
    grouped.push(path);
    pathsByName.set(name, grouped);
  }

  return paths.filter((path) => {
    if (!isPublicPath(path) || !candidates.has(path)) return false;
    return (pathsByName.get(baseName(path)) ?? []).some((otherPath) => otherPath !== path && !isUnderPublic(otherPath));
  });
}
