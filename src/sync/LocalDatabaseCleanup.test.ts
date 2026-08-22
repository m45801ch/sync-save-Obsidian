import { describe, expect, it } from "vitest";
import { findDuplicatePublicPaths } from "./LocalDatabaseCleanup";

describe("LocalDatabaseCleanup", () => {
  it("finds public files duplicated by any non-public folder at any depth", () => {
    expect(findDuplicatePublicPaths([
      "public/note.md",
      "public/archive/image.png",
      "Projects/note.md",
      "Media/archive/image.png",
      "public/unique.md",
    ])).toEqual([
      "public/note.md",
      "public/archive/image.png",
    ]);
  });

  it("preserves non-public files and ignores duplicate files only inside public", () => {
    expect(findDuplicatePublicPaths([
      "Projects/note.md",
      "Archive/note.md",
      "public/archive/note.md",
      "public/another/note.md",
    ])).toEqual([
      "public/archive/note.md",
      "public/another/note.md",
    ]);
  });

  it("returns no paths when public files have no non-public duplicate", () => {
    expect(findDuplicatePublicPaths([
      "public/note.md",
      "public/archive/note.md",
      "Projects/other.md",
    ])).toEqual([]);
  });
});
