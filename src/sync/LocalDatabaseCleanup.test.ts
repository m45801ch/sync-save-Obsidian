import { describe, expect, it } from "vitest";
import { findDuplicatePublicPaths } from "./LocalDatabaseCleanup";

describe("LocalDatabaseCleanup", () => {
  it("finds root files duplicated by any nested folder at any depth", () => {
    expect(findDuplicatePublicPaths([
      "note.md",
      "image.png",
      "Projects/note.md",
      "Media/archive/image.png",
      "unique.md",
    ])).toEqual([
      "note.md",
      "image.png",
    ]);
  });

  it("preserves nested files and ignores duplicates only inside nested folders", () => {
    expect(findDuplicatePublicPaths([
      "Projects/note.md",
      "Archive/note.md",
      "archive/note.md",
      "another/note.md",
    ])).toEqual([]);
  });

  it("returns no paths when root files have no nested duplicate", () => {
    expect(findDuplicatePublicPaths([
      "note.md",
      "Projects/other.md",
    ])).toEqual([]);
  });
});
