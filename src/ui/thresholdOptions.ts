export const THRESHOLD_PRESETS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function getThresholdSelection(value: number): string {
  return THRESHOLD_PRESETS.includes(value as (typeof THRESHOLD_PRESETS)[number]) ? String(value) : "custom";
}

export function normalizeThreshold(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.round(Math.min(100, Math.max(0, value)));
}
