# Sync Progress and Protection UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make large-change protection understandable and expose reliable per-provider, per-action sync progress.

**Architecture:** Keep the sync planner and protection decision in `SyncService`, emitting a planning progress event before the protection gate. Keep presentation in `main.ts` and `SyncStatusBar`, with provider-prefixed messages. Replace the single numeric threshold control in `SettingsTab` with preset/custom controls while preserving the existing numeric setting.

**Tech Stack:** TypeScript, Vitest, Obsidian DOM helpers, esbuild.

## Global Constraints

- Threshold values are integers from 0 through 100.
- Presets are exactly 0, 10, 20, …, 100; 0 means protection disabled.
- Custom values remain persisted as numeric `largeChangeThreshold` values.
- A blocked sync must emit `sync-error` and must not emit `sync-complete`.
- Existing sync direction, trash, manifest, and provider behavior must remain unchanged.

---

### Task 1: Emit planned progress before protection and identify blocked syncs

**Files:**
- Modify: `src/sync/SyncService.ts`
- Test: `src/sync/SyncService.test.ts`

- [ ] Add a failing test asserting a threshold-blocked sync emits `sync-progress` with `0/N` before one `sync-error` whose message starts with `Sync not executed`.
- [ ] Run the focused service test and verify it fails because progress is currently emitted after the threshold gate and the message is generic.
- [ ] Emit `sync-progress` immediately after plan creation with `Planned N sync actions` and `{ current: 0, total: N }`.
- [ ] Change the protection message to explicitly state that sync was not executed, then return without executing actions or emitting completion.
- [ ] Run the focused service test and the full suite.
- [ ] Commit the service behavior.

### Task 2: Provider-specific status and completion presentation

**Files:**
- Modify: `main.ts`
- Modify: `src/ui/SyncStatusBar.ts`

- [ ] Add a failing presentation test or pure helper assertion for provider-prefixed completion and blocked messages if the existing test harness supports it; otherwise validate through TypeScript and the existing event wiring.
- [ ] Use the event message for completion notices/status text so each provider is named.
- [ ] Keep progress rendering as `[PROVIDER] 同步中 current/total`, including the initial planned `0/N` event.
- [ ] Ensure error presentation says `同步未執行` for protection blocks and clears the syncing indicator.
- [ ] Run the full test suite and production build.
- [ ] Commit the presentation changes.

### Task 3: Preset and custom threshold control

**Files:**
- Modify: `src/ui/SettingsTab.ts`
- Test: `src/ui/SettingsTab.test.ts` (create if the current UI test harness can support the pure threshold helper)

- [ ] Add a small pure threshold-control helper/test for preset detection and custom fallback, or document manual UI verification if Obsidian DOM is unavailable in the current harness.
- [ ] Replace the numeric-only control with a select containing 0–100 in steps of 10 plus `自訂`.
- [ ] Label preset 0 as `0（關閉保護）`, and display the custom numeric input only for non-preset values.
- [ ] Persist preset and custom values through `largeChangeThreshold`, clamp custom input to 0–100, and initialize the control from existing settings.
- [ ] Update the explanatory copy to describe 0, 100, and custom values.
- [ ] Run tests, build, and diff checks.
- [ ] Commit the settings UI.

### Task 4: Documentation and final verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] Document the preset/custom protection setting and the planned/progress/blocked status behavior.
- [ ] Run `npm test -- --run`, `npm run build`, and `git diff --check`.
- [ ] Review the complete branch diff and commit documentation.
