import { describe, expect, it } from "vitest";
import { findPublicDuplicatePaths, isPublicPath } from "./PublicDuplicateCleanup";

describe("PublicDuplicateCleanup", () => {
  it("recognizes only files directly under public", () => {
    expect(isPublicPath("public/new.md")).toBe(true);
    expect(isPublicPath("public/assets/new.md")).toBe(false);
    expect(isPublicPath("Public/new.md")).toBe(false);
  });

  it("returns new public files whose basename exists in another folder", () => {
    expect(findPublicDuplicatePaths([
      "public/note.md",
      "Projects/note.md",
      "public/unique.md",
      "Projects/other.md",
    ], new Set(["public/note.md", "public/unique.md"]))).toEqual([
      "public/note.md",
    ]);
  });

  it("does not treat another public file as a categorized duplicate", () => {
    expect(findPublicDuplicatePaths([
      "public/note.md",
      "public/archive/note.md",
    ], new Set(["public/note.md"]))).toEqual([]);
  });
});
