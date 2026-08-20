import { vi } from "vitest";

vi.mock(
  "obsidian",
  () => ({
    Notice: class Notice {},
    TFile: class TFile {},
    TFolder: class TFolder {},
  }),
  { virtual: true },
);
