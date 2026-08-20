# Task 5 Report: 大量變更保護、設定與介面

## Delivered

- Added `localDeleteDestination` (`system-trash` by default) and `largeChangeThreshold` (50 by default) to persisted settings, and migrated legacy `sync-delete` values to `upload-delete`.
- Passed both settings to every `SyncService` created by manual sync and trash cleanup.
- Added five sync-mode choices, the remote-trash explanation, a conditional local-delete destination selector, and a persisted large-change threshold input.
- Added plan-level large-change protection before `executePlan()`. It emits a single `sync-error` summary and throws `large change protection` without calling vault or provider mutation methods.
- Added read-only conflict-copy scanning for timestamped `.conflict-YYYY-MM-DDT...` paths, followed by a listed modal and a second confirmation modal. Deletion accepts only the exact path list from the immediately preceding scan and uses the configured local trash destination.

## TDD evidence

1. Added the threshold-protection and conflict-copy scan tests before implementation.
2. `npm test -- --run src/sync/SyncService.test.ts` initially failed as expected:
   - threshold test: `promise resolved "undefined" instead of rejecting`;
   - scan test: `findConflictCopies is not a function`.
3. Implemented the minimum service behavior, then reran the focused suite successfully.

The threshold test uses a valid v2 manifest so that `download-delete` actually plans destructive actions. It asserts no vault actions and no provider upload/delete actions; connect/list/disconnect are read-only setup/teardown calls and therefore intentionally excluded from the mutation assertion.

## Verification

- `npm test -- --run src/sync/SyncService.test.ts` — 16/16 passed.
- `npm test -- --run` — 33/33 passed across 3 test files.
- `npm run build` — exited 0 (`tsc -noEmit -skipLibCheck` and production esbuild).
- `git diff --check` — no whitespace errors.

The production build regenerated tracked `main.js`; that generated-only change was reverted so the commit contains only the requested source, test, and report files.
