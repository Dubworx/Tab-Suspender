# Loading the fork + migrating your parked tabs (Brave)

Your fork is built and committed. These are the steps **you** run, on your own
timing. **None of steps 1–5 require quitting/restarting Brave.** Only the final
cold-start test (step 6) involves a normal Brave restart, which is your call.

Pinned fork extension ID: **`fanmnccbignnlcdfaapeceneedcoiadk`**
Old (Web Store) ID being migrated from: `fiabciakcmgepblmdkmemdbbkilneeeh`

## 0. (already done) Build
```
cd ~/dev/Tab-Suspender && npm run build      # -> build_dir/
```

## 1. Safety net (already captured, no action needed)
Full backup of all 1,001 parked + ~3,994 other tab URLs:
`~/Documents/claude-research/brave-tab-suspender/brave_tabs_backup_*.html`
(re-run anytime: `python3 ~/Documents/claude-research/brave-tab-suspender/backup_brave_tabs.py`)

## 2. Load the fork (no restart)
1. Open **`brave://extensions`**
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** → select **`/Users/dubworx/dev/Tab-Suspender/build_dir`**
4. Confirm the card shows **Tab Suspender 2.0.13-fork.1** with ID
   `fanmnccbignnlcdfaapeceneedcoiadk`.

Loading fires `onInstalled` → the one-time migration runs automatically.

## 3. Verify the migration worked
- Click a few of your **parked tabs**: their address bar should now read
  `chrome-extension://fanmnccbignnlcdfaapeceneedcoiadk/park.html?…` and they
  should still be **suspended** (NOT navigated to the live site).
- Optional: open the fork's service worker console
  (`brave://extensions` → fork card → **service worker** → Inspect) and confirm
  `chrome.storage.local` has `parkedTabIdMigrationDone: true` once all foreign
  park tabs are converted. If you have *thousands*, migration is throttled and
  may take a couple of minutes; it resumes on restart if interrupted.

## 4. Disable the old Web Store extension (do NOT remove yet)
Only **after** step 3 looks right: toggle the original **Tab Suspender**
(`fiab…`) **off** in `brave://extensions`. Keep it installed-but-disabled as a
rollback until you're satisfied (a week or so).

## 5. (optional) Tune behavior
Fork → **Details → Extension options → Startup**:
- *Lazily refresh suspended-tab favicons on startup* (on)
- *Eager favicon refresh scope*: **Active window only** (recommended) vs All windows (legacy)
- *Lazy refresh batch size* (default 3)
- *Use persistent offscreen keep-alive port* (off; heartbeat already keeps the worker alive)

## 6. The real test — your next normal Brave restart
When you next quit + reopen Brave (your timing): only the **focused window's**
parked tabs refresh eagerly; the rest backfill gradually in the background. The
service worker should come up **without the crash/restart thrash**. Activating a
background parked tab refreshes just that one. Tip: keep the SW console open
during the first reboot to confirm it stays alive.

## Rollback (if anything looks wrong)
Re-enable the Web Store Tab Suspender, remove the unpacked fork. Your tabs and
the backup are unaffected.
