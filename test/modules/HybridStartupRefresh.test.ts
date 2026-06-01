// Fork: robust-startup
// Tests for StartupRefresh.planHybridRefresh — the pure decision logic that drives
// background.ts's startup favicon refresh. Verifies that under hybrid+activeWindow
// only the focused window's parked+faviconless tabs are eager-reloaded and the rest
// are deferred (added to pendingFaviconRefresh), and that with the feature OFF every
// parked+faviconless tab is eager (back-compat with the original unconditional reload).
import { jest } from '@jest/globals';

const PARK = 'chrome-extension://test/park.html';

let StartupRefresh: any;

beforeAll(() => {
  const mod = require('../../modules/StartupRefresh');
  StartupRefresh = mod.StartupRefresh;
});

// Helper: a parked tab with optional favicon, in a given window.
function parked(id: number, windowId: number, favIconUrl: string | null = '') {
  return { id, windowId, url: `${PARK}?url=https%3A%2F%2Fexample.com%2F${id}`, favIconUrl };
}
// Helper: a non-parked normal tab.
function normal(id: number, windowId: number) {
  return { id, windowId, url: `https://example.com/${id}`, favIconUrl: 'https://example.com/favicon.ico' };
}

describe('StartupRefresh.planHybridRefresh', () => {

  it('hybrid + activeWindow: only focused-window parked faviconless tabs are eager; others deferred', () => {
    const focusedWindowId = 1;
    const tabs = [
      parked(10, 1, ''),      // focused, faviconless -> eager
      parked(11, 1, null),    // focused, faviconless (null) -> eager
      parked(20, 2, ''),      // background -> deferred
      parked(21, 2, ''),      // background -> deferred
      parked(30, 1, 'https://x/fav.ico'), // focused but HAS favicon -> skipped
      normal(40, 1),          // not parked -> skipped
      normal(41, 2),          // not parked -> skipped
    ];

    const plan = StartupRefresh.planHybridRefresh(tabs, {
      hybrid: true, scope: 'activeWindow', parkUrl: PARK, focusedWindowId
    });

    expect(plan.eager.sort()).toEqual([10, 11]);
    expect(plan.deferred.sort()).toEqual([20, 21]);
  });

  it('feature OFF: every parked faviconless tab is eager (back-compat), none deferred', () => {
    const tabs = [
      parked(10, 1, ''),
      parked(20, 2, ''),
      parked(21, 3, null),
      parked(30, 2, 'https://x/fav.ico'), // has favicon -> still skipped
      normal(40, 1),
    ];

    const plan = StartupRefresh.planHybridRefresh(tabs, {
      hybrid: false, scope: 'activeWindow', parkUrl: PARK, focusedWindowId: 1
    });

    expect(plan.eager.sort()).toEqual([10, 20, 21]);
    expect(plan.deferred).toEqual([]);
  });

  it('scope=all: every parked faviconless tab is eager regardless of window, none deferred', () => {
    const tabs = [
      parked(10, 1, ''),
      parked(20, 2, ''),
      parked(30, 3, ''),
    ];

    const plan = StartupRefresh.planHybridRefresh(tabs, {
      hybrid: true, scope: 'all', parkUrl: PARK, focusedWindowId: 1
    });

    expect(plan.eager.sort()).toEqual([10, 20, 30]);
    expect(plan.deferred).toEqual([]);
  });

  it('isParkedFaviconless: parked + empty/null favicon true; parked + favicon false; non-parked false', () => {
    expect(StartupRefresh.isParkedFaviconless(parked(1, 1, ''), PARK)).toBe(true);
    expect(StartupRefresh.isParkedFaviconless(parked(1, 1, null), PARK)).toBe(true);
    expect(StartupRefresh.isParkedFaviconless(parked(1, 1, undefined), PARK)).toBe(true);
    expect(StartupRefresh.isParkedFaviconless(parked(1, 1, 'https://x/fav.ico'), PARK)).toBe(false);
    expect(StartupRefresh.isParkedFaviconless(normal(1, 1), PARK)).toBe(false);
  });
});

// ── Eager reload + deferred recording wiring (background.ts applies the plan) ──
// This documents the side-effect contract: plan.eager -> chrome.tabs.reload,
// plan.deferred -> pendingFaviconRefresh.add. The active focused tab (excluded by
// {active:false}) is reloaded by a separate {active:true} query in background.ts.
describe('plan application contract (eager reload + deferred set)', () => {
  it('applying the plan reloads eager ids and records deferred ids', () => {
    const reload = jest.fn();
    const pending = new Set<number>();
    const focusedWindowId = 1;

    const tabs = [
      parked(10, 1, ''),  // eager
      parked(20, 2, ''),  // deferred
      parked(21, 2, ''),  // deferred
    ];

    const plan = StartupRefresh.planHybridRefresh(tabs, {
      hybrid: true, scope: 'activeWindow', parkUrl: PARK, focusedWindowId
    });

    // mirror background.ts application
    for (const id of plan.eager) reload(id);
    for (const id of plan.deferred) pending.add(id);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(10);
    expect([...pending].sort()).toEqual([20, 21]);
  });

  it('the active focused parked faviconless tab is eagerly reloaded (active:true sweep)', () => {
    // active:false query excludes the active tab; background.ts runs a follow-up
    // {active:true, windowId:focused} query and reloads it if parked+faviconless.
    const reload = jest.fn();
    const pending = new Set<number>([99]);
    const activeTab = parked(99, 1, '');

    // mirror background.ts active-tab sweep
    if (StartupRefresh.isParkedFaviconless(activeTab, PARK)) {
      reload(activeTab.id);
      pending.delete(activeTab.id);
    }

    expect(reload).toHaveBeenCalledWith(99);
    expect(pending.has(99)).toBe(false);
  });
});
