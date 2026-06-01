# Robust large-session startup — design (Dubworx fork)

**Date:** 2026-06-01
**Branch:** `fork/robust-startup`
**Upstream:** sergey-drpa/Tab-Suspender @ 2.0.12 (MIT)
**Fork extension ID (pinned):** `fanmnccbignnlcdfaapeceneedcoiadk`

## Problem

On a cold start with a very large parked session (~1,000 parked tabs), the
extension fails to finish loading: the single MV3 service worker is overwhelmed,
Chromium kills it, it restarts and makes a little progress, dies again — only
"eventually" succeeding after several reboots. "Reload" never completes;
`chrome://extensions` shows *No active views*.

## Root cause (verified)

`background.ts` `start()` → inner `prepare()` closure (~lines 332–347): after
`await SessionRestoreDetector.waitForGroupRestore({parkUrl})` and
`await settings.getOnStorageInitialized()`, it runs
`chrome.tabs.query({active:false})` and, in an unthrottled `for…in` loop, calls
`chrome.tabs.reload()` for **every** parked, faviconless tab. With ~1,000 parked
tabs this fires ~1,000 reloads at once; each reloaded `park.html` re-runs
`park.js`, which `sendMessage`s the one service worker → flood → SW eviction →
crash/restart thrash. Acknowledged upstream (issue #15, open since Apr 2025;
crash reports #21/#53).

## The three changes (all settings-driven, defaults TRUE on this fork branch;
a future upstream PR branch defaults them FALSE = behavior-preserving)

### 1. Hybrid startup favicon refresh (`hybridStartupFaviconRefresh`, `startupEagerScope`)
Eager-reload parked faviconless tabs **only in the focused window**
(`chrome.windows.getLastFocused`), plus a follow-up `active:true` sweep of the
focused window's active tab (which `active:false` excludes). All other parked
tabs are added to a service-worker-scoped `pendingFaviconRefresh` Set and
refreshed lazily — on `chrome.tabs.onActivated` (TabManager) and via the paced
offscreen backfill (below). Decision logic lives in `modules/StartupRefresh.ts`
(`planHybridRefresh`) so it is unit-testable without a browser.

### 2. Offscreen-paced backfill + keep-alive (`useOffscreenKeepAlivePort`, `lazyFaviconRefreshConcurrency`, `lazyRefreshDelayMs`)
The deferred Set is drained gradually by a single `setInterval` hosted in the
**offscreen document** (`lazyFaviconRefreshConcurrency` reloads every
`lazyRefreshDelayMs`), torn down when the queue empties (no perpetual wakeup).
Each batch messages the SW (`[TS:offscreenDocument:reloadParkedTab]`), which
performs the actual reloads (MV3 = single owner) after **re-validating** each
tab (`chrome.tabs.get` + `isTabParked` + empty favicon) so churned/restored tab
ids are skipped. The existing **20s `sendMessage` heartbeat remains the
keep-alive of record** (a quiescent `runtime.connect` port does not reliably
reset the MV3 idle timer); the optional port (`useOffscreenKeepAlivePort`,
default false) is additive hardening only and never silences the heartbeat.

### 3. One-time parked-tab ID migration (`enableParkedTabIdMigration`, `parkedTabMigrationLegacyIds`)
Because a fork gets a new extension ID, existing tabs at
`chrome-extension://<OLD_ID>/park.html?…` would orphan. On `onInstalled`
(install **and** update) and opportunistically on `onStartup`,
`migrateLegacyParkedTabs()` finds any tab whose URL matches
`/^chrome-extension:\/\/([a-p]{32})\/park\.html\?/` where the captured ID **!=**
the current runtime ID (covers the Web Store ID
`fiabciakcmgepblmdkmemdbbkilneeeh` and any prior personal build), and re-points
it to `chrome.runtime.getURL('park.html') + <verbatim query string>` via
`chrome.tabs.update`. The query is preserved **byte-for-byte** (no re-encode),
so the tab stays **suspended** — it does not navigate to the live site.
**Crash-resumable:** the `parkedTabIdMigrationDone` flag is only set once a fresh
`chrome.tabs.query({})` returns **zero** foreign park URLs, and migration re-runs
on `onStartup`, so an interrupted migration finishes later.

## Identity pinning
`manifest.json` carries a top-level `"key"` (our generated public key), pinning
the ID to `fanmnccbignnlcdfaapeceneedcoiadk` deterministically — migrated URLs
never re-break on a load-path change. The matching **private key is stored
outside the repo** at `~/.config/tab-suspender-fork/key.pem` and is never
committed.

## Critical bug caught in review (and fixed)
The first implementation published/read the shared `pendingFaviconRefresh` Set
via Node's `global`, which **does not exist in a classic MV3 service worker**.
It passed all jsdom unit tests (Node defines `global`) but at runtime would
(a) never publish the Set and (b) throw `ReferenceError` on the bare read in
`TabManager.onActivated`/`onRemoved`, silently disabling auto-restore-on-activate
for parked tabs. Fixed by unifying on `globalThis` (defined in SW, jsdom, Node)
at publish and all read sites; added `test/modules/TabManagerGlobalScope.test.ts`.

## Build / test
- Build: `npm run build` → `build_dir/` (tsc + file copy; no bundler). Exit 0.
- Tests: `npx jest` (worker-isolated) → 30 suites, 344 passed, 2 skipped, exit 0.
- ⚠️ `npm test` adds `--runInBand --forceExit`, which surfaces a **pre-existing**
  cross-suite global-state leak (~192 spurious failures) that reproduces on
  pristine upstream `master`. Use `npx jest` as the green baseline.
- No live-browser verification was done (the project's puppeteer tests are
  path-ignored and require a browser; the user's Brave must not be restarted by
  tooling). Final cold-start validation is a manual user reboot — see
  `docs/LOAD_AND_MIGRATE.md`.

## Rollback
The original Web Store extension stays installed-but-disabled. To revert:
re-enable it and remove the unpacked fork. The pre-switch full tab backup lives
at `~/Documents/claude-research/brave-tab-suspender/`.

## Upstream PR (later)
Re-create the diff on a branch with the feature flags defaulting **false** and
omit the manifest `"key"`; everything else is additive and flag-gated, so it is
PR-safe against issue #15.
