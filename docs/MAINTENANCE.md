# Tab Suspender — Dubworx fork: maintenance & state of the world

_Last updated: 2026-06-01_

This is a **personal fork** of `sergey-drpa/Tab-Suspender` (MIT) that fixes a cold-start
failure on very large parked-tab sessions (~1,000 tabs). Read this before touching it.

## Identity
- **Repo:** `github.com/Dubworx/Tab-Suspender`, branch **`fork/robust-startup`**.
- **Local:** `~/dev/Tab-Suspender` (build output in `build_dir/`, loaded unpacked in Brave).
- **Pinned extension ID:** `fanmnccbignnlcdfaapeceneedcoiadk` (via `manifest.json` `"key"`).
  Private key (NOT in repo): `~/.config/tab-suspender-fork/key.pem`.
- **Version:** `2.0.13` + `version_name: "2.0.13-fork.1"`. (Chrome requires `version` to be
  numeric 1–4 dot ints — labels go in `version_name`. A build gate enforces this; see below.)
- **Old Web Store ID being migrated FROM:** `fiabciakcmgepblmdkmemdbbkilneeeh`.

## What the fork changes (vs upstream 2.0.12)
All flag-gated; defaults TRUE on this branch (a future upstream PR branch would default FALSE).
1. **Hybrid startup favicon refresh** — eager-reload parked/faviconless tabs only in the
   *focused* window; defer the rest (lazy, on `tabs.onActivated`). Kills the original startup
   reload-storm. Logic in `modules/StartupRefresh.ts` (`planHybridRefresh`).
2. **Offscreen-paced backfill + keep-alive** — offscreen doc paces deferred favicon reloads;
   the existing 20s `sendMessage` heartbeat remains the keep-alive of record.
3. **LAZY parked-tab id migration** — re-point a tab from a FOREIGN park id (e.g. old store id)
   to ours **only when the user activates it** (TabManager `onActivated`). One awake tab at a
   time. Query VERBATIM preserved → tab stays SUSPENDED.

## ⛔ Do NOT (these caused real Brave crashes / are proven unsafe)
- **Do NOT add a BULK migration** that re-points many parked tabs via `chrome.tabs.update`.
  Re-pointing a parked tab WAKES its renderer; doing ~1,000 exhausts Brave's process budget →
  "Can't open this page, Error code 5". Throttling the RATE does **not** bound the LIVE count.
  A "gentle" batched+discard version was built, adversarially reviewed (3/3: can still crash —
  `discard` is fire-and-forget/unreliable under load; already-discarded dormant tabs get woken;
  per-window active tabs accumulate), and **reverted**. Migration must stay LAZY.
- **Do NOT reload the OLD store extension** (`fiab…`) to get its disable toggle — reloading
  restarts its unfixed worker, which storm-reloads its parked tabs.
- **Do NOT restart Brave while the OLD extension is still enabled AND tabs are split** — on
  restart the old extension storm-reloads its remaining parked half.

## Build & load
```
cd ~/dev/Tab-Suspender
npm install                 # once (Node 18+; works on 25)
npm run build               # tsc + copy + MANIFEST VALIDATOR gate -> build_dir/
npm test                    # NOTE: use `npx jest` (worker-isolated). `npm test` (--runInBand)
                            # shows ~192 SPURIOUS failures from a PRE-EXISTING cross-suite
                            # global-state leak that reproduces on pristine upstream master.
```
- **Manifest validator gate:** `scripts/validate-manifest.mjs` runs at the end of `npm run build`
  and fails the build if the manifest wouldn't load (version format, referenced files exist,
  `__MSG__` locale keys, CSP, base64 key). Reuse it for any extension work.
- **Load:** `brave://extensions` → Developer mode → Load unpacked → `build_dir/`.
  To pick up code changes without a Brave restart: click **Reload** on the fork's card.

## Current state (2026-06-01) & how it converges
- Split: ~half the parked tabs are on the fork ID (`fanmnccbig…`, served by this fork), ~half
  still on the old ID (`fiab…`, served by the still-installed Web Store extension). All suspended.
- **Convergence:** as tabs are activated, the lazy migration re-points old→fork, one at a time.
- **To make a Brave restart safe:** REMOVE the old store extension first (you can't disable it —
  it shows "Reload" instead of a toggle because its worker is dead). Its unvisited tabs become
  dead pages that **self-heal on click** (lazy migration re-points them). This removes the
  old-extension restart-storm risk.

## Settings (fork-added; `modules/Settings.ts` + Startup options page)
`hybridStartupFaviconRefresh` (bool), `startupEagerScope` ('activeWindow'|'all'),
`lazyFaviconRefreshConcurrency` (num), `lazyRefreshDelayMs` (num),
`useOffscreenKeepAlivePort` (bool, default false), `enableParkedTabIdMigration` (bool),
`parkedTabMigrationLegacyIds` (comma/newline string; seeded with the store id).

## Rollback
Original Web Store extension stays installed as one-click rollback. Full tab backup +
re-runnable extractor: `~/Documents/claude-research/brave-tab-suspender/`.

## Design / history
- `docs/plans/2026-06-01-robust-startup-design.md` — design.
- `docs/LOAD_AND_MIGRATE.md` — load/migration walkthrough.
- claude-mem: #117103 (root cause), #117136 (build), #117153 (verify-against-runtime lesson),
  #117193 (bulk-migration-is-unsafe lesson).
