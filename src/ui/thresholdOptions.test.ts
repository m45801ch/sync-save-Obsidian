import { describe, expect, it } from "vitest";
import { getThresholdSelection, normalizeThreshold, THRESHOLD_PRESETS } from "./thresholdOptions";

describe("threshold options", () => {
  it("provides presets from zero through one hundred in ten-point steps", () => {
    expect(THRESHOLD_PRESETS).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("uses custom selection for non-preset saved values", () => {
    expect(getThresholdSelection(50)).toBe("50");
    expect(getThresholdSelection(35)).toBe("custom");
  });

  it("clamps custom values to the supported range", () => {
    expect(normalizeThreshold(-1)).toBe(0);
    expect(normalizeThreshold(42.8)).toBe(43);
    expect(normalizeThreshold(101)).toBe(100);
  });
});
